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
/* 应用版本号的唯一出处（image:nas / image:public 会自动升它）。页面顶栏通过 /api/version 读取，
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
/* 结构校验（normProject/ELEM_CHECKS/checkOpening）已剥离到 project-schema.js（审计 3.2），
 * 这里只留项目数据的持久化：运行时缓存 + 读写。shared.js 向下兼容 re-export normProject，
 * 既有调用方（project.js 路由 / 测试）不用改 import。 */
const { normProject } = require('./project-schema');

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

/* HA base 单一出处（审计 2.1）：trim 后去尾部斜杠；config / ha-proxy / automation-proxy
 * 共用 —— 此前 config.js 与 ha-proxy.js 各写一份，已现微差（一处 trim 一处不 trim）。 */
function haBase() { return (getConfig().haUrl || '').trim().replace(/\/+$/, ''); }

/* 报错脱敏（审计 2.5）：errText 清路径后，再把上游内网地址抹成 [tag]
 * （fetch 的报错常带完整 target URL，曾泄漏过内网地址）。 */
function maskUpstream(msg, base, tag) {
  const m = errText(msg);
  return base ? m.split(base).join('[' + tag + ']') : m;
}

module.exports = { maskUpstream, haBase, DATA_DIR, ASSET_DIR, CUSTOM_DIR, PUBLIC_DIR, IS_PROD, log, logErr, errText, ensureDirs, readJSON, appVersion, getConfig, saveConfig, installKey, setInstallKey, normProject, loadProject, saveProject, readBody, readRawBody, json, wrap, requestURL, normPathname };
