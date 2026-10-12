import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('../../', import.meta.url));
export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, root, '');
  const apiPort = Number(process.env.API_PORT ?? environment.API_PORT ?? 3000);
  const webPort = Number(process.env.WEB_PORT ?? environment.WEB_PORT ?? 5173);
  return {
    plugins: [react()],
    // No server environment values are exposed to the browser.
    envPrefix: 'VITE_PUBLIC_',
    server: {
      port: webPort,
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
    },
  };
});
