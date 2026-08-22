import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The dashboard can run the engine client-side, which means resolving the
    // browser-safe entry rather than the one that reaches for node:sqlite.
    alias: {
      '@mnemos/core': new URL('../../packages/core/src/browser.ts', import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Lets the dev server talk to a locally running API without CORS.
      '/api': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
