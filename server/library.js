'use strict';
/*
 * 共用能力层（被 assets 域与 install 域共用；原 4 个模块的内容原样消化进来）。
 *   · 静态托管与缓存 / 家具目录 / 2D 底图   ← 原 assets.js
 *   · 家具包解析、安装、目录扫描            ← 原 catalog-import.js
 *   · 插件清单扫描 + zip 安装（含最小解压） ← 原 plugins.js
 *   · 安装包落盘的原子替换                  ← 原 atomic-dir.js
 * 同文件内互相调用直接走本地函数，不再跨模块 require；函数体逐字保留。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { ASSET_DIR, CUSTOM_DIR, PUBLIC_DIR, DATA_DIR, IS_PROD, log } = require('./shared');

/* ===== 原 atomic-dir.js：安装包落盘的公共原子替换 ===== */
/*
 * 安装包落盘的公共原子替换。
 *
 * 插件包（custom/plugins/<id>）与家具包（custom/models/<id>）原本各写了一遍同样的
 * 「写临时目录 → 旧目录改名备份 → 新目录上位 → 失败回滚 → 清 tmp」，两份还不一致：
 * 插件版把删备份放在 try 内，删失败会误报 500，但实际已经升级成功。
 * 这里收口成一份，两个安装流程只负责把文件写进 tmp 目录。
 *
 * 零 npm 依赖（只用 Node 内置模块）。
 */


/* writeFn(tmpDir) 里写完所有文件。成功返回 { upgraded }；
 * 任何一步失败都清理临时目录并回滚旧版本，抛带 status:500 的 Error 给路由。 */
function atomicDirReplace(parentDir, id, writeFn, label) {
  fs.mkdirSync(parentDir, { recursive: true });
  const target = path.join(parentDir, id);
  /* 同一毫秒并发安装同一 id 时别撞临时目录名 */
  const stamp = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const tmp = path.join(parentDir, '.install-' + id + '-' + stamp);
  const backup = path.join(parentDir, '.old-' + id + '-' + stamp);
  let upgraded = false;
  try {
    writeFn(tmp);
    upgraded = fs.existsSync(target);
    if (upgraded) fs.renameSync(target, backup);          // 旧版本先挪开
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      if (upgraded) fs.renameSync(backup, target);        // 上位失败：把旧版本放回去
      throw e;
    }
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    throw Object.assign(new Error('写入' + label + '目录失败: ' + e.message), { status: 500 });
  }
  /* 删备份失败不影响「已经升级成功」这个事实，不能因此报 500 */
  if (upgraded) {
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  return { upgraded };
}

/* ===== 原 catalog-import.js：家具包解析 / 安装 / 目录扫描 ===== */
/*
 * 家具包（kind: "catalog"）: 包清单解析 + 安装 + 目录扫描。
 *
 * 一个家具包 = studio 里的一个「家具项目」，整包装到 custom/models/<项目id>/：
 *   custom/models/<项目id>/
 *   ├── item.json     包清单：kind:"catalog" + id(项目id) + items[]（每个 glb 一条）
 *   └── <模型>.glb    1..N 个，与 item.json 平铺（包内不再按家具分子目录）
 *
 * item.json:
 * {
 *   "kind": "catalog",                 必填
 *   "id": "p_r7k2m9q1",                项目随机 id = 安装目录名；同 id 重复导入 = 整体覆盖升级
 *   "name": "客厅套装",                 可选，包名（导入成功提示里显示）
 *   "version": "1.0.0",                可选，条目没写 version 时继承
 *   "items": [
 *     { "id": "sofa",                  包内条目 id（包内唯一即可）
 *       "name": "三人沙发",
 *       "type": "sofa",                必填，命中 assets/catalog.json 的 types
 *       "w": 2.1, "d": 0.9, "h": 0.8,
 *       "color": "#9aa7b8",
 *       "model": "sofa.glb",           包内文件名；包里只有一个 glb 时可省
 *       "icon": "<rect …/>",           可选，2D 平面图标
 *       "scale": 1 }                   可选，模型额外缩放
 *   ]
 * }
 *
 * 目录条目 id（catalog 里的唯一键）= "<项目id>:<包内 id>"：包内 id 只要求包内唯一，
 * 所以两个包都写 sofa 也不会互相顶掉。sid 保留包内原始 id，排查时能对上 item.json。
 *
 * 老格式（一件家具一个目录、目录里放自己的 json + glb）继续可读：按「单条」解析，
 * 目录名直接当条目 id（已摆在户型里的 mid 不会因为这次改格式而失效）。
 */


