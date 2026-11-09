/*
 * HA 3D Home — 轻量后端入口
 *
 * 职责：静态托管前端 + 连接配置/户型项目 JSON 持久化 + 插件安装 + HA 连接测试。
 * 实时状态由浏览器直连 Home Assistant WebSocket（不受 CORS 限制），本服务不做实时转发，
 * 也不代理 /api/states 与 /api/services（早期 REST 兜底已确认无调用方，删除以收窄转发面）。
 *
 * 零 npm 依赖（package.json 的 dependencies 为空），只用 Node 内置模块；
 * 服务端按职责拆在 server/ 下，本文件只负责「启动 + 分域路由表」：
 *   core.js            目录常量、运行模式、日志、data/*.json 持久化（含安装密钥/锚点）
 *   http-utils.js      JSON 响应、请求体读取（含大小上限）
 *   ha.js              HA 连接测试
 *   assets.js          静态托管与缓存、家具目录合并、2D 参考底图
 *   plugins.js         插件清单扫描 + zip 安装（按 kind 分流，自带最小 zip 解析）
 *   catalog-import.js  家具包（kind: catalog）解析、安装、目录扫描
 *   atomic-dir.js      安装包落盘的公共原子替换
 *
 * 路由按域拆成 handle* 函数：返回 true 表示已响应，主流程依次尝试，
 * 都不匹配才交给静态托管。
 *
 * 内存占用目标: < 50MB
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const core = require('./core');
const { sendJSON, readBody, readRawBody, reply } = require('./http-utils');
const { serveStatic, buildCatalog, saveRefImg, serveRefImg } = require('./assets');
const { testConnection } = require('./ha');
const { catalogTypeDefs } = require('./catalog-import');
const { INSTALL_MAX_BYTES, PLUGIN_ID_RE, listPlugins, installPackage } = require('./plugins');

const { DATA_DIR, ASSET_DIR, CUSTOM_DIR, IS_PROD, log, logErr } = core;
const PORT = parseInt(process.env.PORT || '8077', 10);

core.ensureDirs();

/* ---------------- 域 1：系统 ---------------- */
async function handleSystem(req, res, p) {
  if (p === '/api/health') {
    const mem = process.memoryUsage().rss;
    return reply(res, 200, { ok: true, uptime: Math.round(process.uptime()), memMB: Math.round(mem / 1048576 * 10) / 10 });
  }
  /* 应用版本号：唯一出处是根目录 package.json 的 version（core.appVersion 每次实时读）。
   * 页面里没有写死的版本号，改 package.json 后刷新即更新，连服务都不用重启。 */
  if (p === '/api/version' && req.method === 'GET') {
    return reply(res, 200, { name: 'ha-3d-home', version: core.appVersion() });
  }
  return false;
}

/* ---------------- 域 2：连接配置 / HA 测试 ---------------- */
async function handleConfig(req, res, p) {
  /* 注意：令牌会下发给前端用于直连 HA WebSocket，仅建议可信内网使用。 */
  if (p === '/api/config' && req.method === 'GET') {
    const c = core.getConfig();
    return reply(res, 200, { haUrl: c.haUrl, token: c.token || '', hasToken: !!c.token });
  }
  if (p === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    const cur = core.getConfig();
    core.saveConfig({
      haUrl: ((body && body.haUrl) || cur.haUrl || '').trim(),
      token: ((body && body.token) || cur.token || '').trim(),
    });
    let test = { ok: false, error: '' };
    const c = core.getConfig();
    if (c.haUrl && c.token) {
      try { test = Object.assign({ ok: true }, await testConnection()); }
      catch (e) { test = { ok: false, error: String(e.message || e) }; }
    }
    return reply(res, 200, { saved: true, test });
  }
  if (p === '/api/config/test' && req.method === 'POST') {
    try { return reply(res, 200, await testConnection()); }
    catch (e) { return reply(res, 200, { ok: false, error: String(e.message || e) }); }
  }
  return false;
}

/* ---------------- 域 3：资产目录 / 参考底图 / 插件清单 ---------------- */
async function handleAssets(req, res, p) {
  /* 2D 参考底图：上传（JSON dataURL）/ 读取 */
  if (p === '/api/upload' && req.method === 'POST') {
    const body = await readBody(req);
    try { return reply(res, 200, saveRefImg(body && body.data)); }
    catch (e) { return reply(res, e.status || 500, { error: String(e.message || e) }); }
  }
  if (p === '/api/refimg' && req.method === 'GET') { serveRefImg(res); return true; }

  /* 资产目录（家具/模型库）：assets + custom 合并，custom 覆盖内置。
   * types = 家具分类枚举（唯一出处 assets/catalog.json 的 types），前端页签直接用它。 */
  if (p === '/api/catalog' && req.method === 'GET') {
    return reply(res, 200, { items: buildCatalog(), types: catalogTypeDefs() });
  }
  /* 插件清单（assets/plugins 与 custom/plugins 下的 plugin.json；同目录名自定义覆盖内置） */
  if (p === '/api/plugins' && req.method === 'GET') {
    return reply(res, 200, { plugins: listPlugins() });
  }
  return false;
}

