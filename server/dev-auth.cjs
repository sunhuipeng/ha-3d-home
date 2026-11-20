'use strict';
/*
 * dev 期默认登录账号（admin / admin）
 *
 * 通过 `node -r ./server/dev-auth.cjs server/index.js` 在入口之前预加载：
 * auth.js 在 require 时读 process.env，所以必须赶在 server/index.js 之前把值放好。
 * 用 Node 预加载而非 shell 的 `VAR=x cmd`，是为了跨平台（Windows / Git Bash 通吃）。
 *
 * 规则：只有三个认证变量都没设置时才注入默认值 —— 完全尊重外部环境：
 *   · 想改账号：HA3D_AUTH_USER=xxx HA3D_AUTH_PASS=yyy npm run serve
 *   · 想关认证：HA3D_AUTH_USER= npm run serve（显式给空，auth.js 判定为未启用）
 * 生产 Docker 不经过 npm run serve，这里不会影响镜像行为。
 */
if (process.env.HA3D_AUTH_USER === undefined
  && process.env.HA3D_AUTH_PASS === undefined
  && process.env.HA3D_AUTH_PASS_HASH === undefined) {
  process.env.HA3D_AUTH_USER = 'admin';
  process.env.HA3D_AUTH_PASS = 'admin';
}
