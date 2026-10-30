import { access, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import staticFiles from '@fastify/static';
import { navigationQuerySchema, pageErrorDocument, resolveLocale } from '@luch/contracts';
import type { AuthService } from '../auth/service.js';
import { AppError } from '../../errors.js';
import { NavigationService } from './service.js';

export function pageError(reply: FastifyReply, status: number, message: string, requestId: string) {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .send(
      pageErrorDocument(
        status,
        message,
        requestId,
        resolveLocale(reply.request.headers.cookie, reply.request.headers['accept-language']),
        reply.request.url.split('?')[0] === '/set-password' ? '/forgot-password' : '/register',
      ),
    );
}
export async function registerWebAccess(app: FastifyInstance, auth: AuthService, webRoot: string) {
  const navigation = new NavigationService(auth);
  app.get('/api/v1/navigation/access', async (request) => ({
    data: await navigation.check(request, navigationQuerySchema.parse(request.query).path),
    requestId: request.id,
  }));
  let mediaRoot = webRoot;
  if (!auth.settings.SERVE_WEB) {
    const sourceRoot = resolve(webRoot, '../public');
    try {
      await access(sourceRoot);
      mediaRoot = sourceRoot;
    } catch {
      /* Compiled API deployments use the published dist directory. */
    }
  }
  await app.register(staticFiles, {
    root: mediaRoot,
    serve: false,
    index: false,
    dotfiles: 'deny',
  });
  app.get('/learning-media/*', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    await auth.requireActor(request);
    if (
      !/^\/learning-media\/[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(path) ||
      path.includes('..') ||
      path.includes('//')
    )
      throw new AppError(400, 'INVALID_MEDIA_PATH', 'Некорректная ссылка на материал.');
    const known = (
      await auth.database.query(
        "SELECT 1 FROM learning_assets WHERE definition->>'src'=$1 LIMIT 1",
        [path],
      )
    ).rows[0];
    if (!known) throw new AppError(404, 'MEDIA_NOT_FOUND', 'Материал не найден.');
    await containedFile(mediaRoot, path);
    return reply.sendFile(path.slice(1));
  });
  if (!auth.settings.SERVE_WEB) return;
  // No blanket static directory: only build assets and published media are addressable.
  app.get('/*', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (path.startsWith('/api/')) return reply.callNotFound();
    if (
      /^\/assets\/[A-Za-z0-9_/-]+\.(?:js|css|woff2?|ttf|png|jpe?g|webp|svg|ico)$/.test(path) ||
      /^\/avatars\/(?:mentor|partner|guide)\.svg$/.test(path) ||
      path === '/audio/pcm-recorder.js' ||
      path === '/browser-check-worker.js' ||
      path === '/favicon.svg'
    ) {
      await containedFile(webRoot, path);
      return reply.sendFile(path.slice(1));
    }
    await navigation.check(request, request.url);
    return reply.header('referrer-policy', 'no-referrer').type('text/html').sendFile('index.html');
  });
}
async function containedFile(root: string, path: string) {
  try {
    const [base, file] = await Promise.all([realpath(root), realpath(resolve(root, '.' + path))]);
    if (!file.startsWith(base + sep)) throw Error('Outside root');
  } catch {
    throw new AppError(404, 'FILE_NOT_FOUND', 'Файл не найден.');
  }
}
