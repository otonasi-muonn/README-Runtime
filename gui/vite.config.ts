import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Local developer tool: listen on the loopback interface only (Issue #2: no public service).
// The mock reads the repository's own readme-runtime.json and generated SVGs one level up.
export default defineConfig({
  plugins: [vue()],
  server: { host: '127.0.0.1', port: 5175, strictPort: false, fs: { allow: ['..'] } },
  preview: { host: '127.0.0.1' },
});