/* 目录名 = 项目 id：小写字母/数字开头，字母/数字/_ . -，最长 64 */
const PACK_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/* 包内条目 id：同上但不允许冒号（冒号是「项目id:条目id」的分隔符） */
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const KEY_SEP = ':';

/* ---------------- 家具分类枚举（唯一出处：assets/catalog.json 的 types） ----------------
 * 前后端只有这一份定义：服务端用它校验家具包的 type，前端（public/js/catalog.js）通过
 * /api/catalog 的 types 字段拿到同一份数据生成家具库页签，所以这里不再硬编码类型列表。
 * 加一个分类 = 改 assets/catalog.json 的 types 一行，两端同时生效，不需要改代码。
 * type 是必填项且必须命中 types：写错/写漏一律拒绝导入。 */
const CATALOG_JSON = path.join(ASSET_DIR, 'catalog.json');

let typeCache = { mtime: -1, list: [] };

/* 读 types（按 mtime 缓存：改完文件不必重启服务，下次导入/请求即生效） */
function catalogTypeDefs() {
  let st;
  try { st = fs.statSync(CATALOG_JSON); }
  catch (e) { typeCache = { mtime: -1, list: [] }; return typeCache.list; }
  if (st.mtimeMs === typeCache.mtime) return typeCache.list;

  let raw = [];
  try {
    const d = JSON.parse(fs.readFileSync(CATALOG_JSON, 'utf8'));
    raw = Array.isArray(d && d.types) ? d.types : [];
  } catch (e) {
    /* 清单坏掉时保留上一次的缓存（没有缓存就是空表，导入会明确报「类型定义缺失」） */
    return typeCache.list;
  }
  const list = [];
  const seen = new Set();
  for (const t of raw) {
    /* 允许两种写法: "sofa" 或 { type:"sofa", name:"沙发/座椅" } */
    const type = String((t && t.type) || t || '').trim().toLowerCase();
    if (!type || seen.has(type)) continue;
    seen.add(type);
    list.push({ type, name: String((t && t.name) || type) });
  }
  typeCache = { mtime: st.mtimeMs, list };
  return list;
}

/* 类型键列表（校验用），如 ['sofa','bed',…,'other'] */
function catalogTypes() { return catalogTypeDefs().map((t) => t.type); }

function bad(msg, status) { throw Object.assign(new Error(msg), { status: status || 400 }); }

function basename(n) { return String(n).replace(/\\/g, '/').split('/').pop(); }

/* 目录条目唯一键：<项目id>:<包内 id> */
function itemKey(packId, sid) { return packId + KEY_SEP + sid; }

/* ---------- 单条条目解析 ---------- */
/* 把 items 里的一条归一成 catalog 条目（不含安装位置/模型地址）:
 * { sid, name, type, w, d, h, color, icon?, scale?, version? }
 * label = 报错时指路用的位置（如 items[2]）；fallbackId 只在读老格式目录时用（= 目录名） */
function parseItem(raw, label, fallbackId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('清单条目必须是对象: ' + label);
  const sid = String(raw.id || fallbackId || '').trim();
  if (!ITEM_ID_RE.test(sid)) {
    bad(label + ' 的 id 缺失或不合法（字母或数字开头，只能含字母/数字/_ . -，最长 64）: ' + (sid || '(空)'));
  }
  const name = String(raw.name || '').trim();
  if (!name) bad(label + ' 缺少 name（家具显示名）: ' + sid);
  const w = Number(raw.w);
  const d = Number(raw.d);
  if (!(w > 0) || !(d > 0)) bad(label + ' 的 w / d 必须是正数（单位米）: ' + sid);
  const item = { sid, name, w, d };
  item.h = Number(raw.h) > 0 ? Number(raw.h) : 0.6;
  /* type 必填且必须命中枚举（大小写不敏感，存小写规范值）:
   * 之前「缺省给 deco、野值原样保留」会让 /api/catalog 出现无穷多种 type，页签与「同类模型」跟着失控 */
  const types = catalogTypes();
  if (!types.length) {
    bad('家具类型定义缺失：assets/catalog.json 的 types 数组为空或文件损坏，无法校验 type: ' + sid, 500);
  }
  const type = String(raw.type == null ? '' : raw.type).trim().toLowerCase();
  if (!type) {
    bad(label + ' 缺少 type（必填）：只能是 ' + types.join(' / ') + '（不确定归哪类就写 other）: ' + sid);
  }
  if (types.indexOf(type) < 0) {
    bad(label + ' 的 type 不在支持列表（当前: ' + type + '）：只能是 ' + types.join(' / ') + ': ' + sid);
  }
  item.type = type;
  item.color = typeof raw.color === 'string' && raw.color.trim() ? raw.color.trim() : '#9aa7b8';
  if (typeof raw.icon === 'string' && raw.icon.trim()) item.icon = raw.icon.trim();
  if (Number(raw.scale) > 0) item.scale = Number(raw.scale);
  if (raw.version != null) item.version = String(raw.version);
  return item;
}

