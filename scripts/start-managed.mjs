import { mkdir, cp, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { atomic, json, environment } from './update-runtime/shared.mjs';
import { command } from './update-runtime/commands.mjs';

process.umask(0o077);
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
let envFile = resolve(root, '.env');
try {
  process.loadEnvFile(envFile);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  envFile = null;
}
const runtime = resolve(
  process.env.LUCH_RUNTIME_DIRECTORY || resolve(dirname(root), 'luch-runtime'),
);
if (runtime === root || runtime.startsWith(root + '/'))
  throw Error('LUCH_RUNTIME_DIRECTORY must be outside the source directory');
const filename = resolve(runtime, 'config.json');
let config = await json(filename);
if (!config) {
  const origin = new URL(process.env.APP_URL || 'http://localhost:5173');
  const developmentPort =
    origin.protocol === 'http:' && process.env.SERVE_WEB !== 'true'
      ? Number(origin.port || 80)
      : Number(process.env.API_PORT || 3000);
  config = {
    protocol: 1,
    mode: 'node',
    initialRoot: root,
    dataDir: resolve(root, 'data'),
    stateDir: resolve(runtime, 'state'),
    releasesDir: resolve(runtime, 'releases'),
    backupsDir: resolve(runtime, 'backups'),
    envFile,
    listenHost: process.env.API_HOST || '127.0.0.1',
    listenPort: developmentPort,
  };
  // Check the public listener before opening a file database for the initial migration.
  const probe = net.createServer();
  probe.listen(config.listenPort, config.listenHost);
  await once(probe, 'listening');
  await new Promise((r) => probe.close(r));
  try {
    await access(resolve(root, 'build-info.json'));
  } catch {
    await command('npm', ['run', 'build'], { cwd: root, log: console.log });
  }
  await command(process.execPath, ['apps/api/dist/db/cli.js', 'migrate'], {
    cwd: root,
    env: environment(config),
    log: console.log,
  });
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await cp(resolve(root, 'scripts/update-runtime'), resolve(runtime, 'bootstrap'), {
    recursive: true,
  });
  await atomic(filename, config);
}
const child = fork(resolve(runtime, 'bootstrap/supervisor.mjs'), [filename], {
  cwd: config.initialRoot,
  env: environment(config),
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => process.exit(code ?? 1));
