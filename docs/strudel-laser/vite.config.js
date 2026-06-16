import { defineConfig } from 'vite';
import { dependencies } from './package.json';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'index.mjs'),
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      // do NOT bundle @strudel/core (or any dep) into the package
      external: [...Object.keys(dependencies)],
    },
    target: 'esnext',
  },
});
