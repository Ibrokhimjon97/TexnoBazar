import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  server: {
    proxy: {
      '/api': 'http://localhost:5174',
    },
  },
  resolve: {
    alias: {
      '@texnobazar/data': fileURLToPath(new URL('../../packages/data/src/index.js', import.meta.url)),
    },
  },
  plugins: [react()],
});
