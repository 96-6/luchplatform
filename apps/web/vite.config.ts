import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { pageErrorDocument, errorSchema, resolveLocale } from '@luch/contracts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const browserRoots = [
  resolve(root, 'apps/web'),
  resolve(root, 'packages/contracts/dist'),
  resolve(root, 'node_modules'),
];
const inside = (base: string, file: string) => {
  const offset = relative(base, file);
  return (
    offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep))
  );
};
export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, root, '');
  const apiPort = Number(process.env.API_PORT ?? environment.API_PORT ?? 3000);
  const webPort = Number(process.env.WEB_PORT ?? environment.WEB_PORT ?? 5173);
  return {
    plugins: [
      react(),
      {
        name: 'luch-page-access',
        async configureServer(server) {
          const allowedRoots = await Promise.all(browserRoots.map((folder) => realpath(folder)));
          server.middlewares.use(async (req, res, next) => {
            const locale = resolveLocale(req.headers.cookie, req.headers['accept-language']);
            const path = req.url ?? '/';
            const pathname = path.split('?')[0]!;
            if (pathname.startsWith('/@fs/')) {
              let permitted = false;
              try {
                let requested = decodeURIComponent(pathname.slice(4));
                if (process.platform === 'win32' && /^\/[a-z]:\//i.test(requested))
                  requested = requested.slice(1);
                if (
                  isAbsolute(requested) &&
                  [...browserRoots, ...allowedRoots].some((base) =>
                    inside(base, resolve(requested)),
                  )
                ) {
                  const file = await realpath(requested);
                  permitted = allowedRoots.some((base) => inside(base, file));
                }
              } catch {
                /* Missing file or invalid path is not served. */
              }
              if (!permitted) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                return res.end(
                  pageErrorDocument(
                    403,
                    'Этот файл недоступен через приложение.',
                    'dev-file',
                    locale,
                  ),
                );
              }
            }
            const developmentModule =
              /^\/(?:src|node_modules|@vite|@react-refresh|@id|@fs)(?:\/|$)/.test(pathname);
            const publicAsset =
              /^\/(?:avatars\/(?:mentor|partner|guide)\.svg|audio\/pcm-recorder\.js|assets\/[A-Za-z0-9_/-]+\.(?:js|css|woff2?|ttf|png|jpe?g|webp|svg|ico))$/.test(
                pathname,
              );
            if (
              !['GET', 'HEAD'].includes(req.method ?? '') ||
              (developmentModule && !req.headers.accept?.includes('text/html')) ||
              publicAsset ||
              path.startsWith('/api/') ||
              pathname === '/browser-check-worker.js' ||
              path.startsWith('/learning-media/')
            )
              return next();
            try {
              const response = await fetch(
                `http://127.0.0.1:${apiPort}/api/v1/navigation/access?path=${encodeURIComponent(path)}`,
                {
                  headers: Object.fromEntries(
                    [
                      'cookie',
                      'user-agent',
                      'sec-ch-ua',
                      'sec-ch-ua-platform',
                      'sec-ch-ua-mobile',
                      'sec-ch-ua-full-version-list',
                    ].flatMap((key) => {
                      const value = req.headers[key];
                      return typeof value === 'string' ? [[key, value]] : [];
                    }),
                  ),
                  redirect: 'error',
                  signal: AbortSignal.timeout(10000),
                },
              );
              if (response.ok) return next();
              const error = errorSchema.safeParse(await response.json());
              res.statusCode = response.status;
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('Referrer-Policy', 'no-referrer');
              return res.end(
                pageErrorDocument(
                  response.status,
                  error.success ? error.data.error.message : 'Не удалось открыть страницу.',
                  error.success ? error.data.error.requestId : 'dev-page',
                  locale,
                  pathname === '/set-password' ? '/forgot-password' : '/register',
                ),
              );
            } catch {
              res.statusCode = 503;
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.setHeader('Cache-Control', 'no-store');
              return res.end(
                pageErrorDocument(
                  503,
                  'Сервер приложения недоступен. Запустите API и обновите страницу.',
                  'dev-page',
                  locale,
                ),
              );
            }
          });
        },
      },
    ],
    // No server environment values are exposed to the browser.
    envPrefix: 'VITE_PUBLIC_',
    server: {
      port: webPort,
      strictPort: true,
      fs: {
        strict: true,
        allow: browserRoots,
      },
      proxy: {
        '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true, ws: true },
        '/learning-media': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      },
    },
  };
});
