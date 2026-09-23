import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const stub = fileURLToPath(new URL('./headlamp-stub.tsx', import.meta.url));

// Renders the real terminal outside Headlamp, against a fake pod, for screenshots.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: [{ find: /^@kinvolk\/headlamp-plugin\/lib.*$/, replacement: stub }],
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
