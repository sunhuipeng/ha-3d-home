import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5190,
    proxy: {
      // 开发时 API 转发到本地 home 服务（node server/index.js，默认 8077）
      '/api': 'http://localhost:8077',
      // 经典共享脚本 / 库 / 插件资源仍由后端在 public/ 下托管，dev 时透传回去
      '/assets': 'http://localhost:8077',
      '/custom': 'http://localhost:8077',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // 双入口 MPA：编辑页 + 展示页
      input: {
        index: 'index.html',
        display: 'display.html',
      },
    },
  },
});
