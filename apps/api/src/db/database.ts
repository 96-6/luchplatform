import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import lockfile from 'proper-lockfile';
import { projectRoot, type Settings } from '../config.js';

export interface QueryExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}
export interface Database extends QueryExecutor {
  kind: 'embedded' | 'postgres';
  transaction<T>(work: (transaction: QueryExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function lockEmbeddedDirectory(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  try {
    // Heartbeats also work when separate containers use different PID namespaces.
    return await lockfile.lock(directory, {
      stale: 10000,
      update: 2000,
      // Sequential setup commands may see the previous process's lock briefly.
      // Retry through its stale window; a live writer keeps refreshing its lock.
      retries: { retries: 24, factor: 1, minTimeout: 500, maxTimeout: 500 },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
    throw new Error(
      'Local database is already in use. Stop the API before running database commands, then retry.',
    );
  }
}

export async function createDatabase(
  settings: Pick<Settings, 'DATABASE_URL' | 'DATABASE_SSL'>,
): Promise<Database> {
  if (settings.DATABASE_URL.startsWith('pglite:')) {
    const location = settings.DATABASE_URL.slice(7);
    const inMemory = location === 'memory';
    const directory = resolve(projectRoot, location);
    const release = inMemory ? async () => {} : await lockEmbeddedDirectory(directory);
    let engine: PGlite;
    try {
      engine = await PGlite.create(inMemory ? 'memory://' : directory);
    } catch (error) {
      await release();
      throw error;
    }
    return {
      kind: 'embedded',
      query: (sql, params = []) => engine.query(sql, params),
      exec: async (sql) => {
        await engine.exec(sql);
      },
      transaction: (work) =>
        engine.transaction((tx) =>
          work({
            query: (sql, params = []) => tx.query(sql, params),
            exec: async (sql) => {
              await tx.exec(sql);
            },
          }),
        ),
      close: async () => {
        try {
          await engine.close();
        } finally {
          await release();
        }
      },
    };
  }
  const pool = new pg.Pool({
    connectionString: settings.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 10000,
    ssl: settings.DATABASE_SSL ? { rejectUnauthorized: true } : false,
  });
  // An idle connection failure must not crash Node. Readiness and API errors report outages.
  pool.on('error', () => {
    console.error('PostgreSQL idle connection failed; check database availability.');
  });
  return {
    kind: 'postgres',
    query: (sql, params = []) => pool.query(sql, params),
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (work) => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const result = await work({
          query: (sql, params = []) => connection.query(sql, params),
          exec: async (sql) => {
            await connection.query(sql);
          },
        });
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
    close: () => pool.end(),
  };
}
