'use strict';
/*
 * HA 3D Home — 服务端唯一入口（Express）
 *
 * 本文件同时负责：组装（中间件 / 按域路由 / 静态托管兜底 / 异常兜底）与启动。
 * 分层（全部平铺在 server/ 下，无子目录）：
 *   index.js            入口 + 应用组装 + 路由挂载
 *   shared.js     唯一共用基础层：目录常量/持久化/日志 + HTTP 工具 + 路由公共件
 *   library.js    共用能力层：静态托管 + 家具目录/底图 + 家具包 + 插件包/zip + 原子替换
 *   system.js     /api/health、/api/version
 *   config.js     /api/config、/api/config/test（含 HA 连接测试）
 *   assets.js     /api/upload、/api/refimg、/api/catalog、/api/plugins
 *   install.js    /api/install/config*、/api/plugins/install、/api/plugins/import
 *   project.js    /api/project、/api/anchor、/api/house/size
 *
 * 接口级复刻的三条硬约束：
 *  1. 不挂 body parser，readBody / readRawBody 直接读原生流（zip 二进制不能被消费）。
 *  2. JSON 响应走 sendJSON（writeHead + JSON.stringify），不用 res.json。
 *  3. 静态资源走 serveStatic（三级缓存 / ETag / 304 / 404 纯文本 / 目录逃逸校验）。
 * 另关掉 x-powered-by / etag，打开大小写敏感与严格路由，拦掉 HEAD / OPTIONS 的 Express 默认行为。
 */
const express = require('express');
const core = require('./shared');
const { sendJSON, requestURL } = require('./shared');
const { serveStatic } = require('./library');
const systemRoutes = require('./system');
const configRoutes = require('./config');
const assetRoutes = require('./assets');
const installRoutes = require('./install');
const projectRoutes = require('./project');

const { DATA_DIR, ASSET_DIR, CUSTOM_DIR, IS_PROD, log } = core;
const PORT = parseInt(process.env.PORT || '8077', 10);

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.enable('case sensitive routing');
  app.enable('strict routing');

  /* HEAD / OPTIONS 保真：Express Router 会把 HEAD 自动落到 GET、给 OPTIONS 生成 Allow，
   * 而旧站只认显式写了 method 的分支 —— 除 /api/health（任意方法都回）之外，
   * HEAD 一律落到静态托管、OPTIONS 一律 405 空 body。这里在进 Router 前分流掉。 */
  app.use((req, res, next) => {
    if (req.method !== 'HEAD' && req.method !== 'OPTIONS') return next();
    const u = requestURL(req);
    if (u.pathname === '/api/health') return next();
    if (req.method === 'OPTIONS') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, u);
  });

  const api = express.Router({ caseSensitive: true, strict: true });
  api.use(systemRoutes());
  api.use(configRoutes());
  api.use(assetRoutes());
  api.use(installRoutes());
  api.use(projectRoutes());
  app.use('/api', api);

  /* 旧站主流程：5 个域都不匹配 → 非 GET/HEAD 回 405，其余交给静态托管 */
  app.use((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, requestURL(req));
  });

  /* 旧站 createServer 的 try/catch → sendJSON(e.status||500, {error}) */
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    core.logErr('[ha-3d-home] 请求处理异常:', err && err.stack || err);
    return sendJSON(res, err.status || 500, { error: String(err.message || err) });
  });

  return app;
}

if (require.main === module) {
  core.ensureDirs();
  createApp().listen(PORT, '0.0.0.0', () => {
    log('[ha-3d-home] listening on 0.0.0.0:' + PORT
      + '  data=' + DATA_DIR + '  assets=' + ASSET_DIR + '  custom=' + CUSTOM_DIR
      + (IS_PROD ? '  mode=production(quiet)' : ''));
  });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}
