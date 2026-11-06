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
        offscreen: r('src/offscreen/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
