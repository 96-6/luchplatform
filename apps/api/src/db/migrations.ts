import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Database } from './database.js';

const migrationsDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));
async function readMigrations() {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  if (files.length === 0) throw new Error('No migration files found.');
  return Promise.all(
    files.map(async (version) => {
      const sql = await readFile(`${migrationsDirectory}/${version}`, 'utf8');
      return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

export async function migrate(database: Database): Promise<string[]> {
  const migrations = await readMigrations();
  return database.transaction(async (tx) => {
    // PostgreSQL deployments may run the migration command from multiple release jobs.
    if (database.kind === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(74639201)');
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await tx.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    const known = new Map(migrations.map((migration) => [migration.version, migration.checksum]));
    for (const row of applied.rows) {
      if (known.get(row.version) !== row.checksum)
        throw new Error(
          `Migration history mismatch: ${row.version}. Restore the original migration or deploy the matching application version.`,
        );
    }
    const existing = new Set(applied.rows.map((row) => row.version));
    const added: string[] = [];
    for (const migration of migrations) {
      if (existing.has(migration.version)) continue;
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
        migration.version,
        migration.checksum,
      ]);
      added.push(migration.version);
    }
    return added;
  });
}

export async function assertSchemaCurrent(database: Database): Promise<void> {
  const expected = await readMigrations();
  const applied = await database.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  if (
    expected.length !== applied.rows.length ||
    expected.some(
      (migration, i) =>
        migration.version !== applied.rows[i]?.version ||
        migration.checksum !== applied.rows[i]?.checksum,
    )
  ) {
    throw new Error('Database schema is not current. Run the migration command.');
  }
}
