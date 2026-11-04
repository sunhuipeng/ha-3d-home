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
   路径定死 —— 容器内固定 /custom；本地开发用项目根 custom/ */
const CUSTOM_DIR = fs.existsSync('/custom') ? '/custom' : path.join(ROOT, 'custom');
const PUBLIC_DIR = path.join(ROOT, 'public');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PROJECT_FILE = path.join(DATA_DIR, 'project.json');
const INSTALL_KEY_FILE = path.join(DATA_DIR, 'install-key.json');

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
function saveProject(proj) {
  writeJSON(PROJECT_FILE, proj);
  return { saved: true, time: Date.now() };
}

module.exports = {
  ROOT, DATA_DIR, ASSET_DIR, CUSTOM_DIR, PUBLIC_DIR, IS_PROD, log, logErr, ensureDirs,
  readJSON, writeJSON,
  getConfig, saveConfig,
  installKey, installKeyLocked, setInstallKey,
  normProject, loadProject, saveProject,
};
