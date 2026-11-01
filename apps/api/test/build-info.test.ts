import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const modulePath = new URL('../../../scripts/build-info.mjs', import.meta.url).href;
it('identifies the same source from Git, an exported archive and a frozen build stamp', async () => {
  const { inspectSource, writeBuildInfo, fingerprintEntries } = await import(modulePath);
  const directory = await mkdtemp(resolve(tmpdir(), 'luch-build-info-')),
    source = resolve(directory, 'source'),
    archive = resolve(directory, 'archive');
  try {
    await mkdir(source);
    await mkdir(archive);
    for (const [name, value] of Object.entries({
      'package.json': '{"version":"0.1.0"}',
      '.gitattributes': 'source-version.json export-subst\n',
      'source-version.json': '{"commit":"$Format:%H$"}',
      '.gitignore': 'build-info.json\n.env\n',
      '.env.example': 'DATABASE_URL=pglite:./data/luch\n',
      'README.md': 'Fixture\n',
    }))
      await writeFile(resolve(source, name), value);
    await run('git', ['init', '-b', 'main', source]);
    await run('git', ['-C', source, 'add', '.']);
    await run('git', [
      '-C',
      source,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Fixture',
    ]);
    const git = await inspectSource(source);
    expect(git.modified).toBe(false);
    await run('git', [
      '-C',
      source,
      'archive',
      '--format=tar',
      '--output=' + resolve(directory, 'source.tar'),
      'HEAD',
    ]);
    await run('tar', ['-xf', resolve(directory, 'source.tar'), '-C', archive]);
    expect(await inspectSource(archive)).toEqual(git);
    const tree = (
      await run('git', ['-C', source, 'ls-tree', '-r', '--format=%(objectname) %(path)', 'HEAD'])
    ).stdout
      .trim()
      .split('\n')
      .map((line) => ({ sha: line.slice(0, 40), path: line.slice(41), type: 'blob' }));
    expect(fingerprintEntries(tree)).toBe(git.fingerprint);
    const built = await writeBuildInfo(source);
    await writeFile(resolve(source, 'README.md'), 'Changed after build\n');
    expect(JSON.parse(await readFile(resolve(source, 'build-info.json'), 'utf8'))).toEqual(built);
    expect((await inspectSource(source)).modified).toBe(true);
    expect((await inspectSource(source)).fingerprint).not.toBe(built.fingerprint);
    // Unrelated parent repositories must not turn an archive into that parent's build.
    await run('git', ['init', directory]);
    expect((await inspectSource(archive)).commit).toBe(git.commit);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('redacts configured credentials and connection userinfo from updater logs', async () => {
  const path = new URL('../../../scripts/update-runtime/commands.mjs', import.meta.url).href;
  const { redactor } = await import(path);
  const clean = redactor({
    DATABASE_URL: 'postgresql://user:fixture-password@localhost/test',
    AUTH_ENCRYPTION_KEY: 'fixture-key',
    PROVIDER_TOKEN: 'fixture-token',
  });
  const message = clean(
    'postgresql://user:fixture-password@localhost/test fixture-key fixture-token',
  );
  expect(message).not.toContain('fixture-password');
  expect(message).not.toContain('fixture-key');
  expect(message).not.toContain('fixture-token');
  expect(clean('x'.repeat(4000))).toHaveLength(1500);
});
