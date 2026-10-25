import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 개발 중에는 vite(5173)가 화면을, 마이오피스 서버(7777)가 API·WebSocket을 맡는다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7777',
      '/ws': { target: 'ws://127.0.0.1:7777', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
