import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Builds the sidebar webview into dist/webview with fixed file names,
// so WebviewBridge can reference index.js / index.css directly.
export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react()],
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '..', 'dist', 'webview'),
    emptyOutDir: true,
    sourcemap: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src', 'main.tsx'),
      output: {
        entryFileNames: 'index.js',
        chunkFileNames: 'index-[name].js',
        assetFileNames: 'index.[ext]',
        inlineDynamicImports: true,
      },
    },
  },
});
