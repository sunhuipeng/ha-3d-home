/*
 * 基础层：目录常量、运行模式、日志、data/*.json 持久化。
 * 全站唯一决定「文件放哪、配置怎么存」的地方，其他模块只从这里取。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- 路径 ---------- */
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.HA3D_DATA_DIR || path.join(ROOT, 'data');
const ASSET_DIR = process.env.HA3D_ASSET_DIR || path.join(ROOT, 'assets');
/* 用户自定义资产目录（结构与 assets 相同: models/ plugins/ catalog.json），
   与内置 assets 合并使用，同名/同 id 时自定义覆盖内置；Docker 单独挂载，升级镜像不丢。
   容器内固定 /custom；本地开发用项目根 custom/，也可用 HA3D_CUSTOM_DIR 显式指定。

   注意 Windows：'/custom' 会被解析成「当前盘符根目录 \custom」（如 F:\custom），
   不能用 existsSync('/custom') 单独判断是否在容器里 —— 盘根碰巧有同名目录时，
   自定义插件与家具会全部指向错误位置。所以只在确认为容器（/.dockerenv）时才采用。 */
const CUSTOM_DIR = process.env.HA3D_CUSTOM_DIR
  || (fs.existsSync('/.dockerenv') && fs.existsSync('/custom') ? '/custom' : path.join(ROOT, 'custom'));
const PUBLIC_DIR = path.join(ROOT, 'public');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PROJECT_FILE = path.join(DATA_DIR, 'project.json');
const INSTALL_KEY_FILE = path.join(DATA_DIR, 'install-key.json');
/* 应用版本号的唯一出处（push:image 会自动升它）。页面顶栏通过 /api/version 读取，
 * 每次请求重新读文件 —— 改了 package.json 刷新页面即生效，不用改前端、也不用重启服务。 */
const PKG_FILE = path.join(ROOT, 'package.json');

/* ---------- 运行模式 ---------- */
/* 生产模式: 默认静默（不打印任何日志），需要排查时用 HA3D_LOG=1 打开 */
const IS_PROD = process.env.NODE_ENV === 'production';
const LOG_ON = process.env.HA3D_LOG != null
  ? !/^(0|false|off|no)$/i.test(String(process.env.HA3D_LOG))
  : !IS_PROD;
const log = (...args) => { if (LOG_ON) console.log(...args); };
const logErr = (...args) => { if (LOG_ON) console.error(...args); };

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  fs.mkdirSync(path.join(CUSTOM_DIR, 'models'), { recursive: true });
  fs.mkdirSync(path.join(CUSTOM_DIR, 'plugins'), { recursive: true });
}

/* ---------- JSON 持久化 ---------- */
/* 一律「临时文件 + rename」，避免断电/异常中断留下半个 JSON */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

/* 应用版本号：刻意不用 require(PKG_FILE) —— require 会缓存，改了版本要重启服务才生效。
 * 读不到 / version 缺失一律回空串，前端保持隐藏，不让版本号影响页面可用性。 */
function appVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')).version;
    return typeof v === 'string' ? v.trim() : '';
  } catch (e) { return ''; }
}
function writeJSON(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

/* ---------- 连接配置（HA 地址/令牌） ---------- */
/* 插件安装密钥不放在这里：保存连接配置时会整体重建这个对象，
 * 混在一起容易被覆盖；它有自己的文件和接口 /api/install/config。 */
let config = readJSON(CONFIG_FILE, { haUrl: '', token: '' });
function getConfig() { return config; }
function saveConfig(next) {
  config = next;
  writeJSON(CONFIG_FILE, config);
  return config;
}

/* ---------- 插件安装密钥 ---------- */
let installCfg = readJSON(INSTALL_KEY_FILE, { key: '' });

/* 生效的密钥：环境变量 HA3D_INSTALL_KEY 优先（容器部署免得写进卷里），否则读文件。
 * 空值 = 未启用远程安装，接口一律 401 并提示怎么配。 */
function installKey() {
  const env = process.env.HA3D_INSTALL_KEY;
  if (env != null && String(env).trim()) return String(env).trim();
  return String((installCfg && installCfg.key) || '').trim();
}
/* true = 密钥由环境变量接管，页面里不允许改 */
function installKeyLocked() {
  return !!(process.env.HA3D_INSTALL_KEY && String(process.env.HA3D_INSTALL_KEY).trim());
}
function setInstallKey(key) {
  installCfg = { key };
  writeJSON(INSTALL_KEY_FILE, installCfg);
  return installCfg;
}

/* ---------- 户型项目 ---------- */
/* 保存项目的结构校验 + 补骨架：拦住坏数据覆盖 project.json（一旦写坏，两个页面都起不来）。
 * 通过返回归一后的对象（楼层必要数组补空），不合法返回 null（调用端 400）。 */
function normProject(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (!Array.isArray(p.floors) || !p.floors.length || p.floors.length > 50) return null;
  const LIST_KEYS = ['walls', 'doors', 'windows', 'furniture', 'devices'];
  for (const fl of p.floors) {
    if (!fl || typeof fl !== 'object' || Array.isArray(fl)) return null;
    if (typeof fl.name !== 'string' || !fl.name.trim()) return null;
    /* 楼层的展示配置（天气/数据卡/大屏场景/快捷设备）必须为对象，缺失时兜底空骨架 */
    if (fl.display == null) fl.display = {};
    if (typeof fl.display !== 'object' || Array.isArray(fl.display)) return null;
    for (const k of LIST_KEYS) {
      if (fl[k] == null) { fl[k] = []; continue; }   // 缺省补空数组，老版本客户端少字段也能存
      if (!Array.isArray(fl[k])) return null;
      if (fl[k].some((x) => !x || typeof x !== 'object' || Array.isArray(x))) return null;
    }
  }
  if (!p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings)) p.settings = {};
  if (typeof p.name !== 'string' || !p.name.trim()) p.name = '我的家';
  return p;
}