/* ---------- glb 选择 ---------- */
/* 在候选里挑清单要用的那个 glb:
 *   model 可以写文件名或相对路径 —— 只比文件名（大小写不敏感）；
 *   model 缺省时只有唯一候选才算数（多个就要求写清楚）。返回文件名或 null */
function chooseGlb(candidates, want) {
  const base = basename(want || '').trim();
  if (base) return candidates.find((f) => f.toLowerCase() === base.toLowerCase()) || null;
  return candidates.length === 1 ? candidates[0] : null;
}

/* ---------- 包清单解析 ---------- */
/* item.json → { id(项目id), name, version, items: [{ …parseItem, modelFile }] }
 * glbs = 包里可用的模型文件名（平铺，只比文件名）。
 * fallbackId 只给「读已有目录」用：包内没写 id 时用目录名兜底。 */
function parsePack(raw, opts) {
  const o = opts || {};
  const glbs = (o.glbs || []).map(basename);
  let packId = String(o.fallbackId || '').trim();
  let name = '';
  let version = '';
  let list = null;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    bad('item.json 内容不合法（应为对象：kind / id / items）');
  }
  const kind = String(raw.kind == null ? '' : raw.kind).trim().toLowerCase();
  if (kind !== 'catalog') {
    bad('item.json 的 kind 必须是 "catalog"（当前: ' + (kind || '未写') + '）');
  }
  if (raw.id != null && String(raw.id).trim()) packId = String(raw.id).trim();
  name = String(raw.name || '').trim();
  version = String(raw.version || '').trim();
  list = Array.isArray(raw.items) ? raw.items : null;

  if (!packId) {
    bad('item.json 缺少 id（项目随机 id）：它就是安装目录名 custom/models/<id>/，也是重复导入时覆盖的依据');
  }
  if (!PACK_ID_RE.test(packId)) {
    bad('item.json 的 id 不合法（小写字母或数字开头，只能含字母/数字/_ . -，最长 64）: ' + packId);
  }
  if (!Array.isArray(list) || !list.length) {
    bad('item.json 的 items 必须是数组且至少 1 条（每个 glb 模型一条）');
  }
  if (!glbs.length) {
    bad('家具包里没有 .glb 模型文件：item.json 与模型文件要平铺在包根目录');
  }

  const items = [];
  const seen = new Set();
  list.forEach((one, i) => {
    const label = 'items[' + i + ']';
    const it = parseItem(one, label);
    if (seen.has(it.sid)) {
      bad('items 里有重复的 id（' + it.sid + '）：同一个包内的条目 id 必须唯一');
    }
    seen.add(it.sid);
    const want = String((one && one.model) == null ? '' : one.model);
    const file = chooseGlb(glbs, want);
    if (!file) {
      const names = glbs.join('、');
      if (!want && glbs.length > 1) {
        bad(label + '（' + it.sid + '）没写 model：包里有 ' + glbs.length + ' 个模型，必须在 model 里指明用哪个（' + names + '）');
      }
      bad(label + '（' + it.sid + '）的 model 没匹配到包里的模型：' + (want || '(未写)') + '；包内有 ' + names);
    }
    if (!it.version && version) it.version = version;
    it.modelFile = file;
    items.push(it);
  });
  return { id: packId, name, version, items };
}

/* ---------- 目录读取（扫描用） ---------- */
/* 目录里的清单文件: item.json 优先 → <目录名>.json → 唯一的 *.json（都没有则 null） */
function pickJson(dir, dirName) {
  let names;
  try { names = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort(); }
  catch (e) { return null; }
  if (!names.length) return null;
  for (const pref of ['item.json', dirName + '.json']) {
    const hit = names.find((n) => n.toLowerCase() === pref.toLowerCase());
    if (hit) return hit;
  }
  return names[0];
}

function listGlb(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.glb$/i.test(f)).sort(); }
  catch (e) { return []; }
}

/* 跳过目录时只提示一次（/api/catalog 每次请求都会重扫，重复打印会刷屏） */
const warnedDirs = new Set();
function warnOnce(key, msg) {
  if (warnedDirs.has(key)) return;
  warnedDirs.add(key);
  log('[ha-3d-home] ' + msg);
}