/* ---------------- 域 4：安装密钥 / 远程安装 / 编辑页导入 ---------------- */
async function handleInstall(req, res, u, p) {
  /* 远程安装设置：不返回密钥明文，只回是否已设置 + 末 4 位，便于确认填对了。 */
  if (p === '/api/install/config' && req.method === 'GET') {
    const key = core.installKey();
    return reply(res, 200, {
      hasKey: !!key,
      keyTail: key ? key.slice(-4) : '',
      locked: core.installKeyLocked(),   // true = 由环境变量 HA3D_INSTALL_KEY 接管，页面不可改
    });
  }
  if (p === '/api/install/config' && req.method === 'POST') {
    if (core.installKeyLocked()) return reply(res, 409, { error: '安装密钥已由环境变量 HA3D_INSTALL_KEY 设置，页面不能修改' });
    const body = await readBody(req);
    const key = String((body && body.key) || '').trim();
    /* 会作为 HTTP 头 X-Install-Key 传输 → 限定可见 ASCII，长度给足随机空间 */
    if (!/^[A-Za-z0-9_.:@-]{6,128}$/.test(key)) {
      return reply(res, 400, { error: '安装密钥需 6–128 位，仅限字母、数字与 _ . : @ -' });
    }
    core.setInstallKey(key);
    return reply(res, 200, { saved: true, keyTail: key.slice(-4) });
  }
  /* 生成新密钥：由用户在页面里主动点击触发，明文只在这一个响应里返回一次，
   * 供「导入插件」弹窗展示复制；旧密钥随即失效。 */
  if (p === '/api/install/config/generate' && req.method === 'POST') {
    if (core.installKeyLocked()) return reply(res, 409, { error: '安装密钥已由环境变量 HA3D_INSTALL_KEY 设置，不能重新生成' });
    const key = 'hk_' + crypto.randomBytes(12).toString('base64url');
    core.setInstallKey(key);
    log('[ha-3d-home] 已生成新的插件安装密钥（旧密钥失效）');
    return reply(res, 200, { key, keyTail: key.slice(-4) });
  }

  /* ---- 远程安装：POST /api/plugins/install?id=<项目id>&version=<v> ----
   * 请求体 = studio 打的 zip 原始字节，按包内清单 kind 自动分流：
   *   插件包（plugin.json + plugin.js + models/*.glb）→ custom/plugins/<id>/
   *   家具包（item.json + 多个平铺 .glb）→ custom/models/<项目id>/（包内 id 必须与 ?id 一致）
   * 头 X-Install-Key 校验密钥。已存在则整体替换 —— 重复发布同一项目就是原地覆盖升级。 */
  if (p === '/api/plugins/install' && req.method === 'POST') {
    const needKey = core.installKey();
    if (!needKey) {
      return reply(res, 401, {
        error: '未配置安装密钥：请在本站「连接与服务」里设置安装密钥，或设置环境变量 HA3D_INSTALL_KEY',
      });
    }
    if (String(req.headers['x-install-key'] || '') !== needKey) {
      return reply(res, 401, { error: '安装密钥不正确（X-Install-Key 与本站设置不一致）' });
    }

    const qid = String(u.searchParams.get('id') || '').trim();
    const hid = String(req.headers['x-plugin-id'] || '').trim();
    if (qid && hid && qid !== hid) return reply(res, 400, { error: '查询参数 id 与 X-Plugin-Id 不一致' });
    const id = qid || hid;
    if (!id) return reply(res, 400, { error: '缺少插件 id（?id= 或 X-Plugin-Id）' });
    if (!PLUGIN_ID_RE.test(id)) {
      return reply(res, 400, { error: '插件 id 不合法：小写字母开头，字母/数字/_ . -，最长 64' });
    }

    let zipBuf;
    try { zipBuf = await readRawBody(req, INSTALL_MAX_BYTES); }
    catch (e) { return reply(res, 413, { error: e.message }); }
    try {
      return reply(res, 200, await installPackage(zipBuf, id));
    } catch (e) { return reply(res, e.status || 500, { error: e.message }); }
  }

  /* ---- 编辑页「导入插件」：本站 UI 直接上传 zip，id 从包内清单读取，无需密钥 ----
   * 一个入口收两种包，按清单 kind 自动识别，与远程 install 走同一套解包/校验/落盘逻辑。 */
  if (p === '/api/plugins/import' && req.method === 'POST') {
    let zipBuf;
    try { zipBuf = await readRawBody(req, INSTALL_MAX_BYTES); }
    catch (e) { return reply(res, 413, { error: e.message }); }
    try {
      return reply(res, 200, await installPackage(zipBuf, null));
    } catch (e) { return reply(res, e.status || 500, { error: e.message }); }
  }
  return false;
}

