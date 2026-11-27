import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createRuntimeApi } from './server/runtimeApi.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// /api: the connection to README Runtime (Issue #3), on the dev server itself.
function runtimeApi(): Plugin {
  return {
    name: 'readme-runtime-api',
    configureServer(server) {
      server.middlewares.use(createRuntimeApi({ root }));
    },
  };
}

// Local developer tool: listen on the loopback interface only (Issue #2: no public service).
// The mock reads the repository's own readme-runtime.json and generated SVGs one level up.
export default defineConfig({
  plugins: [vue(), runtimeApi()],
  server: { host: '127.0.0.1', port: 5175, strictPort: false, fs: { allow: ['..'] } },
  preview: { host: '127.0.0.1' },
});
