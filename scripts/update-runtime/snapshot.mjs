import { cp, mkdir, stat, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { atomic, json, environment } from './shared.mjs';
import { command, trackChild } from './commands.mjs';

export class DatabaseSnapshot {
  constructor(config, directory, log = () => {}) {
    this.config = config;
    this.directory = directory;
    this.log = log;
    this.env = environment(config);
    this.embedded = this.env.DATABASE_URL?.startsWith('pglite:');
  }
  async prepare() {
    if (!this.env.DATABASE_URL || this.env.DATABASE_URL === 'pglite:memory')
      throw Error('Persistent database is required');
    if (this.embedded) {
      this.databaseDirectory = this.env.DATABASE_URL.slice(7);
      await stat(this.databaseDirectory);
      return;
    }
    const u = new URL(this.env.DATABASE_URL);
    this.pgEnv = {
      ...this.env,
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGCONNECT_TIMEOUT: '10',
      PGSSLMODE: this.env.DATABASE_SSL === 'true' ? 'verify-full' : 'disable',
      ...(this.env.DATABASE_SSL === 'true'
        ? { PGSSLROOTCERT: this.env.PGSSLROOTCERT || 'system' }
        : {}),
    };
    const require = createRequire(resolve(this.config.initialRoot, 'package.json'));
    const { Client } = require('pg');
    const client = new Client({
      connectionString: this.env.DATABASE_URL,
      ssl: this.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
    });
    await client.connect();
    try {
      const namespaces = (
        await client.query(
          "SELECT nspname,pg_has_role(current_user,nspowner,'USAGE') AS owned FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'",
        )
      ).rows;
      if (namespaces.some((n) => n.nspname !== 'public' || !n.owned))
        throw Error('A dedicated owned database is required for recovery');
      const version = Number(
        (await client.query('SHOW server_version_num')).rows[0].server_version_num,
      );
      const output = await command('pg_dump', ['--version'], {
        env: this.pgEnv,
        capture: true,
        quiet: true,
        timeoutMs: 10000,
      });
      const major = Number(/(\d+)(?:\.\d+)?/.exec(output)?.[1]);
      if (!major || major < Math.floor(version / 10000))
        throw Error('Compatible PostgreSQL backup tools are required');
      await command('pg_restore', ['--version'], {
        env: this.pgEnv,
        quiet: true,
        timeoutMs: 10000,
      });
      await command('psql', ['--version'], { env: this.pgEnv, quiet: true, timeoutMs: 10000 });
    } finally {
      await client.end();
    }
  }
  async backup() {
    await rm(this.directory, { recursive: true, force: true });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.embedded) {
      await cp(this.databaseDirectory, resolve(this.directory, 'database'), {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
      });
    } else {
      await command(
        'pg_dump',
        [
          '--format=custom',
          '--no-owner',
          '--no-acl',
          '--file',
          resolve(this.directory, 'database.dump'),
        ],
        { env: this.pgEnv, quiet: true, timeoutMs: 30 * 60 * 1000 },
      );
      if (!(await stat(resolve(this.directory, 'database.dump'))).size)
        throw Error('Database backup is empty');
    }
    await atomic(resolve(this.directory, 'complete.json'), {
      driver: this.embedded ? 'embedded' : 'postgres',
      completedAt: new Date().toISOString(),
    });
    this.log('Резервная копия базы сохранена.');
  }
  async restore() {
    const complete = await json(resolve(this.directory, 'complete.json'));
    if (!complete) throw Error('Complete database backup is missing');
    if (this.embedded) {
      const temporary = this.databaseDirectory + '.restore';
      await rm(temporary, { recursive: true, force: true });
      await cp(resolve(this.directory, 'database'), temporary, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
      });
      const failed = this.databaseDirectory + '.failed-' + Date.now();
      let moved = false;
      try {
        await rename(this.databaseDirectory, failed);
        moved = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        await rename(temporary, this.databaseDirectory);
      } catch (error) {
        if (moved) await rename(failed, this.databaseDirectory);
        throw error;
      }
      if (moved) await rm(failed, { recursive: true, force: true });
    } else {
      const archive = resolve(this.directory, 'database.dump');
      const listing = await command('pg_restore', ['--list', archive], {
        env: this.pgEnv,
        capture: true,
        quiet: true,
      });
      const filtered = listing
        .split('\n')
        .filter((line) => !/^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+public\s/.test(line))
        .join('\n');
      const list = resolve(this.directory, 'restore.list');
      await writeFile(list, filtered, { mode: 0o600 });
      await new Promise((resolvePromise, reject) => {
        const restore = trackChild(
          spawn('pg_restore', ['--no-owner', '--no-acl', '--use-list', list, '--file=-', archive], {
            env: this.pgEnv,
            stdio: ['ignore', 'pipe', 'ignore'],
            shell: false,
            detached: true,
          }),
        );
        const psql = trackChild(
          spawn(
            'psql',
            ['-X', '--no-password', '--set=ON_ERROR_STOP=1', '--single-transaction', '--file=-'],
            {
              env: this.pgEnv,
              stdio: ['pipe', 'ignore', 'ignore'],
              shell: false,
              detached: true,
            },
          ),
        );
        let restoreCode = null,
          psqlCode = null,
          finished = false;
        const timer = setTimeout(() => finish(Error('Database restore timed out')), 30 * 60 * 1000);
        function finish(error) {
          if (finished) return;
          if (!error && (restoreCode === null || psqlCode === null)) return;
          finished = true;
          clearTimeout(timer);
          if (error) {
            restore.kill('SIGKILL');
            psql.kill('SIGKILL');
            reject(error);
          } else resolvePromise();
        }
        psql.stdin.on('error', () => finish(Error('Database restore failed')));
        psql.stdin.write('DROP SCHEMA public CASCADE;\nCREATE SCHEMA public;\n');
        // EOF must not commit a partial SQL stream when pg_restore itself fails.
        restore.stdout.pipe(psql.stdin, { end: false });
        restore.stdout.once('error', () => finish(Error('Database restore failed')));
        restore.once('error', () => finish(Error('Database restore tool unavailable')));
        psql.once('error', () => finish(Error('Database restore tool unavailable')));
        restore.once('close', (code) => {
          restoreCode = code === 0 ? 0 : -1;
          if (code === 0 && !finished) psql.stdin.end();
          finish(code === 0 ? null : Error('Database restore failed'));
        });
        psql.once('exit', (code) => {
          psqlCode = code === 0 ? 0 : -1;
          finish(code === 0 ? null : Error('Database restore failed'));
        });
      });
    }
    this.log('База восстановлена из резервной копии.');
  }
}
