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
'use strict';

const fs = require('fs');
const path = require('path');
const { ASSET_DIR, CUSTOM_DIR, log } = require('./core');
const { atomicDirReplace } = require('./atomic-dir');

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

module.exports = {
  PACK_ID_RE, ITEM_ID_RE, KEY_SEP,
  catalogTypeDefs, catalogTypes,
  parseItem, parsePack, chooseGlb, itemKey,
  readPackDir, scanImportedItems, installCatalogPackage,
};
