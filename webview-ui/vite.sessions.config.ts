import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Builds the Session Manager webview into dist/webview/sessions.{js,css}. Runs after the chat
// build (vite.config.ts empties the folder), so it must not empty it again.
export default defineConfig({
  root: resolve(import.meta.dirname),
  plugins: [react()],
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, '..', 'dist', 'webview'),
    emptyOutDir: false,
    sourcemap: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src', 'sessions', 'main.tsx'),
      output: {
        entryFileNames: 'sessions.js',
        chunkFileNames: 'sessions-[name].js',
        assetFileNames: 'sessions.[ext]',
        inlineDynamicImports: true,
      },
    },
  },
});
