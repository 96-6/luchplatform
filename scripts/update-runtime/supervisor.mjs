import http from 'node:http';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  configuration,
  childEnvironment,
  environment,
  deployment,
  releaseRoot,
  json,
  atomic,
  hash,
  uuid,
  sha,
  sleep,
} from './shared.mjs';

function cookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((s) => {
      const i = s.indexOf('=');
      return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
    }),
  );
}
async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
export async function runSupervisor(config, { startWorker = true } = {}) {
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  let child = null,
    port = 0,
    ready = false,
    serving = false,
    loaded = null,
    worker = null,
    stopping = false,
    processing = false,
    lastCommand = '';
  const waiting = new Map();
  async function stopChild() {
    serving = false;
    ready = false;
    if (!child) return;
    const old = child;
    child = null;
    loaded = null;
    let timer;
    const exited = once(old, 'exit');
    old.kill('SIGTERM');
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            old.kill('SIGKILL');
            reject(Error('Application shutdown timed out'));
          }, 45000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function startChild(release) {
    if (child && loaded === release && ready) return;
    await stopChild();
    port = await freePort();
    const root = releaseRoot(config, release);
    child = fork(resolve(root, 'apps/api/dist/server.js'), [], {
      cwd: root,
      env: childEnvironment(config, port),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    loaded = release;
    const current = child;
    current.on('message', (message) => {
      if (child !== current) return;
      if (message?.type === 'luch:ready') ready = true;
      if (message?.type === 'luch:quiesced') {
        const done = waiting.get(message.id);
        if (done) {
          waiting.delete(message.id);
          done(Boolean(message.ready));
        }
      }
    });
    current.once('exit', () => {
      if (child === current) {
        child = null;
        ready = false;
        serving = false;
        loaded = null;
      }
    });
    const until = Date.now() + 90000;
    while (!ready && child === current && Date.now() < until) await sleep(100);
    if (!ready || child !== current) throw Error('Application did not become ready');
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error('Application readiness failed');
  }
  async function quiesce() {
    if (!child || !ready) return true;
    const id = crypto.randomUUID();
    const answer = new Promise((resolve) => waiting.set(id, resolve));
    child.send({ type: 'luch:quiesce', id });
    let timer;
    const ok = await Promise.race([
      answer,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 35000);
      }),
    ]);
    clearTimeout(timer);
    waiting.delete(id);
    return ok;
  }
  async function progress(req, res, url) {
    if (
      req.method !== 'GET' ||
      url.pathname !== '/api/v1/admin/updates/progress' ||
      !uuid(url.searchParams.get('jobId'))
    )
      return false;
    const values = cookies(req.headers.cookie),
      token = values['__Secure-luch_update_progress'] || values.luch_update_progress;
    const session = values['__Host-luch_session'] || values.luch_session;
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || !session) return false;
    const grant = await json(resolve(config.stateDir, 'grants', hash(token) + '.json'));
    if (
      !grant ||
      grant.jobId !== url.searchParams.get('jobId') ||
      grant.sessionHash !== hash(session) ||
      grant.expiresAt < Date.now()
    )
      return false;
    const job = await json(resolve(config.stateDir, 'jobs', grant.jobId + '.json'));
    if (!job || !uuid(job.id) || !sha(job.targetCommit)) return false;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(
      JSON.stringify({ data: { job, transport: 'maintenance' }, requestId: crypto.randomUUID() }),
    );
    return true;
  }
  const unavailable = (res, path) => {
    res.writeHead(503, {
      'content-type': path.startsWith('/api/')
        ? 'application/json; charset=utf-8'
        : 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '2',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    res.end(
      path.startsWith('/api/')
        ? JSON.stringify({
            error: {
              code: 'PLATFORM_UPDATING',
              message: 'Система обновляется. Связь восстановится автоматически.',
              requestId: crypto.randomUUID(),
            },
          })
        : '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Обновление ЛУЧ</title><h1>Платформа перезапускается</h1><p>Подождите и обновите эту страницу.</p></html>',
    );
  };
  function headers(req) {
    const forwarded = [req.headers['x-forwarded-for'], req.socket.remoteAddress]
      .filter(Boolean)
      .join(', ');
    return { ...req.headers, 'x-forwarded-for': forwarded };
  }
  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/v1/health/live') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify({ data: { status: 'ok' }, requestId: crypto.randomUUID() }));
        return;
      }
      if (!serving || !ready) {
        if (await progress(req, res, url)) return;
        unavailable(res, url.pathname);
        return;
      }
      const proxy = http.request(
        { host: '127.0.0.1', port, path: req.url, method: req.method, headers: headers(req) },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      proxy.on('error', () => {
        if (!res.headersSent) unavailable(res, url.pathname);
        else res.destroy();
      });
      req.on('aborted', () => proxy.destroy());
      res.on('close', () => proxy.destroy());
      req.pipe(proxy);
    })().catch(() => {
      if (!res.headersSent) unavailable(res, '/api/');
      else res.destroy();
    });
  });
  server.requestTimeout = 30 * 60 * 1000;
  server.on('upgrade', (req, socket, head) => {
    if (!serving || !ready) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const proxy = http.request({
      host: '127.0.0.1',
      port,
      path: req.url,
      method: req.method,
      headers: headers(req),
    });
    proxy.on('upgrade', (response, upstream, upstreamHead) => {
      socket.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
          Object.entries(response.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') +
          '\r\n\r\n',
      );
      if (head.length) upstream.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(upstream).pipe(socket);
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    });
    proxy.on('response', (response) => {
      socket.end(`HTTP/1.1 ${response.statusCode} Unauthorized\r\nConnection: close\r\n\r\n`);
      response.resume();
    });
    proxy.on('error', () => socket.destroy());
    proxy.end();
  });
  server.listen(config.listenPort, config.listenHost);
  await once(server, 'listening');
  async function control() {
    if (processing || stopping) return;
    processing = true;
    try {
      const d = await deployment(config);
      const command = JSON.stringify([d.action, d.current, d.candidate, d.requestId]);
      if (d.action !== 'serve' && command === lastCommand) return;
      lastCommand = command;
      if (
        !['serve', 'quiesce', 'stop', 'verify'].includes(d.action) ||
        !(d.current === 'initial' || sha(d.current))
      )
        throw Error('Invalid deployment state');
      if (d.action === 'serve') {
        await startChild(d.current);
        serving = true;
      } else if (d.action === 'quiesce') {
        if (!uuid(d.jobId)) throw Error('Invalid job');
        const ok = await quiesce();
        if (ok) await stopChild();
        else child?.send({ type: 'luch:resume' });
        await atomic(resolve(config.stateDir, 'ack.json'), {
          jobId: d.jobId,
          requestId: d.requestId,
          action: ok ? 'stopped' : 'busy',
          at: new Date().toISOString(),
        });
      } else if (d.action === 'stop') {
        await stopChild();
        await atomic(resolve(config.stateDir, 'ack.json'), {
          jobId: d.jobId,
          requestId: d.requestId,
          action: 'stopped',
          at: new Date().toISOString(),
        });
      } else if (d.action === 'verify') {
        serving = false;
        await startChild(d.candidate);
        await atomic(resolve(config.stateDir, 'ack.json'), {
          jobId: d.jobId,
          requestId: d.requestId,
          action: 'ready',
          release: d.candidate,
          at: new Date().toISOString(),
        });
      }
    } catch {
      const d = await deployment(config);
      await atomic(resolve(config.stateDir, 'ack.json'), {
        jobId: d.jobId,
        requestId: d.requestId,
        action: 'error',
        at: new Date().toISOString(),
      });
    } finally {
      processing = false;
    }
  }
  const timer = setInterval(() => {
    void control();
  }, 250);
  await control();
  if (startWorker) {
    const launch = async () => {
      if (stopping) return;
      const d = await deployment(config),
        root = releaseRoot(config, d.current);
      worker = fork(resolve(root, 'scripts/update-runtime/worker.mjs'), [config.filename], {
        cwd: root,
        env: environment(config),
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      worker.once('exit', () => {
        worker = null;
        if (!stopping)
          setTimeout(() => {
            void launch();
          }, 2000);
      });
    };
    await launch();
  }
  async function close() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    if (worker) {
      const current = worker;
      const exited = once(current, 'exit');
      current.kill('SIGTERM');
      let deadline;
      await Promise.race([
        exited,
        new Promise((r) => {
          deadline = setTimeout(() => {
            current.kill('SIGKILL');
            r();
          }, 10000);
        }),
      ]);
      clearTimeout(deadline);
    }
    await stopChild();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      void close().then(() => process.exit(0));
    });
  return { port: server.address().port, close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const config = await configuration(file);
  config.filename = file;
  await runSupervisor(config, { startWorker: config.mode === 'node' });
}
