import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const r = (p: string) => resolve(process.cwd(), p);

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: r('src/background/index.ts'),
        options: r('src/options/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
