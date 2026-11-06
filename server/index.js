/*
 * HA 3D Home — 轻量后端入口
 *
 * 职责：静态托管前端 + 连接配置/户型项目 JSON 持久化 + HA REST 兜底代理 + 插件安装。
 * 实时状态由浏览器直连 Home Assistant WebSocket（不受 CORS 限制），本服务不做实时转发。
 *
 * 零 npm 依赖（package.json 的 dependencies 为空），只用 Node 内置模块；
 * 服务端实现拆在 server/ 下的三个模块，本文件（服务端入口）只负责「启动 + 路由表 + HA 代理」：
 *   server/core.js     目录常量、运行模式、日志、data/*.json 持久化（含安装密钥）
 *   server/assets.js   HTTP 小工具、静态托管与缓存、家具目录合并、2D 参考底图
 *   server/plugins.js  插件清单扫描 + zip 安装（自带最小 zip 解析）
 *
 * 内存占用目标: < 50MB
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const core = require('./core');
const { sendJSON, readBody, readRawBody, serveStatic, buildCatalog, saveRefImg, serveRefImg } = require('./assets');
const { INSTALL_MAX_BYTES, PLUGIN_ID_RE, listPlugins, installPluginZip } = require('./plugins');

const { DATA_DIR, ASSET_DIR, CUSTOM_DIR, IS_PROD, log, logErr } = core;
const PORT = parseInt(process.env.PORT || '8077', 10);

core.ensureDirs();

/* ---------------- HA REST 兜底代理 ----------------
 * 前端默认直连 HA WebSocket，这里只在直连不可用时兜底，以及「测试连接」按钮用。 */
function haBase() { return (core.getConfig().haUrl || '').replace(/\/+$/, ''); }