/* 条目 → catalog 条目（补 id / 模型 URL / 包信息） */
function toCatalogItem(packId, it, modelBase) {
  const out = {
    id: it.id || itemKey(packId, it.sid),
    sid: it.sid, pack: packId,
    name: it.name, type: it.type, w: it.w, d: it.d, h: it.h, color: it.color,
  };
  if (it.icon) out.icon = it.icon;
  if (it.scale) out.scale = it.scale;
  if (it.version) out.version = it.version;
  /* 模型没找到也保留条目（3D 退回体块兜底，2D 照常能摆）：比整件家具从库里消失更好排查 */
  if (it.modelFile) out.model = modelBase + encodeURIComponent(it.modelFile);
  out.custom = true;
  return out;
}

/* 读一个家具目录 → 条目数组（0..N 条）；不合格返回空数组（坏清单不拖垮整张目录表） */
function readPackDir(dir, dirName) {
  const jsonFile = pickJson(dir, dirName);
  if (!jsonFile) return [];
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, jsonFile), 'utf8')); }
  catch (e) { return []; }
  const isPack = Array.isArray(raw) || (raw && typeof raw === 'object' && Array.isArray(raw.items));
  const glbs = listGlb(dir);
  const baseUrl = '/custom/models/' + encodeURIComponent(dirName) + '/';
  let list;
  /* 手工放进 custom/models/<id>/ 的目录也走同一套校验：type 非法 → 整件进不了目录，
   * 这里提示一次，免得「家具凭空消失了」无从排查 */
  try {
    if (isPack) {
      list = parsePack(raw, { fallbackId: dirName, glbs }).items.map((it) => toCatalogItem(dirName, it, baseUrl));
    } else {
      if (raw && raw.kind && String(raw.kind) !== 'catalog') return [];   // 放错目录的插件清单，不当作家具
      /* 老格式：一件家具一个目录，目录名就是条目 id（保持已摆放实例的 mid 不变） */
      const it = parseItem(raw, 'custom/models/' + dirName + '/', dirName);
      it.modelFile = chooseGlb(glbs, raw && raw.model);
      list = [toCatalogItem(dirName, Object.assign(it, { id: dirName }), baseUrl)];
    }
  } catch (e) {
    warnOnce(dirName + '|' + e.message, '跳过家具目录 custom/models/' + dirName + '/：' + e.message);
    return [];
  }
  return list;
}

/* 扫描所有导入的家具目录: custom/models/<id>/（跳过 .install-* / .old-* 这类临时目录） */
function scanImportedItems() {
  const base = path.join(CUSTOM_DIR, 'models');
  let ents;
  try { ents = fs.readdirSync(base, { withFileTypes: true }); }
  catch (e) { return []; }
  const out = [];
  for (const ent of ents) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    for (const item of readPackDir(path.join(base, ent.name), ent.name)) out.push(item);
  }
  return out;
}

/* ---------- 安装 ---------- */
/* files: Map<包内条目名, Buffer>（已做过路径归一化）
 * 结构：一个 item.json + 若干 .glb，平铺在包根目录（允许整体套一层目录 —— 直接把文件夹
 * 打成 zip 很常见，这里一律按文件名取，只要没有重名就不歧义）。
 * expectedId: 远程安装接口从 URL / X-Plugin-Id 拿到项目 id 时传入，必须与包内 id 一致
 * （安装目录按 id 定位，否则会把别人的家具项目顶掉）。
 * 成功返回 { ok, kind:'catalog', id(项目id), name, version, count, ids, items, upgraded, dir } */
