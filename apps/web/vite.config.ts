import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { pageErrorDocument, errorSchema } from '@luch/contracts';

const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, root, '');
  const apiPort = Number(process.env.API_PORT ?? environment.API_PORT ?? 3000);
  const webPort = Number(process.env.WEB_PORT ?? environment.WEB_PORT ?? 5173);
  return {
    plugins: [
      react(),
      {
        name: 'luch-page-access',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const path = req.url ?? '/';
            const pathname = path.split('?')[0]!;
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
              path.startsWith('/learning-media/')
            )
              return next();
            try {
              const response = await fetch(
                `http://127.0.0.1:${apiPort}/api/v1/navigation/access?path=${encodeURIComponent(path)}`,
                {
                  headers: req.headers.cookie ? { cookie: req.headers.cookie } : {},
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
      proxy: {
        '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true, ws: true },
        '/learning-media': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      },
    },
  };
});
