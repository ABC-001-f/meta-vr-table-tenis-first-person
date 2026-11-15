import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR needs a secure context, so the dev server runs over HTTPS (self-signed).
// The multiplayer server (npm run server) is proxied at /ws so the headset
// only ever talks to one origin.
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true,
    port: 8081,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true, rewriteWsOrigin: true },
    },
  },
  preview: {
    host: true,
    port: 8081,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true, rewriteWsOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
});
