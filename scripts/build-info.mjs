import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export const repository = '96-6/luchplatform';
export const fingerprintEntries = (entries) =>
  createHash('sha256')
    .update(
      entries
        .filter((e) => e.path !== 'source-version.json' && e.type !== 'tree')
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((e) => `${e.path}\0${e.sha}\n`)
        .join(''),
    )
    .digest('hex');
const ignored = (p) =>
  p === 'build-info.json' ||
  p === 'source-version.json' ||
  p
    .split('/')
    .some((v) =>
      [
        '.git',
        'node_modules',
        'dist',
        'data',
        'coverage',
        'test-results',
        'playwright-report',
        '.vite',
      ].includes(v),
    ) ||
  /(?:\.log|\.tsbuildinfo)$/.test(p) ||
  /(?:^|\/)\.DS_Store$/.test(p) ||
  (/(?:^|\/)\.env(?:\.|$)/.test(p) && !['.env.example', '.env.compose.example'].includes(p));
async function walk(root, dir = root) {
  const files = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, e.name),
      name = relative(root, path).replaceAll('\\', '/');
    if (ignored(name)) continue;
    if (e.isDirectory()) files.push(...(await walk(root, path)));
    else if (e.isFile()) files.push(name);
  }
  return files;
}
export async function inspectSource(root) {
  let files,
    commit = null,
    modified = false;
  try {
    if (
      resolve(
        (await execute('git', ['-C', root, 'rev-parse', '--show-toplevel'])).stdout.trim(),
      ) !== resolve(root)
    )
      throw Error('Outside source checkout');
    commit = (
      await execute('git', ['-C', root, 'rev-parse', 'HEAD'], { maxBuffer: 1024 })
    ).stdout.trim();
    files = (
      await execute(
        'git',
        ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { maxBuffer: 4 * 1024 * 1024 },
      )
    ).stdout
      .split('\0')
      .filter((p) => p && !ignored(p));
    try {
      await execute('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--']);
    } catch {
      modified = true;
    }
    const untracked = (
      await execute('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], {
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout
      .split('\0')
      .filter((p) => p && !ignored(p));
    modified ||= untracked.length > 0;
  } catch {
    commit = null;
    modified = false;
    files = await walk(root);
    try {
      const v = JSON.parse(await readFile(resolve(root, 'source-version.json'), 'utf8'));
      if (/^[a-f0-9]{40}$/.test(v.commit)) commit = v.commit;
    } catch {}
  }
  const entries = [];
  for (const path of files) {
    const metadata = await lstat(resolve(root, path)).catch(() => null);
    if (!metadata) {
      modified = true;
      continue;
    }
    if (!metadata.isFile()) continue;
    const bytes = await readFile(resolve(root, path));
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    entries.push({ path, sha });
  }
  return {
    commit: /^[a-f0-9]{40}$/.test(commit ?? '') ? commit : null,
    fingerprint: fingerprintEntries(entries),
    modified,
  };
}
export async function writeBuildInfo(root) {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const info = {
    version: pkg.version,
    ...(await inspectSource(root)),
    builtAt: new Date().toISOString(),
    kind: 'build',
  };
  await writeFile(resolve(root, 'build-info.json'), JSON.stringify(info) + '\n');
  return info;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await writeBuildInfo(fileURLToPath(new URL('../', import.meta.url)));
