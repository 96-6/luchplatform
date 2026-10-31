import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProbeSchema, envelopeSchema, probesSchema, probeSchema } from '@luch/contracts';
import { buildApp } from '../src/app.js';
import { parseSettings } from '../src/config.js';
import { createDatabase, type Database } from '../src/db/database.js';
import { assertSchemaCurrent, migrate } from '../src/db/migrations.js';

const settings = parseSettings({
  APP_ENV: 'test',
  AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'pglite:memory',
  ENABLE_DEV_TOOLS: 'true',
  LOG_LEVEL: 'silent',
});
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  database = await createDatabase(settings);
  await migrate(database);
  // TEST_DATABASE_URL must point to an isolated test database. No user database is used.
  await database.exec('TRUNCATE system_probes');
  app = await buildApp(settings, database);
});
afterAll(async () => {
  await app?.close();
});

describe('foundation API and database', () => {
  it('applies migrations once and validates the migration history', async () => {
    expect(await migrate(database)).toEqual([]);
    await assertSchemaCurrent(database);
    const result = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_migrations',
    );
    expect(result.rows[0]?.count).toBe('24');
  });
  it('reports live and ready states with a request identifier', async () => {
    for (const endpoint of ['live', 'ready']) {
      const response = await app.inject({ url: `/api/v1/health/${endpoint}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.status).toBe('ok');
      expect(response.headers['x-request-id']).toBe(response.json().requestId);
    }
  });
  it('starts with an empty record list', async () => {
    const response = await app.inject({ url: '/api/v1/dev/records' });
    expect(envelopeSchema(probesSchema).parse(response.json()).data).toEqual([]);
  });
  it('saves a parameterized record and returns it from the database', async () => {
    const input = createProbeSchema.parse({
      label: "Русский и English — O'Brien",
      operationId: randomUUID(),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/dev/records',
      payload: input,
    });
    expect(response.statusCode).toBe(201);
    const saved = envelopeSchema(probeSchema).parse(response.json()).data;
    const stored = await database.query<{ label: string }>(
      'SELECT label FROM system_probes WHERE id = $1',
      [saved.id],
    );
    expect(stored.rows[0]?.label).toBe(input.label);
  });
  it('does not duplicate repeated or concurrent deliveries and rejects a changed payload', async () => {
    const input = { label: 'One operation', operationId: randomUUID() };
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.inject({ method: 'POST', url: '/api/v1/dev/records', payload: input }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(3);
    expect(new Set(responses.map((response) => response.json().data.id)).size).toBe(1);
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/dev/records',
      payload: { ...input, label: 'Changed' },
    });
    expect(conflict.statusCode).toBe(409);
    const count = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM system_probes WHERE operation_id = $1',
      [input.operationId],
    );
    expect(count.rows[0]?.count).toBe('1');
  });
  it.each([
    { label: ' ', operationId: randomUUID() },
    { label: 'x'.repeat(121), operationId: randomUUID() },
    { label: 'Valid', operationId: 'invalid' },
    { label: 'Valid', operationId: randomUUID(), correctAnswer: 'forged' },
  ])('rejects invalid input %#', async (payload) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/dev/records', payload });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
  it('blocks writes from an unapproved browser origin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/dev/records',
      headers: { origin: 'https://unrelated.example' },
      payload: { label: 'Blocked', operationId: randomUUID() },
    });
    expect(response.statusCode).toBe(403);
  });
  it('rolls back incomplete transactions', async () => {
    const operation = randomUUID();
    await expect(
      database.transaction(async (tx) => {
        await tx.query('INSERT INTO system_probes (id, operation_id, label) VALUES ($1, $2, $3)', [
          randomUUID(),
          operation,
          'Rollback',
        ]);
        throw new Error('Deliberate failure');
      }),
    ).rejects.toThrow('Deliberate failure');
    const rows = await database.query('SELECT id FROM system_probes WHERE operation_id = $1', [
      operation,
    ]);
    expect(rows.rows).toEqual([]);
  });
  it('refuses a modified migration and preserves the original history', async () => {
    const previous = await database.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const row = previous.rows[0]!;
    try {
      await database.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
        '0'.repeat(64),
        row.version,
      ]);
      await expect(migrate(database)).rejects.toThrow('Migration history mismatch');
    } finally {
      await database.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [
        row.checksum,
        row.version,
      ]);
    }
  });
  it('does not register development routes when tools are disabled', async () => {
    const disabled = await buildApp(
      parseSettings({
        APP_ENV: 'test',
        AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        DATABASE_URL: 'pglite:memory',
        LOG_LEVEL: 'silent',
      }),
      { ...database, close: async () => {} },
    );
    try {
      expect((await disabled.inject({ url: '/api/v1/dev/records' })).statusCode).toBe(404);
      expect(
        (
          await disabled.inject({
            method: 'POST',
            url: '/api/v1/dev/records',
            payload: { label: 'Forbidden', operationId: randomUUID() },
          })
        ).statusCode,
      ).toBe(404);
      expect((await disabled.inject({ url: '/api/v1/system' })).json().data.devToolsEnabled).toBe(
        false,
      );
    } finally {
      await disabled.close();
    }
  });
  it('returns a recoverable error without database credentials on an outage', async () => {
    const unavailable = await buildApp(settings, {
      ...database,
      query: async () => {
        throw new Error('postgresql://private:secret@db');
      },
      close: async () => {},
    });
    try {
      const ready = await unavailable.inject({ url: '/api/v1/health/ready' });
      expect(ready.statusCode).toBe(503);
      const save = await unavailable.inject({
        method: 'POST',
        url: '/api/v1/dev/records',
        payload: { label: 'Retry', operationId: randomUUID() },
      });
      expect(save.statusCode).toBe(503);
      expect(save.body).not.toContain('private');
      expect(save.body).not.toContain('secret');
    } finally {
      await unavailable.close();
    }
  });
  it('reports a missing schema rather than pretending the database is ready', async () => {
    const blank = await createDatabase({ DATABASE_URL: 'pglite:memory', DATABASE_SSL: false });
    const uninitialized = await buildApp(settings, blank);
    try {
      expect((await uninitialized.inject({ url: '/api/v1/health/live' })).statusCode).toBe(200);
      expect((await uninitialized.inject({ url: '/api/v1/health/ready' })).statusCode).toBe(503);
    } finally {
      await uninitialized.close();
    }
  });
  it('preserves records across restart, rejects a live writer and recovers an orphan lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'luch-persistence-'));
    const fileSettings = parseSettings({
      APP_ENV: 'test',
      AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      DATABASE_URL: `pglite:${directory}/database`,
      ENABLE_DEV_TOOLS: 'true',
      LOG_LEVEL: 'silent',
    });
    const firstDatabase = await createDatabase(fileSettings);
    await migrate(firstDatabase);
    const firstApp = await buildApp(fileSettings, firstDatabase);
    const input = { label: 'Persist across restart', operationId: randomUUID() };
    const saved = await firstApp.inject({
      method: 'POST',
      url: '/api/v1/dev/records',
      payload: input,
    });
    await expect(createDatabase(fileSettings)).rejects.toThrow('already in use');
    await firstApp.close();
    // A terminated setup process can leave a fresh lock without a heartbeat.
    const orphan = `${directory}/database.lock`;
    await mkdir(orphan, { recursive: true });
    await utimes(orphan, new Date(), new Date());
    const secondDatabase = await createDatabase(fileSettings);
    const secondApp = await buildApp(fileSettings, secondDatabase);
    try {
      const records = await secondApp.inject({ url: '/api/v1/dev/records' });
      expect(records.json().data).toEqual([saved.json().data]);
      expect(await migrate(secondDatabase)).toEqual([]);
    } finally {
      await secondApp.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
