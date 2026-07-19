import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

// When running inside a container (docker-compose.dev.yml), enable polling +
// 0.0.0.0 host + an explicit HMR host so file-watching and the HMR websocket
// work across the Docker boundary. Off by default for native local dev.
const inContainer = process.env.CHOKIDAR_USEPOLLING === 'true';

export default defineConfig({
  // Bake the app version into the bundle so the UI can show which build is live.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react()],
  server: {
    port: 5173,
    host: inContainer ? '0.0.0.0' : 'localhost',
    watch: inContainer ? { usePolling: true } : undefined,
    hmr: inContainer ? { host: process.env.VITE_HMR_HOST ?? 'localhost' } : undefined,
    proxy: {
      // Forward API calls to the Elysia server in dev.
      '/api': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
    },
  },
});