function haRequest(apiPath, method, body) {
  return new Promise((resolve, reject) => {
    const base = haBase();
    if (!base) return reject(new Error('未配置 Home Assistant 地址'));
    let url;
    try { url = new URL(base + apiPath); } catch (e) { return reject(new Error('HA 地址无效')); }
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const req = mod.request(url, {
      method: method || 'GET',
      headers: {
        'Authorization': 'Bearer ' + core.getConfig().token,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = text;
        try { data = JSON.parse(text); } catch (e) { /* keep text */ }
        if (res.statusCode >= 400) return reject(Object.assign(new Error('HA 返回 ' + res.statusCode), { status: res.statusCode }));
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求 HA 超时')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function testConnection() {
  const conf = await haRequest('/api/config', 'GET');
  return { ok: true, version: conf.version, location_name: conf.location_name };
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    if (p === '/api/health') {
      const mem = process.memoryUsage().rss;
      return sendJSON(res, 200, { ok: true, uptime: Math.round(process.uptime()), memMB: Math.round(mem / 1048576 * 10) / 10 });
    }

    /* 连接配置。注意：令牌会下发给前端用于直连 HA WebSocket，仅建议内网使用。 */
    if (p === '/api/config' && req.method === 'GET') {
      const c = core.getConfig();
      return sendJSON(res, 200, { haUrl: c.haUrl, token: c.token || '', hasToken: !!c.token });
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
      return sendJSON(res, 200, { saved: true, test });
    }
    if (p === '/api/config/test' && req.method === 'POST') {
      try { return sendJSON(res, 200, await testConnection()); }
      catch (e) { return sendJSON(res, 200, { ok: false, error: String(e.message || e) }); }
    }

    /* REST 兜底代理（前端默认走直连 WebSocket，这里仅作备用） */
    if (p === '/api/states' && req.method === 'GET') {
      try { return sendJSON(res, 200, await haRequest('/api/states', 'GET')); }
      catch (e) { return sendJSON(res, e.status || 502, { error: String(e.message || e) }); }
    }
    const m = p.match(/^\/api\/services\/([^/]+)\/([^/]+)$/);
    if (m && req.method === 'POST') {
      const body = await readBody(req);
      try { return sendJSON(res, 200, await haRequest('/api/services/' + m[1] + '/' + m[2], 'POST', body || {})); }
      catch (e) { return sendJSON(res, e.status || 502, { error: String(e.message || e) }); }
    }

    /* 2D 参考底图：上传（JSON dataURL）/ 读取 */
    if (p === '/api/upload' && req.method === 'POST') {
      const body = await readBody(req);
      try { return sendJSON(res, 200, saveRefImg(body && body.data)); }
      catch (e) { return sendJSON(res, e.status || 500, { error: String(e.message || e) }); }
    }
    if (p === '/api/refimg' && req.method === 'GET') return serveRefImg(res);

    /* 资产目录（家具/模型库）：assets + custom 合并，custom 覆盖内置 */
    if (p === '/api/catalog' && req.method === 'GET') {
      return sendJSON(res, 200, { items: buildCatalog() });
    }

    /* 插件清单（assets/plugins 与 custom/plugins 下的 plugin.json；同目录名自定义覆盖内置） */
    if (p === '/api/plugins' && req.method === 'GET') {
      return sendJSON(res, 200, { plugins: listPlugins() });
    }

    /* ---- 远程安装设置：安装密钥（studio 发布插件时填同一个） ----
     * 不返回密钥明文，只回是否已设置 + 末 4 位，便于确认填对了。 */
    if (p === '/api/install/config' && req.method === 'GET') {
      const key = core.installKey();
      return sendJSON(res, 200, {
        hasKey: !!key,
        keyTail: key ? key.slice(-4) : '',
        locked: core.installKeyLocked(),   // true = 由环境变量 HA3D_INSTALL_KEY 接管，页面不可改
      });
    }
    if (p === '/api/install/config' && req.method === 'POST') {
      if (core.installKeyLocked()) return sendJSON(res, 409, { error: '安装密钥已由环境变量 HA3D_INSTALL_KEY 设置，页面不能修改' });
      const body = await readBody(req);
      const key = String((body && body.key) || '').trim();
      /* 会作为 HTTP 头 X-Install-Key 传输 → 限定可见 ASCII，长度给足随机空间 */
      if (!/^[A-Za-z0-9_.:@-]{6,128}$/.test(key)) {
        return sendJSON(res, 400, { error: '安装密钥需 6–128 位，仅限字母、数字与 _ . : @ -' });
      }
      core.setInstallKey(key);
      return sendJSON(res, 200, { saved: true, keyTail: key.slice(-4) });
    }
    /* 生成新密钥：由用户在页面里主动点击触发，明文只在这一个响应里返回一次，
     * 供「导入插件」弹窗展示复制；旧密钥随即失效。 */
    if (p === '/api/install/config/generate' && req.method === 'POST') {
      if (core.installKeyLocked()) return sendJSON(res, 409, { error: '安装密钥已由环境变量 HA3D_INSTALL_KEY 设置，不能重新生成' });
      const key = 'hk_' + crypto.randomBytes(12).toString('base64url');
      core.setInstallKey(key);
      log('[ha-3d-home] 已生成新的插件安装密钥（旧密钥失效）');
      return sendJSON(res, 200, { key, keyTail: key.slice(-4) });
    }

    /* ---- 远程安装插件：POST /api/plugins/install?id=<插件id>&version=<v> ----
     * 请求体 = studio 打的 zip 原始字节（plugin.json + plugin.js + models/*.glb，无顶层目录）,
     * 头 X-Install-Key 校验密钥。解压到 custom/plugins/<id>/，已存在则整体替换 ——
     * 所以重复发布同一项目就是原地覆盖升级（目录名 = id = 项目 id）。
     * 成功 200 { ok, id, version, files, upgraded }；失败非 2xx + { error }。 */
    if (p === '/api/plugins/install' && req.method === 'POST') {
      const needKey = core.installKey();
      if (!needKey) {
        return sendJSON(res, 401, {
          error: '未配置安装密钥：请在本站「连接与服务」里设置安装密钥，或设置环境变量 HA3D_INSTALL_KEY',
        });
      }
      if (String(req.headers['x-install-key'] || '') !== needKey) {
        return sendJSON(res, 401, { error: '安装密钥不正确（X-Install-Key 与本站设置不一致）' });
      }

      const qid = String(u.searchParams.get('id') || '').trim();
      const hid = String(req.headers['x-plugin-id'] || '').trim();
      if (qid && hid && qid !== hid) return sendJSON(res, 400, { error: '查询参数 id 与 X-Plugin-Id 不一致' });
      const id = qid || hid;
      if (!id) return sendJSON(res, 400, { error: '缺少插件 id（?id= 或 X-Plugin-Id）' });
      if (!PLUGIN_ID_RE.test(id)) {
        return sendJSON(res, 400, { error: '插件 id 不合法：小写字母开头，字母/数字/_ . -，最长 64' });
      }

      let zipBuf;
      try { zipBuf = await readRawBody(req, INSTALL_MAX_BYTES); }
      catch (e) { return sendJSON(res, 413, { error: e.message }); }
      try {
        return sendJSON(res, 200, await installPluginZip(zipBuf, id));
      } catch (e) { return sendJSON(res, e.status || 500, { error: e.message }); }
    }

    /* ---- 编辑页「导入插件」：本站 UI 直接上传 zip，id 从包内 plugin.json 读取，无需密钥 ----
     * 与 install 走同一套解包/校验/落盘逻辑（installPluginZip）。 */
    if (p === '/api/plugins/import' && req.method === 'POST') {
      let zipBuf;
      try { zipBuf = await readRawBody(req, INSTALL_MAX_BYTES); }
      catch (e) { return sendJSON(res, 413, { error: e.message }); }
      try {
        return sendJSON(res, 200, await installPluginZip(zipBuf, null));
      } catch (e) { return sendJSON(res, e.status || 500, { error: e.message }); }
    }

    /* 户型项目持久化（唯一一份，编辑器自动保存覆盖） */
    if (p === '/api/project' && req.method === 'GET') {
      return sendJSON(res, 200, core.loadProject());
    }
    if (p === '/api/project' && (req.method === 'POST' || req.method === 'PUT')) {
      const body = await readBody(req);
      const proj = core.normProject(body);
      if (!proj) return sendJSON(res, 400, { error: '项目数据不合法：需要 { name, floors: [{ name, walls/doors/windows/furniture/devices }] }' });
      return sendJSON(res, 200, core.saveProject(proj));
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
      return sendJSON(res, 200, { ok, houseW: ok ? w : null, houseD: ok ? d : null });
    }

    /* 其余为静态文件（public / assets / custom） */
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, u);
  } catch (e) {
    logErr('[ha-3d-home] 请求处理异常:', e && e.stack || e);
    sendJSON(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log('[ha-3d-home] listening on 0.0.0.0:' + PORT + '  data=' + DATA_DIR + '  assets=' + ASSET_DIR + '  custom=' + CUSTOM_DIR + (IS_PROD ? '  mode=production(quiet)' : ''));
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