/* ---------------- 域 5：户型项目 / 旋转锚点 / 房屋尺寸 ---------------- */
async function handleProject(req, res, p) {
  /* 户型项目持久化（唯一一份，编辑器自动保存覆盖） */
  if (p === '/api/project' && req.method === 'GET') {
    return reply(res, 200, core.loadProject());
  }
  if (p === '/api/project' && (req.method === 'POST' || req.method === 'PUT')) {
    const body = await readBody(req);
    const proj = core.normProject(body);
    if (!proj) return reply(res, 400, { error: '项目数据不合法：需要 { name, floors: [{ name, walls/doors/windows/furniture/devices }] }' });
    return reply(res, 200, core.saveProject(proj));
  }

  /* 旋转锚点（大屏页长按设锚点 / 重置）：只改 settings.anchors 一个字段。
   * 单独开接口而不复用 POST /api/project —— 大屏页的项目是启动快照，整份提交
   * 会覆盖编辑页之后保存的户型；这里由服务端读最新文件做局部合并。 */
  if (p === '/api/anchor' && req.method === 'GET') {
    return reply(res, 200, { anchors: core.loadAnchors() });
  }
  if (p === '/api/anchor' && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await readBody(req);
    const anchors = core.saveAnchor(body);
    if (!anchors) return reply(res, 400, { error: '锚点数据不合法：需要 { floor, mode:"center"|"custom", x, y, z }' });
    return reply(res, 200, { ok: true, anchors });
  }

  /* 户型长宽（背景插件构图参考）：按各楼层墙体现算「最大的那层」——
   * 逐维取所有楼层的最大长/宽（保证占位盒能容纳任何一层的户型）。
   * 现算不出有效值（老数据/无墙）再回退 project.json 里保存的 houseW/houseD。 */
  if (p === '/api/house/size' && req.method === 'GET') {
    const proj = core.loadProject();
    let w = 0, d = 0;
    ((proj && proj.floors) || []).forEach((fl) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      ((fl && fl.walls) || []).forEach((wt) => {
        if (![wt.x1, wt.x2, wt.y1, wt.y2].every((n) => typeof n === 'number' && isFinite(n))) return;
        x0 = Math.min(x0, wt.x1, wt.x2); x1 = Math.max(x1, wt.x1, wt.x2);
        y0 = Math.min(y0, wt.y1, wt.y2); y1 = Math.max(y1, wt.y1, wt.y2);
      });
      if (x1 > x0 && y1 > y0) { w = Math.max(w, x1 - x0); d = Math.max(d, y1 - y0); }
    });
    w = Math.round(w * 10) / 10;
    d = Math.round(d * 10) / 10;
    if (!(w > 0) || !(d > 0)) { w = Number(proj && proj.houseW); d = Number(proj && proj.houseD); }
    const ok = w > 0 && d > 0;
    return reply(res, 200, { ok, houseW: ok ? w : null, houseD: ok ? d : null });
  }
  return false;
}

/* ---------------- 路由总入口 ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    if (await handleSystem(req, res, p)) return;
    if (await handleConfig(req, res, p)) return;
    if (await handleAssets(req, res, p)) return;
    if (await handleInstall(req, res, u, p)) return;
    if (await handleProject(req, res, p)) return;

    /* 其余为静态文件（public / assets / custom） */
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, u);
  } catch (e) {
    logErr('[ha-3d-home] 请求处理异常:', e && e.stack || e);
    /* 请求体超限等带 status 的错误按原状态码回，其余才是 500 */
    sendJSON(res, e.status || 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log('[ha-3d-home] listening on 0.0.0.0:' + PORT + '  data=' + DATA_DIR + '  assets=' + ASSET_DIR + '  custom=' + CUSTOM_DIR + (IS_PROD ? '  mode=production(quiet)' : ''));
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
