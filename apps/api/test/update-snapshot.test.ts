import { it, expect } from 'vitest';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from '../src/db/database.js';
it('recovers persistent PostgreSQL data after interruption between the directory swaps', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'luch-snapshot-')),
    location = resolve(directory, 'database'),
    previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'pglite:' + location;
  const options = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_SSL: false };
  let db;
  try {
    db = await createDatabase(options);
    await db.exec(
      "CREATE TABLE recovery_fixture(value text NOT NULL); INSERT INTO recovery_fixture VALUES('preserved through interrupted restore')",
    );
    await db.close();
    db = null;
    const path = new URL('../../../scripts/update-runtime/snapshot.mjs', import.meta.url).href;
    const { DatabaseSnapshot } = await import(path),
      config = { initialRoot: directory, dataDir: directory };
    const original = new DatabaseSnapshot(config, resolve(directory, 'backup'));
    await original.prepare();
    await original.backup();
    await rename(location, location + '.failed-fixture');
    const recovered = new DatabaseSnapshot(config, resolve(directory, 'backup'));
    await expect(recovered.prepare()).rejects.toThrow();
    await recovered.restore();
    db = await createDatabase(options);
    expect((await db.query('SELECT value FROM recovery_fixture')).rows[0]?.value).toBe(
      'preserved through interrupted restore',
    );
  } finally {
    if (db) await db.close();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
