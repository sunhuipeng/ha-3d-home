'use strict';
/*
 * 共用基础层（服务端唯一保留的共用代码，其余能力都已消化进各 *.js）。
 *   · 目录常量 / 运行模式 / 日志 / data 持久化
 *   · JSON 响应 / 请求体读取（含大小上限）
 *   · 路由公共件 json / wrap / requestURL
 * 所有函数体逐字保留，只去掉重复的内置 require 与 module.exports。
 */
const fs = require('fs');
const path = require('path');

/* ===== 目录常量 / 日志 / data 持久化 ===== */
/*
 * 基础层：目录常量、运行模式、日志、data/*.json 持久化。
 * 全站唯一决定「文件放哪、配置怎么存」的地方，其他模块只从这里取。
 */


/* ---------- 路径 ---------- */
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.HA3D_DATA_DIR || path.join(ROOT, 'data');
const ASSET_DIR = process.env.HA3D_ASSET_DIR || path.join(ROOT, 'assets');
/* 用户自定义资产目录（models/ 平铺 glb + plugins/ + models/<项目id>/ 家具包），
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

/* ---------- 错误信息脱敏 ----------
 * 回传给客户端的 error 一律先过这里：生产模式抹掉服务器绝对路径，
 * 避免 fs / zip / rename 等错误消息泄露目录结构（如 '...data\project.json'）。
 * 开发模式原样返回，方便本地排查。lookbehind 需要 Node 14+。 */