function installCatalogPackage(files, expectedId) {
  const jsonEntries = [];
  const glbEntries = new Map();   // 小写文件名 → { base, data }
  for (const [name, data] of files) {
    const base = basename(name);
    if (/^item\.json$/i.test(base)) { jsonEntries.push({ name, data }); continue; }
    if (!/\.glb$/i.test(base)) {
      bad('家具包里有不认识的文件: ' + name + '（只允许一个 item.json + 若干 .glb 模型）');
    }
    if (glbEntries.has(base.toLowerCase())) {
      bad('家具包里有同名模型文件: ' + base + '（模型平铺在包根目录，文件名必须唯一）');
    }
    glbEntries.set(base.toLowerCase(), { base, data });
  }
  if (!jsonEntries.length) {
    bad('家具包缺少 item.json：包根目录要有一个 item.json 清单，与所有 .glb 模型平铺');
  }
  if (jsonEntries.length > 1) {
    bad('家具包里有多个 item.json: ' + jsonEntries.map((e) => e.name).join('、') + '（一个包只能有一个包清单）');
  }

  const jn = jsonEntries[0];
  let raw;
  try { raw = JSON.parse(jn.data.toString('utf8')); }
  catch (e) { bad(jn.name + ' 不是合法 JSON: ' + e.message); }
  const pack = parsePack(raw, { glbs: Array.from(glbEntries.values()).map((g) => g.base) });
  if (expectedId && pack.id !== expectedId) {
    bad('家具包 id（' + pack.id + '）与安装请求的 id（' + expectedId + '）不一致：'
      + '安装接口按 id 定位 custom/models/<id>/，请重新导出这个项目的家具包再发布');
  }

  /* 原子替换收敛在 atomic-dir.js（与插件包共用一套）；失败时错误自带 status，直接冒泡 */
  const { upgraded } = atomicDirReplace(path.join(CUSTOM_DIR, 'models'), pack.id, (tmp) => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'item.json'), jn.data);
    for (const g of glbEntries.values()) fs.writeFileSync(path.join(tmp, g.base), g.data);
  }, '家具');

  const baseUrl = '/custom/models/' + encodeURIComponent(pack.id) + '/';
  const items = pack.items.map((it) => toCatalogItem(pack.id, it, baseUrl));
  const ids = items.map((i) => i.id);
  const label = pack.name || pack.id;
  log('[ha-3d-home] 家具包已' + (upgraded ? '导入/覆盖' : '安装') + ':',
    label, '(' + pack.id + ')', '共', ids.length, '件');
  return {
    ok: true, kind: 'catalog',
    id: pack.id, name: pack.name, version: pack.version,
    upgraded, dir: baseUrl.slice(0, -1),
    count: ids.length, ids, items,
  };
}

/* ===== 原 plugins.js：插件清单 + zip 安装 ===== */
/*
 * 安装包层：清单扫描 + zip 安装（解包、按包类型分流、校验、原子替换）。
 *
 * 一个 zip 可能是两种东西，靠清单里的 kind 自动识别（前端「导入插件」的上传流程不变）:
 *   1) 插件包 kind = device / background —— 门窗、灯、开关…是 device，户外地面/庭院是 background；
 *      包根要有 plugin.json + plugin.js（可选 models/*.glb），落到 custom/plugins/<id>/，同 id 覆盖升级
 *   2) 家具包 kind = catalog —— 一个 item.json（kind + 项目 id + items 数组）+ 若干平铺的 .glb，
 *      整包装到 custom/models/<项目id>/，规则见 catalog-import.js
 * kind 必填：清单里没写 kind 一律拒绝导入（不再按文件形状猜类型）——
 * 猜错方向的代价比让打包方补一行 kind 高得多。
 *
 * 插件目录约定: assets/plugins/<dir>/ 与 custom/plugins/<dir>/，每个插件目录含
 *   plugin.json（清单：id/name/version/kind…）
 *   plugin.js  （调用 PluginEngine.register 注册造型与行为）
 *   models/*.glb（可选，插件自带模型）
 * custom 后扫描、同名覆盖内置；安装进来的目录名一律 = 插件 id（= studio 项目 id），
 * 所以重复安装同一插件就是原地覆盖升级。
 *
 * zip 解析为了保持零依赖，用内置 zlib 手写：只走中央目录，支持 stored(0)/deflate(8)，
 * 不支持 zip64（安装包远小于 4GB）。studio 打包用 jszip，产出正是 DEFLATE。
 */


const INSTALL_MAX_BYTES = 64 * 1024 * 1024;   // 单个安装包上限（插件包与家具包同一口径）
/* 解压预算：压缩包本身 ≤64MB，但 deflate 可以把几十 KB 撑成几十 GB（zip bomb）。
 * 单条目与整包都设上限，zlib 的 maxOutputLength 会在超限当场抛错，不会先分配内存。 */
const UNZIP_MAX_ENTRY = 64 * 1024 * 1024;
const UNZIP_MAX_TOTAL = 128 * 1024 * 1024;

/* 插件 id（目录名）字符集 */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/* 插件包的 kind 取值：device（门窗/灯/开关…一切有状态设备）与 background（户外地面等背景）。
 * 家具包是另一个值 catalog，见 catalog-import.js */
const PLUGIN_KINDS = ['device', 'background'];

