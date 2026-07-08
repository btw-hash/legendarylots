import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://localhost:3940',
      '/i': 'http://localhost:3940',
    },
  },
  build: { outDir: 'dist' },
});