function errText(e) {
  let m = String((e && e.message) || e);
  if (!IS_PROD) return m;
  /* 先替换最具体的目录，再替换项目根与 cwd —— 父目录先替换会留下相对残段 */
  for (const dir of [DATA_DIR, ASSET_DIR, CUSTOM_DIR, PUBLIC_DIR, ROOT, process.cwd()]) {
    if (dir && dir.length > 1) m = m.split(dir).join('[path]');
  }
  /* 兜底：Windows 盘符路径、常见 Unix 系路径（tmp / home / app 等）。
     负向后顾排除 URL scheme（http: / ws: 里的 "p:/" 不算盘符路径）。 */
  m = m.replace(/(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/][^\s'"`,;)\]}]*/g, '[path]');
  m = m.replace(/(^|[\s'"`(=])\/(?:home|root|app|srv|opt|var|usr|etc|tmp|data|Users|private)\/[^\s'"`,;)\]}]*/g, '$1[path]');
  return m;
}

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
/* 临时文件带 pid + 序号：多标签 / sendBeacon 与 autoSave 并发写同一份 JSON 时，
 * 固定 .tmp 会被另一个请求覆盖或提前 rename，出现「半成品盖掉成品」。
 * 写失败也要删掉自己那份临时文件，不在 data/ 里留垃圾。 */
let tmpSeq = 0;
function writeJSON(file, obj) {
  const tmp = file + '.' + process.pid + '.' + (++tmpSeq) + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* 临时文件已不存在 */ }
    throw e;
  }
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

/* 生效的密钥：只读 data/install-key.json（由 home 前端「导入插件/包」弹窗生成/设置）。
 * 空值 = 未启用远程安装，/api/plugins/install 一律 401；页面随时可重新生成。 */
function installKey() {
  return String((installCfg && installCfg.key) || '').trim();
}
function setInstallKey(key) {
  installCfg = { key };
  writeJSON(INSTALL_KEY_FILE, installCfg);
  return installCfg;
}

/* ---------- 户型项目 ---------- */
/* 保存项目的结构校验 + 补骨架：拦住坏数据覆盖 project.json（一旦写坏，两个页面都起不来）。
 * 通过返回归一后的对象（楼层必要数组补空），不合法返回 null（调用端 400）。
 *
 * 元素级校验（浅白名单 + 数值有限性）：墙/门窗/家具/设备/房间逐个过检，
 * 坏元素**直接丢弃**（比整包 400 更耐脏 —— 前端一次保存拖进来一个脏元素，
 * 不该把整份项目卡在门外）。策略与前端 serializeProject 的输出形态一一对应：
 *   · 必填坐标用 Number() 宽松收数（"1.5" 也认），非有限值/越界才丢；
 *   · 字符串字段一律 String 收口 + 截断，防巨型垃圾入库；
 *   · 楼层层高/透明度收口到安全区间（与前端 DEFAULT_FLOOR_H / 滑杆范围对齐）。 */

const MAX_LIST = 2000;        // 单楼层单类元素上限（正常户型远够，只挡灌垃圾）
const MAX_PTS = 500;          // 单房间顶点上限
const MAX_COORD = 10000;      // 坐标/尺寸上限（米）—— 1 万米外的家不属于这个项目
const MAX_STR = 128;          // 通用字符串字段截断

const sOf = (v, max) => (typeof v === 'string' ? v.slice(0, max || MAX_STR) : '');
/* 宽松收数：数字直接过，纯数值字符串转一下，其余（对象/数组/1e999）回 null */
const nOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() && v.length <= 32) { const x = Number(v); if (Number.isFinite(x)) return x; }
  return null;
};
const coord = (v) => { const x = nOf(v); return x != null && Math.abs(x) <= MAX_COORD ? x : null; };
const plainObj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;

/* 各类元素的「最低可渲染条件」：不满足即丢。其余字段（roomId/entityId/styleOpts
 * 及插件扩展 fields）放宽 —— 由前端序列化负责形态，这里只挡渲染热路径会炸的值。 */
const ELEM_CHECKS = {
  walls(w) {
    const x1 = coord(w.x1), y1 = coord(w.y1), x2 = coord(w.x2), y2 = coord(w.y2);
    if (!sOf(w.id) || x1 == null || y1 == null || x2 == null || y2 == null) return null;
    const t = coord(w.t);
    w.x1 = x1; w.y1 = y1; w.x2 = x2; w.y2 = y2;
    w.t = (t != null && t > 0 && t <= 2) ? t : 0.24;
    return w;
  },
  doors(o) { return checkOpening(o); },
  windows(o) { return checkOpening(o); },
  furniture(f) {
    if (!sOf(f.id) || !sOf(f.mid)) return null;
    const x = coord(f.x), y = coord(f.y), z = coord(f.z), rot = nOf(f.rot), sc = nOf(f.scale);
    if (x == null || y == null) return null;
    f.x = x; f.y = y;
    if (z != null) f.z = z; else delete f.z;
    f.rot = (rot != null && Math.abs(rot) <= 100000) ? rot : 0;
    if (sc != null && sc > 0 && sc <= 20) f.scale = sc; else delete f.scale;
    return f;
  },
  devices(d) {
    if (!sOf(d.id)) return null;
    const x = coord(d.x), y = coord(d.y), z = coord(d.z), rot = nOf(d.rot), lo = nOf(d.labelOffset);
    if (x == null || y == null) return null;
    d.type = sOf(d.type);
    d.x = x; d.y = y;
    if (z != null) d.z = z; else delete d.z;
    if (rot != null && Math.abs(rot) <= 100000) d.rot = rot; else delete d.rot;
    if (lo != null && Math.abs(lo) <= 10) d.labelOffset = lo; else delete d.labelOffset;
    return d;
  },
  rooms(r) {
    const pts = Array.isArray(r.pts) ? r.pts.slice(0, MAX_PTS)
      .map((p) => (Array.isArray(p) ? [coord(p[0]), coord(p[1])] : [null, null]))
      .filter((p) => p[0] != null && p[1] != null) : [];
    if (!sOf(r.id) || pts.length < 3) return null;
    r.pts = pts;
    r.name = sOf(r.name) || '房间';
    /* 房间 3D 温湿度标签的实体绑定（可选）。与前端 roomOut 同口径：只留字符串，
     * 非字符串/空串删除，避免异常类型落盘。语义上与设备绑定无关。 */
    ['tempEntity', 'humidityEntity'].forEach((k) => {
      const v = sOf(r[k]);
      if (v) r[k] = v; else delete r[k];
    });
    return r;
  },
};
/* 门/窗同构：id + 摆放（x/y/w/rot）是渲染最低条件；z 是窗离地（门恒 0 可缺省） */
function checkOpening(o) {
  if (!sOf(o.id)) return null;
  const x = coord(o.x), y = coord(o.y), w = coord(o.w), z = coord(o.z), rot = nOf(o.rot);
  if (x == null || y == null) return null;
  o.x = x; o.y = y;
  o.w = (w != null && w > 0 && w <= MAX_COORD) ? w : 1;
  o.rot = (rot != null && Math.abs(rot) <= 100000) ? rot : 0;
  if (z != null) o.z = z; else delete o.z;
  return o;
}

function normProject(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (!Array.isArray(p.floors) || !p.floors.length || p.floors.length > 50) return null;
  /* rooms = 2D 地面分区多边形（后加字段：老客户端不传时补空数组） */
  const LIST_KEYS = ['walls', 'doors', 'windows', 'furniture', 'devices', 'rooms'];
  let dropped = 0;
  const kept = [];
  for (const fl of p.floors) {
    if (!fl || typeof fl !== 'object' || Array.isArray(fl)) return null;
    if (typeof fl.name !== 'string' || !fl.name.trim()) return null;
    /* 楼层 id 是锚点 / 选中引用的主键：没有它这层就是孤儿，直接丢层 */
    if (!sOf(fl.id)) { dropped++; continue; }
    /* 楼层的展示配置（天气/数据卡/大屏场景）必须为对象，缺失时兜底空骨架 */
    if (fl.display == null) fl.display = {};
    if (typeof fl.display !== 'object' || Array.isArray(fl.display)) return null;
    /* 层高 / 2D 墙体透明度收口（与前端 DEFAULT_FLOOR_H=2.8、透明度滑杆 0..100 对齐） */
    const h = nOf(fl.height);
    fl.height = (h != null && h > 0 && h <= 20) ? h : 2.8;
    const wo = nOf(fl.wallOpacity);
    fl.wallOpacity = (wo != null && wo >= 0 && wo <= 100) ? wo : 45;
    for (const k of LIST_KEYS) {
      if (fl[k] == null) { fl[k] = []; continue; }   // 缺省补空数组，老版本客户端少字段也能存
      if (!Array.isArray(fl[k])) return null;
      if (fl[k].length > MAX_LIST) fl[k] = fl[k].slice(0, MAX_LIST);
      const check = ELEM_CHECKS[k];
      /* 逐元素过检：坏元素丢弃、好元素就地归一（数字收口），而不是整包拒绝 */
      const before = fl[k].length;
      fl[k] = fl[k].filter((x) => {
        if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
        return !!(check && check(x));
      });
      dropped += before - fl[k].length;
    }
    kept.push(fl);
  }
  p.floors = kept;
  /* 丢弃只记日志（生产静默），不阻断保存 —— 用户不该为一条脏墙线丢整份户型 */
  if (dropped && LOG_ON) log('[normProject] 丢弃非法元素/楼层:', dropped);
  if (!p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings)) p.settings = {};
  if (typeof p.name !== 'string' || !p.name.trim()) p.name = '我的家';
  return p;
}

/* 项目数据运行时只通过 saveProject()（POST/PUT /api/project）变化，单进程内缓存一份即可：
 * 首次 loadProject() 读盘，之后直接返回缓存；保存成功后再同步刷新。
 * 外部直接改 data/project.json 不会被感知，需重启服务（与 config/installKey 同一口径）。
 * undefined = 尚未加载；null = 文件不存在/损坏（与 readJSON 的 fallback 一致）。
 * 返回的是缓存对象本身，调用方只读、不要就地修改。 */
let projectCache;

function loadProject() {
  if (projectCache === undefined) projectCache = readJSON(PROJECT_FILE, null);
  return projectCache;
}

function saveProject(proj) {
  writeJSON(PROJECT_FILE, proj);
  projectCache = proj;
  return { saved: true, time: Date.now() };
}

/* ===== JSON 响应 / 请求体读取 ===== */
/*
 * HTTP 小工具：JSON 响应 + 请求体读取。
 * 与「静态资源怎么发出去」无关，从 assets.js 拆出来，供路由层和其它模块共用。
 * 零 npm 依赖（只用 Node 内置模块）。
 */

const BODY_MAX_BYTES = 20 * 1024 * 1024;   // JSON 请求体上限

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/* 统一的流式读取。超过上限后不再缓存数据、但继续把流读完，这样还能回一个
 * 正常的 JSON 错误（带 status 413），而不是直接掐断连接。 */
function collectBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) {
        return reject(Object.assign(
          new Error('请求体过大（上限 ' + Math.round(limit / 1048576) + 'MB）'), { status: 413 }));
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/* 读 JSON 请求体（解析失败回 null，由调用端判断） */
async function readBody(req) {
  const buf = await collectBody(req, BODY_MAX_BYTES);
  if (!buf.length) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
}

/* 读原始字节（上传 zip 用：要的就是二进制，不能走 JSON 解析） */
function readRawBody(req, limit) {
  return collectBody(req, limit);
}

/* 与旧 handle* 的 reply(res, code, obj) 完全同一实现（直发 sendJSON） */
function json(res, code, obj) { return sendJSON(res, code, obj); }

/* Express 4 不会自动捕获 async handler 的 rejection，统一包一层交给 index.js 的错误兜底，
 * 复刻旧站 createServer 的 try/catch → sendJSON(e.status||500, {error})。 */
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/* URL pathname 归一化：解码 %xx → 反斜杠折正斜杠 → posix.normalize。
 * 门禁前缀判断与静态托管必须用同一份——new URL().pathname 不做解码，
 * /%63ustom/... 在门禁层看不到 /custom/ 前缀就会被放行（2026-11-20 修复的绕过）。 */
function normPathname(u) {
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch (e) { /* 非法编码按原样处理 */ }
  p = p.replace(/\\/g, '/');
  return path.posix.normalize(p);
}

/* 旧站主流程用 new URL(req.url, 'http://localhost')；Express 在 use('/api', ...)
 * 里会临时裁剪 req.url，所以统一取 originalUrl，保证 pathname / searchParams 一致。 */
function requestURL(req) {
  return new URL(req.originalUrl || req.url, 'http://localhost');
}

module.exports = { DATA_DIR, ASSET_DIR, CUSTOM_DIR, PUBLIC_DIR, IS_PROD, log, logErr, errText, ensureDirs, readJSON, appVersion, getConfig, saveConfig, installKey, setInstallKey, normProject, loadProject, saveProject, sendJSON, readBody, readRawBody, json, wrap, requestURL, normPathname };
