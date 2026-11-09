import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // The preview is served through a host that is not localhost, so the
    // dev server has to accept it explicitly.
    allowedHosts: true,
    host: true,
    // In production Cloudflare Pages serves the console and the API from the
    // same origin. Locally the API runs on its own port, so the dev server
    // forwards /api to it.
    //
    // The original Host is passed on as X-Forwarded-Host: the API checks the
    // Origin header against the host the browser is talking to, and the proxy
    // otherwise replaces it with the target's own host.
    proxy: process.env.HC_API_URL
      ? {
        '/api': {
          target: process.env.HC_API_URL,
          changeOrigin: false,
          configure: (proxy: any) => {
            proxy.on('proxyReq', (proxyReq: any, req: any) => {
              proxyReq.setHeader('X-Forwarded-Host', req.headers.host);
              proxyReq.setHeader('X-Forwarded-Proto', 'http');
            });
          },
        },
      }
      : undefined,
  },
  preview: {
    allowedHosts: true,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Keep the framework in a cacheable chunk so the app bundle stays small
        // and redeploying a screen does not invalidate React itself.
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') ||
              id.includes('node_modules/react-router') || id.includes('node_modules/scheduler')) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
});
