import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { command } from './update-runtime/commands.mjs';
const root = resolve('data/compose-update-fixture');
if (process.argv.includes('verify')) {
  const request = async () => {
    const response = await fetch('http://127.0.0.1:3000/api/v1/health/ready');
    assert(response.ok);
  };
  await request();
  console.log('Compose application is ready after release-volume restart.');
} else {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const archive = resolve('data/compose-update-fixture.tar');
  await command('git', ['archive', '--format=tar', '--output=' + archive, 'HEAD'], { quiet: true });
  await command('tar', ['-xf', archive, '-C', root], { quiet: true });
  await command('git', ['init', '-b', 'main', root], { quiet: true });
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  pkg.version = '0.1.1';
  await writeFile(resolve(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  lock.version = pkg.version;
  lock.packages[''].version = pkg.version;
  await writeFile(resolve(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  await writeFile(
    resolve(root, 'apps/api/migrations/028_compose_updater_fixture.sql'),
    "CREATE TABLE compose_update_fixture(value text NOT NULL); INSERT INTO compose_update_fixture VALUES('persisted across containers');\n",
  );
  await command('git', ['-C', root, 'add', '.'], { quiet: true });
  await command(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Compose updater acceptance',
    ],
    { quiet: true },
  );
  // The app and agent run as the same unprivileged user in their containers.
  await command('chmod', ['-R', 'a+rX', root], { quiet: true });
  await rm(archive);
  console.log('Local Git main fixture prepared for the real Compose agent.');
}
