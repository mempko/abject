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
    port: 5174,
  },
});
