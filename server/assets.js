/*
 * 资源层：HTTP 小工具（JSON 响应/请求体读取/静态托管）+ 家具目录合并 + 2D 参考底图。
 * 三者都和「文件怎么发出去」有关，放一起便于一处调整缓存与路径规则。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ASSET_DIR, CUSTOM_DIR, PUBLIC_DIR, DATA_DIR, IS_PROD } = require('./core');
const { scanImportedItems, catalogTypes } = require('./catalog-import');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};

/* ---------------- HTTP 小工具 ---------------- */
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/* 读 JSON 请求体（解析失败回 null，由调用端判断） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 20 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve(null); }
    });
    req.on('error', reject);
  });
}

/* 读原始字节（上传 zip 用：要的就是二进制，不能走 JSON 解析）。
 * 超限后不再缓存数据但继续读流，保证还能回一个正常的 JSON 错误。 */
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return reject(new Error('安装包过大（上限 ' + Math.round(limit / 1048576) + 'MB）'));
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/* 静态文件托管（public / assets / custom 三个根目录）。
 * 缓存策略:
 *   1. 带 ?v= 版本号（js/css，前端改动必升版本号）→ 一年长缓存 immutable，不再请求
 *   2. 其余静态资源（内置/自定义模型、插件 GLB、图片等）→ no-cache + ETag 协商:
 *      浏览器持有副本，每次只发 If-None-Match 轻量校验，文件未变回 304（不重传）；
 *      文件一变（mtime/size）ETag 自动失效，无需手工升版本
 *   3. HTML / API / 动态数据 → 不缓存，改动即时生效 */
function serveStatic(req, res, u) {
  const p = u.pathname;
  let file = p === '/' ? '/index.html' : p === '/display' || p === '/display/' ? '/display.html' : p;
  try { file = decodeURIComponent(file); } catch (e) { /* 非法编码按原样处理 */ }
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');

  let baseDir = PUBLIC_DIR;
  let full = path.join(baseDir, file);
  if (file.startsWith('/assets/')) {
    baseDir = ASSET_DIR;
    full = path.join(baseDir, file.slice('/assets/'.length));
  }
  if (file.startsWith('/custom/')) {   // 用户自定义资产（Docker 单独挂载卷）
    baseDir = CUSTOM_DIR;
    full = path.join(baseDir, file.slice('/custom/'.length));
  }
  // 目录逃逸校验: 必须落回 baseDir 本身或它的子路径（带分隔符，防止 /customX 这类同前缀兄弟目录）
  if (full !== baseDir && !full.startsWith(baseDir + path.sep)) { res.writeHead(403); return res.end(); }

  fs.stat(full, (serr, st) => {
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
      const ext = path.extname(full).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      if (u.searchParams.has('v')) {
        headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      } else if (!serr && st) {
        const etag = 'W/"' + st.size + '-' + Number(st.mtimeMs) + '"';
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
          return res.end();
        }
        headers['Cache-Control'] = 'no-cache';
        headers['ETag'] = etag;
      } else {
        headers['Cache-Control'] = 'no-cache';
      }
      let body = buf;
      // 生产模式: 关闭前端调试日志（plugins.js / ha.js 读取 window.__HA_DBG）
      if (IS_PROD && ext === '.html') {
        body = Buffer.from(buf.toString('utf8').replace('</head>', '<script>window.__HA_DBG=false;</script></head>'), 'utf8');
      }
      res.writeHead(200, headers);
      res.end(body);
    });
  });
}

/* ---------------- 家具/模型目录合并 ----------------
 * 优先级（同 id 后者覆盖前者）:
 *   assets/catalog.json → custom/catalog.json → assets/models/*.glb
 *   → custom/models/*.glb（旧的平铺方式，仍支持）
 *   → custom/models/<id>/（导入的家具包：一个项目一个目录，item.json + 多个 glb）
 * 清单里没声明的 glb 也会被自动发现（auto: true，尺寸给通用默认值）。
 * 设备造型（styles）不在这里 —— 那些由插件在启动时注册到前端插件引擎。 */
