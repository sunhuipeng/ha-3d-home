import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5190,
    /* 默认只绑 localhost（本机解析为 ::1），手机/局域网访问不到。
     * 显式绑到所有网卡后，局域网设备可用 http://<本机局域网IP>:5190/ 打开；
     * 本机继续用 localhost / 127.0.0.1 均可。 */
    host: '0.0.0.0',
    /* dev 预热：未打包时手机（WebView）一次要拉几百个模块，每个模块都要按需编译，
     * 表现为「骨架停很久」。启动时先把两个入口的依赖图编译掉，手机第一次访问就是热的。
     * 只影响 dev（npm run dev），构建产物不受影响。改这里要重启 dev 服务器才生效。 */
    warmup: {
      clientFiles: [
        './src/main-index.js',
        './src/main-edit.js',
        './src/PanelApp.vue',
      ],
    },
    /* src/version.js 要 import '../../package.json'（仓库根的应用版本号），
     * 它位于 Vite root（web/）之外；显式放行上层目录，避免 fs.strict 拦下。 */
    fs: { allow: ['..'] },
    proxy: {
      // 开发时 API 转发到本地 home 服务（node server/index.js，默认 8077）
      // 写 127.0.0.1 而不是 localhost：home 只监听 0.0.0.0（IPv4），
      // 本机 localhost 若先解析到 ::1，代理会 500（曾踩过 dns-result-order 的坑）。
      // ws: true —— HA 全代理的 /api/ha-ws 是 WebSocket 升级请求，必须开 WS 代理，
      // 否则 dev 页面 HA 永远连不上（2026-11-19）。
      '/api': { target: 'http://127.0.0.1:8077', ws: true },
      // 内置 assets/ 与用户 custom/ 由后端静态映射托管，dev 时透传回去
      '/assets': 'http://127.0.0.1:8077',
      '/custom': 'http://127.0.0.1:8077',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // 三入口 MPA：展示页（统一挂载 PanelApp）+ 编辑页 + 登录页（独立样式/逻辑，复用 tvFocus）
      input: {
        index: 'index.html',
        edit: 'edit.html',
        login: 'login.html',
      },
    },
  },
});
