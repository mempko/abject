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
    host: '127.0.0.1',
  },
});