function readCatalogItems(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
    return (Array.isArray(d) ? d : (Array.isArray(d.items) ? d.items : [])).map((x) => Object.assign({}, x));
  } catch (e) { return []; }
}
function autoItem(id, url) {
  return { id, name: id, w: 0.8, d: 0.8, h: 0.6, color: '#9aa7b8', model: url, auto: true };
}
function buildCatalog() {
  const byId = new Map();
  const addItem = (x) => { const id = x.id || x.type; if (id) byId.set(String(id), x); };

  readCatalogItems(ASSET_DIR).forEach(addItem);
  /* 自定义清单覆盖内置同名条目；custom=true 供前端显示「自定义」角标 */
  readCatalogItems(CUSTOM_DIR).forEach((x) => addItem(Object.assign({}, x, { custom: true })));

  /* 内置 models 扫描（清单未声明的自动发现） */
  try {
    for (const f of fs.readdirSync(path.join(ASSET_DIR, 'models'))) {
      if (!f.toLowerCase().endsWith('.glb')) continue;
      const id = f.slice(0, -4);
      if (byId.has(id)) continue;
      byId.set(id, autoItem(id, '/assets/models/' + encodeURIComponent(f)));
    }
  } catch (e) { /* ignore */ }

  /* 自定义 models 扫描：同 id → 只替换模型文件（不动清单）；新 id → 自动发现 */
  try {
    for (const f of fs.readdirSync(path.join(CUSTOM_DIR, 'models'))) {
      if (!f.toLowerCase().endsWith('.glb')) continue;
      const id = f.slice(0, -4);
      const url = '/custom/models/' + encodeURIComponent(f);
      if (byId.has(id)) { const it = byId.get(id); it.model = url; it.custom = true; }
      else byId.set(id, Object.assign(autoItem(id, url), { custom: true }));
    }
  } catch (e) { /* ignore */ }

  /* 导入的家具包（custom/models/<项目id>/ 一目录一个项目、内含多件）放最后 = 优先级最高：
   * 整条条目来自包内 item.json，同一条目 id（<项目id>:<包内 id>）覆盖前面所有来源 */
  for (const item of scanImportedItems()) byId.set(item.id, item);

  /* type 收口：清单里的 type 必须命中 assets/catalog.json 的 types，否则统一归 other ——
   * 让 /api/catalog 的 items 与同一响应里的 types 自洽（前端拿到的一定是合法枚举值）。
   * 导入包在安装时就严格校验过了（缺失/超出直接拒绝），这里管的是手写的
   * custom/catalog.json 和自动发现的 glb（autoItem 本来不带 type）。 */
  const known = new Set(catalogTypes());
  const items = Array.from(byId.values());
  for (const it of items) {
    const t = String(it.type == null ? '' : it.type).trim().toLowerCase();
    it.type = (known.size && known.has(t)) ? t : 'other';
  }
  return items;
}

/* ---------------- 2D 参考底图 ----------------
 * 编辑器里铺在平面图下面的户型照片；整站唯一由用户上传的图片文件。
 * 存 data/refimg.<ext>（随 /data 卷持久化），每次上传覆盖旧图、换后缀时清掉旧文件。 */
const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg' };
function saveRefImg(dataUrl) {
  const data = typeof dataUrl === 'string' ? dataUrl : '';
  const mm = data.match(/^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/);
  if (!mm) throw Object.assign(new Error('仅支持 png / jpg / webp / svg 图片'), { status: 400 });
  const ext = EXT_BY_MIME[mm[1]];
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (/^refimg\./.test(f) && f !== 'refimg' + ext) fs.unlinkSync(path.join(DATA_DIR, f));
    }
  } catch (e) { /* 目录读不到就跳过清理 */ }
  fs.writeFileSync(path.join(DATA_DIR, 'refimg' + ext), Buffer.from(mm[2], 'base64'));
  return { url: '/api/refimg' };
}
function serveRefImg(res) {
  for (const ext of ['.png', '.jpg', '.webp', '.svg']) {
    try {
      const buf = fs.readFileSync(path.join(DATA_DIR, 'refimg' + ext));
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(buf);
    } catch (e) { /* 试下一个后缀 */ }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end('404 Not Found');
}

module.exports = {
  MIME, sendJSON, readBody, readRawBody, serveStatic,
  buildCatalog, saveRefImg, serveRefImg,
};
