import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  build: {
    target: 'esnext',
    outDir: '../dist-client',
  },
  worker: {
    format: 'es',
  },
  server: {
    port: parseInt(process.env.VITE_CLIENT_PORT ?? '5174', 10),
    // Fail loudly if the port is taken rather than silently drifting to
    // another one, which leaves nginx proxying to a stale/wrong instance.
    strictPort: true,
    host: '127.0.0.1',
  },
});