function loadProject() { return readJSON(PROJECT_FILE, null); }

/* ---------- 旋转锚点（大屏页 3D 视角） ----------
 * 存在 project.json 的 settings.anchors，键为楼层 id，形如
 *   { "imvu89upq1": { mode:'center' } 或 { mode:'custom', x, y, z } }
 * 放项目里是为了跟户型一起备份 / 迁移；但**只能局部读写这一个字段**：
 * 大屏页持有的是启动时的项目快照，整份 POST /api/project 会把编辑页之后
 * 保存的户型改动覆盖掉，所以锚点走自己的 /api/anchor 接口。 */
function anchorsOf(proj) {
  const a = proj && proj.settings && proj.settings.anchors;
  return (a && typeof a === 'object' && !Array.isArray(a)) ? a : {};
}
function loadAnchors() { return anchorsOf(loadProject()); }

/* 楼层 id 白名单：uid() 生成的是 i 开头的 base36，极旧项目可能只是索引字符串。
 * 显式拒绝 __proto__ / prototype / constructor —— 这些键经过 Object.assign 会命中
 * 原型 setter，让锚点静默丢失甚至污染 Object.prototype。 */
const ANCHOR_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
function safeAnchorKey(k) {
  const key = String(k == null ? '' : k).slice(0, 64);
  return (ANCHOR_KEY_RE.test(key) && !UNSAFE_KEYS.has(key)) ? key : null;
}
/* null 原型对象 + defineProperty 合并：即便 project.json 里被塞了 __proto__，
 * 也只会成为普通数据属性，不会触发 setter；JSON.stringify 对 null 原型对象同样有效。
 * 后传入的表覆盖前面的（saveProject 里 disk 放最后 = 磁盘锚点优先）。 */
function mergeAnchors(...tables) {
  const out = Object.create(null);
  for (const t of tables) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    for (const k of Object.keys(t)) {
      if (UNSAFE_KEYS.has(k)) continue;
      Object.defineProperty(out, k, { value: t[k], enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

/* 校验 + 只更新一个楼层的锚点；返回整张表，数据不合法返回 null。
 * 数值范围与前端 View3D.setAnchor 的 lim/limY 对齐，别把 NaN / 无穷大写进项目文件。 */
function saveAnchor(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const key = safeAnchorKey(entry.floor);
  if (!key) return null;
  let value;
  if (entry.mode === 'center') {
    value = { mode: 'center' };
  } else if (entry.mode === 'custom'
    && ['x', 'y', 'z'].every((k) => typeof entry[k] === 'number' && isFinite(entry[k]) && Math.abs(entry[k]) <= 200)) {
    const r = (n) => Math.round(n * 100) / 100;
    value = { mode: 'custom', x: r(entry.x), y: r(entry.y), z: r(entry.z) };
  } else return null;

  /* 读磁盘最新文件再写：整个「读-改-写」同步完成，不会被其它请求插队。
     项目文件还不存在时不凭空造，交给编辑页先保存一次户型。 */
  const proj = loadProject();
  if (!proj || typeof proj !== 'object' || Array.isArray(proj)) return null;
  proj.settings = (proj.settings && typeof proj.settings === 'object' && !Array.isArray(proj.settings)) ? proj.settings : {};
  const merged = mergeAnchors(anchorsOf(proj));
  Object.defineProperty(merged, key, { value, enumerable: true, writable: true, configurable: true });
  proj.settings.anchors = merged;
  writeJSON(PROJECT_FILE, proj);
  return proj.settings.anchors;
}

function saveProject(proj) {
  /* 编辑页整份提交的是它启动时的快照；期间大屏页可能刚改过锚点。
   * 锚点由 /api/anchor 独立维护，磁盘上的值优先于客户端旧快照，别被抹掉。 */
  const disk = anchorsOf(readJSON(PROJECT_FILE, null));
  const sent = anchorsOf(proj);
  if (Object.keys(disk).length || Object.keys(sent).length) {
    proj.settings = proj.settings || {};
    proj.settings.anchors = mergeAnchors(sent, disk);
  }
  writeJSON(PROJECT_FILE, proj);
  return { saved: true, time: Date.now() };
}

module.exports = {
  ROOT, DATA_DIR, ASSET_DIR, CUSTOM_DIR, PUBLIC_DIR, IS_PROD, log, logErr, ensureDirs,
  readJSON, writeJSON, appVersion,
  getConfig, saveConfig,
  installKey, installKeyLocked, setInstallKey,
  normProject, loadProject, saveProject,
  loadAnchors, saveAnchor,
};
