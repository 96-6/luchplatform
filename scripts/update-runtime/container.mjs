import { resolve } from 'node:path';
import { fork } from 'node:child_process';
import { atomic, configuration, deployment, releaseRoot, environment } from './shared.mjs';
import { runSupervisor } from './supervisor.mjs';
process.umask(0o077);
const filename = '/updates/config.json';
const config = {
  protocol: 1,
  mode: 'container',
  initialRoot: '/app',
  dataDir: '/app/data',
  stateDir: '/updates',
  releasesDir: '/releases',
  backupsDir: '/updates/backups',
  listenHost: process.env.API_HOST || '0.0.0.0',
  listenPort: Number(process.env.API_PORT || 3000),
};
if (process.argv[2] !== 'worker') {
  await atomic(filename, config);
  config.filename = filename;
  await runSupervisor(config, { startWorker: false });
} else {
  const { sleep } = await import('./shared.mjs');
  let stop = false,
    child;
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      stop = true;
      child?.kill(signal);
    });
  while (!stop) {
    try {
      const c = await configuration(filename),
        d = await deployment(c),
        root = releaseRoot(c, d.current);
      child = fork(resolve(root, 'scripts/update-runtime/worker.mjs'), [filename], {
        cwd: root,
        env: environment(c),
        stdio: 'inherit',
      });
      await new Promise((r) => child.once('exit', r));
      child = null;
    } catch {
      console.error('Update worker is waiting for the application configuration.');
    }
    if (!stop) await sleep(2000);
  }
}
