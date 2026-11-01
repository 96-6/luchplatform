import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, readdir, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
export const REPOSITORY = 'https://github.com/96-6/luchplatform.git';
export const sha = (s) => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
export const uuid = (s) =>
  typeof s === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
export const hash = (s) => createHash('sha256').update(s).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const terminal = (phase) => ['completed', 'failed', 'rollback_failed'].includes(phase);
export async function json(path, fallback = null) {
  try {
    if ((await stat(path)).size > 3 * 1024 * 1024) return fallback;
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}
export async function atomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
export async function configuration(filename) {
  const c = await json(filename);
  if (
    !c ||
    c.protocol !== 1 ||
    !['node', 'container'].includes(c.mode) ||
    !['stateDir', 'releasesDir', 'backupsDir', 'initialRoot', 'dataDir'].every(
      (k) => typeof c[k] === 'string' && c[k].startsWith('/'),
    )
  )
    throw Error('Invalid updater configuration');
  if (c.envFile) process.loadEnvFile(c.envFile);
  return c;
}
export function environment(config) {
  const env = {
    DATABASE_URL: 'pglite:./data/luch',
    ...process.env,
    UPDATE_STATE_DIRECTORY: config.stateDir,
    SERVE_WEB: 'true',
    LOCAL_DEBUG_LOGIN: 'false',
  };
  if (env.DATABASE_URL?.startsWith('pglite:') && env.DATABASE_URL !== 'pglite:memory')
    env.DATABASE_URL = 'pglite:' + resolve(config.initialRoot, env.DATABASE_URL.slice(7));
  env.MEETING_FILE_DIRECTORY = resolve(
    config.initialRoot,
    env.MEETING_FILE_DIRECTORY || 'data/meeting-files',
  );
  return env;
}
export function childEnvironment(config, port) {
  const env = environment(config);
  return {
    ...env,
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    TRUST_PROXY_CIDRS: [env.TRUST_PROXY_CIDRS, '127.0.0.1/32', '::1/128'].filter(Boolean).join(','),
  };
}
export function releaseRoot(config, release) {
  if (release === 'initial') return config.initialRoot;
  if (!sha(release)) throw Error('Invalid release identifier');
  return resolve(config.releasesDir, release);
}
export async function deployment(config) {
  return await json(resolve(config.stateDir, 'deployment.json'), {
    protocol: 1,
    current: 'initial',
    action: 'serve',
    jobId: null,
    candidate: null,
  });
}
export async function cleanGrants(config) {
  const dir = resolve(config.stateDir, 'grants');
  for (const name of await readdir(dir).catch(() => []))
    if (/^[a-f0-9]{64}\.json$/.test(name)) {
      const value = await json(resolve(dir, name));
      if (!value || value.expiresAt < Date.now()) await unlink(resolve(dir, name)).catch(() => {});
    }
}