/* ---------- zip 读取 ---------- */
/* 读全部条目 → [{ name, data }]（目录条目跳过） */
function unzipEntries(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  /* EOCD 后可能跟最多 64KB 注释，从尾部往前扫签名 */
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff >= buf.length) throw new Error('zip 中央目录位置越界');

  const out = [];
  let p = cdOff, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 条目损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);          // 本地头偏移
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + cmtLen;

    if (name.endsWith('/')) continue;              // 目录条目
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('zip 本地头损坏: ' + name);
    /* 本地头里的文件名/扩展区长度可能与中央目录不同，必须按本地头算数据起点 */
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.slice(start, start + compSize);
    /* 先看中央目录声明的原始长度，明显超标就没必要解压了 */
    if (rawSize > UNZIP_MAX_ENTRY) throw new Error('zip 条目解压后过大: ' + name);

    let content;
    if (method === 0) content = data;
    else if (method === 8) content = zlib.inflateRawSync(data, { maxOutputLength: UNZIP_MAX_ENTRY });
    else throw new Error('不支持的压缩方式(' + method + '): ' + name);
    if (rawSize && content.length !== rawSize) throw new Error('解压长度校验失败: ' + name);
    total += content.length;
    if (total > UNZIP_MAX_TOTAL) throw new Error('安装包解压后体积过大（上限 ' + Math.round(UNZIP_MAX_TOTAL / 1048576) + 'MB）');
    out.push({ name, data: content });
  }
  return out;
}

/* 条目名归一化：统一 / 分隔、去掉开头的 ./，挡掉绝对路径与 ..（这些名字直接用来写文件，
 * 来自外部不可信）。返回 null 表示不安全。 */
function normEntryName(raw) {
  const name = String(raw).replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!name || name.startsWith('/') || name.includes('\0')) return null;
  if (name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return name;
}

/* 插件包的条目白名单：只允许 plugin.json / plugin.js / models/<文件名> */
function safePluginEntryName(name) {
  if (name === 'plugin.json' || name === 'plugin.js') return name;
  if (/^models\/[A-Za-z0-9._-]+$/.test(name)) return name;
  return null;
}

/* ---------- 清单扫描 ---------- */
function listPlugins() {
  const bases = [
    { base: path.join(ASSET_DIR, 'plugins'), url: '/assets/plugins' },
    { base: path.join(CUSTOM_DIR, 'plugins'), url: '/custom/plugins', custom: true },   // 后扫: 同名覆盖
  ];
  const found = new Map();   // dir → { dir, entry, ...manifest }
  for (const b of bases) {
    try {
      for (const dir of fs.readdirSync(b.base)) {
        const mf = path.join(b.base, dir, 'plugin.json');
        if (!fs.existsSync(mf)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
          if (fs.existsSync(path.join(b.base, dir, 'plugin.js'))) {
            /* custom=true 标记来自 custom/plugins 的自定义插件：前端据此在
             * 设备/门窗/背景样式与「同类模型」上显示「自定义」角标 */
            found.set(dir, Object.assign({ dir, entry: b.url + '/' + encodeURIComponent(dir) + '/plugin.js', custom: !!b.custom }, manifest));
          }
        } catch (e) { /* 清单损坏跳过：不能因为一个坏插件让整个列表 500 */ }
      }
    } catch (e) { /* 目录不存在 */ }
  }
  return Array.from(found.values());
}

/* ---------- 安装 ---------- */
/* 识别包类型（以清单里的 kind 为准）:
 *   kind:"catalog"            → 家具包
 *   kind:"device"/"background" → 插件包
 * kind 是必填项：一个 kind 都没有就返回 null（由调用端报错），不再按文件形状兜底。
 * 例外：包内有 item.json（家具包清单的固定文件名）但没写 kind 时，仍走家具包分支，
 * 由 parsePack 点名「kind 必须是 catalog」—— 比笼统的「无法识别」好排查。
 * 两类清单混在一个包里返回 'mixed'，由调用端报错让人拆包。 */
function detectKind(files) {
  const kinds = new Set();
  let hasPackJson = false;
  for (const [name, data] of files) {
    if (/(^|\/)item\.json$/i.test(name)) hasPackJson = true;
    if (!/\.json$/i.test(name)) continue;
    try {
      const raw = JSON.parse(data.toString('utf8'));
      if (raw && raw.kind) kinds.add(String(raw.kind).trim().toLowerCase());
    } catch (e) { /* 坏 json 留给具体分支报错 */ }
  }
  const hasCatalog = kinds.has('catalog');
  const hasPlugin = PLUGIN_KINDS.some((k) => kinds.has(k));
  if (hasCatalog && hasPlugin) return 'mixed';
  if (hasCatalog) return 'catalog';
  /* item.json 是家具包清单的固定文件名：有它就先走家具分支，
   * 缺 kind / kind 写错都由 parsePack 点名（比「插件包含不允许的文件」清楚） */
  if (hasPackJson) return 'catalog';
  if (hasPlugin) return 'plugin';
  return null;
}

