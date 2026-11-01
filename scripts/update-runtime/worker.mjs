import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, rename, symlink, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPOSITORY,
  sha,
  uuid,
  json,
  atomic,
  configuration,
  environment,
  deployment,
  releaseRoot,
  terminal,
  sleep,
  cleanGrants,
} from './shared.mjs';
import { command, buildEnvironment, redactor, abortCommands } from './commands.mjs';
import { DatabaseSnapshot } from './snapshot.mjs';

export class UpdateWorker {
  stop() {
    this.shuttingDown = true;
    abortCommands();
  }
  constructor(config, { gitRemote = REPOSITORY } = {}) {
    if (gitRemote !== REPOSITORY && process.env.APP_ENV !== 'test')
      throw Error('Source override is test-only');
    this.config = config;
    this.gitRemote = gitRemote;
    this.job = null;
    this.sequence = 0;
    this.writes = Promise.resolve();
    this.clean = redactor(environment(config));
  }
  async save() {
    this.writes = this.writes
      .catch(() => {})
      .then(() => atomic(resolve(this.config.stateDir, 'jobs', this.job.id + '.json'), this.job));
    await this.writes;
  }
  log(text) {
    if (!this.job) return;
    this.job.logs.push({
      sequence: ++this.sequence,
      at: new Date().toISOString(),
      text: this.clean(text),
    });
    if (this.job.logs.length > 1500) this.job.logs.splice(0, this.job.logs.length - 1500);
    if (!this.logTimer)
      this.logTimer = setTimeout(() => {
        this.logTimer = null;
        void this.save().catch(() => {});
      }, 100);
  }
  async phase(value, text) {
    this.job.phase = value;
    this.job.heartbeatAt = new Date().toISOString();
    if (text) this.log(text);
    await this.save();
  }
  async control(action, candidate = null, timeout = 110000) {
    if (this.shuttingDown) throw Error('Worker stopping');
    const old = await deployment(this.config),
      requestId = randomUUID();
    await atomic(resolve(this.config.stateDir, 'deployment.json'), {
      ...old,
      action,
      candidate,
      jobId: this.job.id,
      requestId,
    });
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (this.shuttingDown) throw Error('Worker stopping');
      const ack = await json(resolve(this.config.stateDir, 'ack.json'));
      if (ack?.jobId === this.job.id && ack.requestId === requestId) {
        if (ack.action === 'error') throw Error('Server lifecycle operation failed');
        return ack;
      }
      await sleep(200);
    }
    throw Error('Server lifecycle operation timed out');
  }
  async serve(release) {
    const old = await deployment(this.config);
    await atomic(resolve(this.config.stateDir, 'deployment.json'), {
      ...old,
      current: release,
      action: 'serve',
      candidate: null,
      jobId: null,
      requestId: randomUUID(),
    });
  }
  async rollback(snapshot, oldRelease, error) {
    await this.phase('rolling_back', 'Ошибка обновления. Восстанавливаем прежнюю версию.');
    try {
      await this.control('stop');
      if (await json(resolve(snapshot.directory, 'complete.json'))) await snapshot.restore();
      await this.control('verify', oldRelease);
      this.job.error = this.clean(error.message);
      this.job.restored = true;
      this.job.completedAt = new Date().toISOString();
      await this.phase('failed', 'Прежняя версия восстановлена. Данные и конфигурация сохранены.');
      await this.serve(oldRelease);
    } catch {
      if (this.shuttingDown) throw Error('Worker stopping');
      this.job.error =
        'Автоматическое восстановление не завершено. Сохранённая резервная копия доступна оператору сервера.';
      this.job.completedAt = new Date().toISOString();
      await this.phase('rollback_failed', this.job.error);
    }
  }
  async run(job) {
    if (
      !uuid(job?.id) ||
      !sha(job?.targetCommit) ||
      !Array.isArray(job.logs) ||
      terminal(job.phase)
    )
      return;
    this.job = job;
    this.sequence = job.logs.at(-1)?.sequence ?? 0;
    const heartbeat = setInterval(() => {
      this.job.heartbeatAt = new Date().toISOString();
      void this.save().catch(() => {});
    }, 2000);
    const original = await deployment(this.config),
      oldRelease = original.current;
    const snapshot = new DatabaseSnapshot(
      this.config,
      resolve(this.config.backupsDir, job.id),
      (text) => this.log(text),
    );
    let stopped = false;
    try {
      // Before a stopped acknowledgement no database changes have happened.
      // Resuming this phase must preserve any calls that kept quiescence busy.
      if (job.phase === 'stopping') {
        await this.serve(oldRelease);
        await this.phase('queued', 'Возобновляем подготовку после перезапуска агента.');
      }
      if (
        ['backing_up', 'migrating', 'starting', 'verifying', 'rolling_back'].includes(job.phase)
      ) {
        await snapshot.prepare();
        await this.rollback(snapshot, oldRelease, Error('Процесс обновления был прерван.'));
        return;
      }
      await this.phase('fetching', 'Получаем исходники официальной ветки main.');
      await mkdir(this.config.releasesDir, { recursive: true, mode: 0o700 });
      const stage = resolve(this.config.releasesDir, 'staging-' + job.id),
        target = releaseRoot(this.config, job.targetCommit);
      await rm(stage, { recursive: true, force: true });
      const run = (name, args, options = {}) =>
        command(name, args, {
          cwd: stage,
          env: buildEnvironment(),
          log: (text) => this.log(text),
          ...options,
        });
      await command(
        'git',
        [
          'clone',
          '--single-branch',
          '--branch',
          'main',
          '--no-checkout',
          '--',
          this.gitRemote,
          stage,
        ],
        { env: buildEnvironment(), log: (text) => this.log(text), timeoutMs: 10 * 60 * 1000 },
      );
      const head = (
        await run('git', ['rev-parse', 'refs/remotes/origin/main'], { capture: true, quiet: true })
      ).trim();
      if (head !== job.targetCommit)
        throw Error('Ветка main изменилась. Проверьте новую сборку и повторите обновление.');
      await run('git', ['checkout', '--detach', job.targetCommit]);
      await this.phase(
        'installing',
        'Устанавливаем зависимости новой сборки. Платформа продолжает работать.',
      );
      await run('npm', ['ci', '--no-audit', '--no-fund'], { timeoutMs: 15 * 60 * 1000 });
      await this.phase('building', 'Собираем новую версию приложения.');
      await run('npm', ['run', 'build'], { timeoutMs: 15 * 60 * 1000 });
      const info = await json(resolve(stage, 'build-info.json'));
      if (info?.commit !== job.targetCommit || info.modified)
        throw Error('Сборка не соответствует выбранному коммиту.');
      await snapshot.prepare();
      if (oldRelease === job.targetCommit) throw Error('Эта сборка уже установлена.');
      await rm(target, { recursive: true, force: true });
      await rename(stage, target);
      await mkdir(this.config.dataDir, { recursive: true });
      await symlink(this.config.dataDir, resolve(target, 'data'), 'dir');
      await this.phase('waiting_for_meetings', 'Проверяем завершение встреч и текущих запросов.');
      for (;;) {
        await this.phase('stopping');
        const ack = await this.control('quiesce');
        if (ack.action === 'stopped') {
          stopped = true;
          break;
        }
        await this.phase('waiting_for_meetings');
        this.log('Ожидаем завершения активных встреч. Текущая версия продолжает работать.');
        await sleep(15000);
      }
      await this.phase('backing_up', 'Сервер остановлен. Создаём резервную копию базы.');
      await snapshot.backup();
      await this.phase('migrating', 'Применяем миграции новой версии.');
      await command(process.execPath, ['apps/api/dist/db/cli.js', 'migrate'], {
        cwd: target,
        env: environment(this.config),
        log: (text) => this.log(text),
        timeoutMs: 15 * 60 * 1000,
      });
      await this.phase('starting', 'Запускаем новую версию.');
      await this.control('verify', job.targetCommit);
      await this.phase('verifying', 'Сервер и база готовы. Завершаем переключение версии.');
      this.job.completedAt = new Date().toISOString();
      await this.phase('completed', 'Обновление системы завершено.');
      await this.serve(job.targetCommit);
    } catch (error) {
      if (this.shuttingDown) return;
      if (this.job.phase === 'completed') return;
      if (stopped || (await deployment(this.config)).action !== 'serve') {
        if (!snapshot.embedded && !snapshot.pgEnv)
          try {
            await snapshot.prepare();
          } catch {}
        await this.rollback(snapshot, oldRelease, error);
      } else {
        this.job.error = this.clean(error.message);
        this.job.completedAt = new Date().toISOString();
        await this.phase(
          'failed',
          'Подготовка обновления не завершена. Текущая версия продолжает работать.',
        );
      }
    } finally {
      clearInterval(heartbeat);
      if (this.logTimer) {
        clearTimeout(this.logTimer);
        this.logTimer = null;
      }
      await this.save();
      this.job = null;
    }
  }
  async prune() {
    const jobs = [];
    for (const name of await readdir(resolve(this.config.stateDir, 'jobs'))) {
      if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
      const job = await json(resolve(this.config.stateDir, 'jobs', name));
      if (job && uuid(job.id) && sha(job.targetCommit) && terminal(job.phase)) jobs.push(job);
    }
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const state = await deployment(this.config);
    const releases = new Set([
      state.current,
      state.candidate,
      ...jobs.slice(0, 3).map((j) => j.targetCommit),
    ]);
    const backups = new Set(jobs.slice(0, 3).map((j) => j.id));
    for (const job of jobs)
      if (job.phase === 'rollback_failed') {
        backups.add(job.id);
        releases.add(job.targetCommit);
      }
    for (const name of await readdir(this.config.releasesDir).catch(() => [])) {
      if (
        (sha(name) && !releases.has(name)) ||
        (name.startsWith('staging-') && jobs.some((j) => 'staging-' + j.id === name))
      )
        await rm(resolve(this.config.releasesDir, name), { recursive: true, force: true });
    }
    for (const name of await readdir(this.config.backupsDir).catch(() => []))
      if (uuid(name) && !backups.has(name))
        await rm(resolve(this.config.backupsDir, name), { recursive: true, force: true });
  }
  async loop({ once = false } = {}) {
    await mkdir(resolve(this.config.stateDir, 'jobs'), { recursive: true, mode: 0o700 });
    const claim = resolve(this.config.stateDir, 'worker.lock');
    try {
      await mkdir(claim, { mode: 0o700 });
    } catch {
      const heartbeat = await json(resolve(this.config.stateDir, 'agent.json'));
      if (heartbeat && Date.now() - Date.parse(heartbeat.heartbeatAt) < 20000)
        throw Error('Another update worker is running');
      await rm(claim, { recursive: true, force: true });
      await mkdir(claim, { mode: 0o700 });
    }
    let stop = false;
    const heart = async () =>
      atomic(resolve(this.config.stateDir, 'agent.json'), {
        protocol: 1,
        mode: this.config.mode,
        heartbeatAt: new Date().toISOString(),
      });
    await heart();
    const timer = setInterval(() => {
      void heart().catch(() => {});
    }, 2000);
    const signal = () => {
      stop = true;
      this.shuttingDown = true;
      abortCommands();
    };
    process.once('SIGTERM', signal);
    process.once('SIGINT', signal);
    try {
      await cleanGrants(this.config);
      do {
        const d = await deployment(this.config);
        const active = [];
        for (const name of await readdir(resolve(this.config.stateDir, 'jobs')))
          if (/^[a-f0-9-]{36}\.json$/i.test(name)) {
            const job = await json(resolve(this.config.stateDir, 'jobs', name));
            if (job && uuid(job.id) && sha(job.targetCommit) && !terminal(job.phase))
              active.push(job);
          }
        active.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (active[0]) {
          await this.run(active[0]);
          if (!this.shuttingDown) await this.prune().catch(() => {});
        } else if (d.action !== 'serve' && uuid(d.jobId)) {
          const ended = await json(resolve(this.config.stateDir, 'jobs', d.jobId + '.json'));
          if (ended?.phase === 'completed') await this.serve(ended.targetCommit);
          else if (ended?.phase === 'failed' && ended.restored) await this.serve(d.current);
        }
        const current = await deployment(this.config);
        if (current.current !== d.current) break;
        if (!once && !stop && !this.shuttingDown) await sleep(1000);
      } while (!once && !stop && !this.shuttingDown);
    } finally {
      clearInterval(timer);
      process.off('SIGTERM', signal);
      process.off('SIGINT', signal);
      await rm(claim, { recursive: true, force: true });
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await configuration(process.argv[2]);
  await new UpdateWorker(config).loop();
}