/* 装一个安装包（插件 / 家具自动分流）。
 * requireId 有值时强制 manifest.id 与它一致（远程安装按 URL 里的 id 定位，只走插件包）；
 * 为 null 时直接采用包内清单的 id（编辑页导入）。
 * 成功返回结果对象（带回 kind 字段）；失败抛 { status, message }，由路由转成 JSON 错误。 */
function installPackage(zipBuf, requireId) {
  const fail = (status, msg) => { throw Object.assign(new Error(msg), { status }); };
  if (!zipBuf || !zipBuf.length) fail(400, '请求体为空：需要用 Content-Type: application/zip 发送安装包');

  /* 解包 + 条目名归一化（路径穿越在这里挡掉，各类型的文件白名单在分支里做） */
  let entries;
  try { entries = unzipEntries(zipBuf); }
  catch (e) { fail(400, '安装包解析失败: ' + e.message); }
  const all = new Map();
  for (const ent of entries) {
    const name = normEntryName(ent.name);
    if (!name) fail(400, '安装包含不安全的文件名: ' + ent.name);
    all.set(name, ent.data);
  }

  const kind = detectKind(all);

  if (kind === 'mixed') {
    fail(400, '安装包里同时有 kind:"catalog"（家具）和 kind:"device"/"background"（插件）的清单，请拆成两个包分别导入');
  }

  if (kind === 'catalog') {
    /* 家具包只收 json / glb：一个 item.json + 若干 .glb 平铺（最多再套一层目录）。
     * requireId 有值时（远程安装接口按 URL 里的 id 定位）校验包内 id 与它一致 */
    const files = new Map();
    for (const [name, data] of all) {
      if (!/\.(json|glb)$/i.test(name)) fail(400, '家具包里有不支持的文件（只接受 .json / .glb）: ' + name);
      if (name.split('/').length > 2) fail(400, '家具包目录层级过深（item.json 与 .glb 要平铺，最多套一层目录）: ' + name);
      files.set(name, data);
    }
    return installCatalogPackage(files, requireId || null);
  }

  if (kind === 'plugin') return installPluginPackage(all, requireId);

  /* 认不出来：文件缺失 / kind 没写 / 类型不对，分别给最贴近的提示 */
  if (all.has('plugin.json') && !all.has('plugin.js')) fail(400, '插件包缺少 plugin.js（应与 plugin.json 同在包根目录）');
  if (all.has('plugin.json') && all.has('plugin.js')) {
    fail(400, 'plugin.json 缺少 kind（必填）：插件写 kind: "device"（设备/门窗）或 "background"（背景），'
      + '家具包写 kind: "catalog"');
  }
  /* 家具清单（老格式：一件家具一个 json，尺寸字段写在顶层）—— 单独点名，别让人去猜「无法识别」是哪错 */
  for (const [name, data] of all) {
    if (!/\.json$/i.test(name)) continue;
    let raw;
    try { raw = JSON.parse(data.toString('utf8')); } catch (e) { continue; }
    if (raw && typeof raw === 'object' && !raw.kind && (raw.w != null || raw.d != null)) {
      fail(400, name + ' 缺少 kind（必填）：家具清单必须写 kind: "catalog"');
    }
  }
  /* 只有模型没有清单：多半是把 glb 直接拖进 zip 了，点名要 item.json */
  const hasGlb = Array.from(all.keys()).some((n) => /\.glb$/i.test(n));
  const hasJson = Array.from(all.keys()).some((n) => /\.json$/i.test(n));
  if (hasGlb && !hasJson) {
    fail(400, '家具包缺少 item.json：包根目录要有一个 item.json（kind: "catalog" + id + items 数组），'
      + '与所有 .glb 模型平铺');
  }
  fail(400, '无法识别的安装包：kind 是必填项 —— 插件包的 plugin.json 写 kind: device / background（并带 plugin.js）；'
    + '家具包在包根放 item.json（kind: catalog + id + items 数组）与若干 .glb 模型');
}

/* 插件包安装：白名单校验 → 清单校验 → 原子替换 custom/plugins/<id>/ */
function installPluginPackage(all, requireId) {
  const fail = (status, msg) => { throw Object.assign(new Error(msg), { status }); };
  const files = new Map();
  for (const [name, data] of all) {
    const safe = safePluginEntryName(name);
    if (!safe) fail(400, '插件包含不允许的文件: ' + name);
    files.set(safe, data);
  }
  if (!files.has('plugin.json') || !files.has('plugin.js')) {
    fail(400, '插件包缺少 plugin.json 或 plugin.js（应为包根目录）');
  }

  /* 清单校验：id 决定安装目录，必须合法且（远程安装时）与请求的 id 一致 */
  let manifest;
  try { manifest = JSON.parse(files.get('plugin.json').toString('utf8')); }
  catch (e) { fail(400, 'plugin.json 不是合法 JSON: ' + e.message); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail(400, 'plugin.json 内容不合法');
  /* kind 是包类型的唯一标识，也是必填项：插件只有 device / background 两种
   * （kind: "catalog" 走家具分支，不会走到这里）。 */
  const mkind = String(manifest.kind || '').trim().toLowerCase();
  if (!mkind) fail(400, 'plugin.json 缺少 kind（必填）：只能是 device 或 background');
  if (PLUGIN_KINDS.indexOf(mkind) < 0) {
    fail(400, 'plugin.json 的 kind 只能是 device 或 background（当前: ' + mkind + '）；家具包请用 kind: "catalog"');
  }
  const id = String(manifest.id || '').trim();
  if (!PLUGIN_ID_RE.test(id)) {
    fail(400, 'plugin.json 的 id 缺失或不合法（小写字母开头，字母/数字/_ . -，最长 64）');
  }
  if (requireId && requireId !== id) {
    fail(400, 'plugin.json 的 id（' + id + '）与安装 id（' + requireId + '）不一致');
  }
  const version = String(manifest.version || '');

  /* 原子替换收敛在 atomic-dir.js（与家具包共用一套）；错误自带 status，直接冒泡给路由。
   * models/ 不预先建：只有包里真的带模型时下面的写文件循环才建出来，
   * 免得「没有 glb 的插件」装完留一个空目录看着像模型丢了。 */
  const { upgraded } = atomicDirReplace(path.join(CUSTOM_DIR, 'plugins'), id, (tmp) => {
    for (const [name, data] of files) {
      fs.mkdirSync(path.dirname(path.join(tmp, name)), { recursive: true });
      fs.writeFileSync(path.join(tmp, name), data);
    }
  }, '插件');

  log('[ha-3d-home] 插件已' + (upgraded ? '升级' : '安装') + ':', id, version || '(无版本)', '文件', files.size, '个');
  return {
    ok: true, kind: 'plugin', id, version, upgraded,
    files: Array.from(files.keys()),
    dir: '/custom/plugins/' + id,
    manifest,
  };
}

/* ===== 原 assets.js：静态托管 / 家具目录 / 参考底图 ===== */
/*
 * 资源层：静态托管（含缓存策略）+ 家具目录合并 + 2D 参考底图。
 * 三者都和「文件怎么发出去 / 磁盘资产怎么读」有关；HTTP 小工具已拆到 http-utils.js。
 */


const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};

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
  /* 归一化一律用正斜杠，不能用 path.normalize：
   * Windows 上 path.normalize('/assets/x') 会得到 '\\assets\\x'，下面的
   * startsWith('/assets/') / '/custom/' 判断就永远不成立，所有 assets/ 与 custom/
   * 下的资源（插件 plugin.js、家具 GLB、catalog.json）都会落到 PUBLIC_DIR 而 404。
   * 同时把反斜杠先折成斜杠，避免编码过的 %5C 绕过前缀判断。 */
  file = file.replace(/\\/g, '/');
  file = path.posix.normalize(file).replace(/^(\.\.\/)+/, '');

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
      const isHtml = ext === '.html';
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
      let body = buf;
      // 生产模式: 关闭前端调试日志（plugins.js / ha.js 读取 window.__HA_DBG）
      if (IS_PROD && isHtml) {
        body = Buffer.from(buf.toString('utf8').replace('</head>', '<script>window.__HA_DBG=false;</script></head>'), 'utf8');
      }
      /* HTML 一律不缓存：① 带 ?v= 的 HTML 若吃 immutable，改页面就得改版本号；
       * ② 生产模式往 HTML 注入了 __HA_DBG，按原文件 mtime/size 算的 ETag 反映不出
       *    NODE_ENV 切换，会 304 返回另一种模式的旧页面。按设计 HTML 本就该即时生效。 */
      if (isHtml) {
        headers['Cache-Control'] = 'no-store';
      } else if (u.searchParams.has('v')) {
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
  serveStatic, MIME, buildCatalog, saveRefImg, serveRefImg,
  catalogTypeDefs, catalogTypes, scanImportedItems, installCatalogPackage,
  listPlugins, installPackage, INSTALL_MAX_BYTES, PLUGIN_ID_RE, atomicDirReplace,
};
