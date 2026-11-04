/*
 * 插件层：清单扫描 + zip 安装（解包、校验、原子替换）。
 *
 * 目录约定: assets/plugins/<dir>/ 与 custom/plugins/<dir>/，每个插件目录含
 *   plugin.json（清单：id/name/version/kind…）
 *   plugin.js  （调用 PluginEngine.register 注册造型与行为）
 *   models/*.glb（可选，插件自带模型）
 * custom 后扫描、同名覆盖内置；安装进来的目录名一律 = 插件 id（= studio 项目 id），
 * 所以重复安装同一插件就是原地覆盖升级。
 *
 * zip 解析为了保持零依赖，用内置 zlib 手写：只走中央目录，支持 stored(0)/deflate(8)，
 * 不支持 zip64（插件包远小于 4GB）。studio 打包用 jszip，产出正是 DEFLATE。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ASSET_DIR, CUSTOM_DIR, log } = require('./core');

const INSTALL_MAX_BYTES = 64 * 1024 * 1024;   // 单个插件包上限

/* 插件目录名 = 插件 id（studio 约定 id 等于项目 id） */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

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
  let p = cdOff;
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

    let content;
    if (method === 0) content = data;
    else if (method === 8) content = zlib.inflateRawSync(data);
    else throw new Error('不支持的压缩方式(' + method + '): ' + name);
    if (rawSize && content.length !== rawSize) throw new Error('解压长度校验失败: ' + name);
    out.push({ name, data: content });
  }
  return out;
}

/* 包内条目名归一化 + 白名单：只允许 plugin.json / plugin.js / models/<文件名>，
 * 顺带挡掉 ../ 与绝对路径（这些名字直接用来写文件，来自外部不可信） */
function safeEntryName(raw) {
  const name = String(raw).replace(/\\/g, '/');
  if (!name || name.startsWith('/') || name.includes('..')) return null;
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
/* 安装一个插件 zip：解包 → 白名单校验 → 清单校验 → 原子替换 custom/plugins/<id>/。
 * requireId 有值时强制 manifest.id 与它一致（远程安装按 URL 里的 id 定位）；
 * 为 null 时直接采用 manifest.id（编辑页导入，id 只来自包内清单）。
 * 成功返回结果对象；失败抛 { status, message }，由路由转成 JSON 错误。 */
async function installPluginZip(zipBuf, requireId) {
  const fail = (status, msg) => { throw Object.assign(new Error(msg), { status }); };
  if (!zipBuf || !zipBuf.length) fail(400, '请求体为空：需要用 Content-Type: application/zip 发送插件包');

  /* 解包 + 白名单校验（条目名直接用来写文件，必须挡住 ../ 之类） */
  let entries;
  try { entries = unzipEntries(zipBuf); }
  catch (e) { fail(400, '插件包解析失败: ' + e.message); }
  const files = new Map();
  for (const ent of entries) {
    const name = safeEntryName(ent.name);
    if (!name) fail(400, '插件包含不允许的文件: ' + ent.name);
    files.set(name, ent.data);
  }
  if (!files.has('plugin.json') || !files.has('plugin.js')) {
    fail(400, '插件包缺少 plugin.json 或 plugin.js（应为包根目录）');
  }

  /* 清单校验：id 决定安装目录，必须合法且（远程安装时）与请求的 id 一致 */
  let manifest;
  try { manifest = JSON.parse(files.get('plugin.json').toString('utf8')); }
  catch (e) { fail(400, 'plugin.json 不是合法 JSON: ' + e.message); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail(400, 'plugin.json 内容不合法');
  const id = String(manifest.id || '').trim();
  if (!PLUGIN_ID_RE.test(id)) {
    fail(400, 'plugin.json 的 id 缺失或不合法（小写字母开头，字母/数字/_ . -，最长 64）');
  }
  if (requireId && requireId !== id) {
    fail(400, 'plugin.json 的 id（' + id + '）与安装 id（' + requireId + '）不一致');
  }
  const version = String(manifest.version || '');

  /* 原子替换：写临时目录 → 旧目录改名备份 → 新目录上位 → 删备份；任何一步失败都回滚。
   * 所以重复导入同一插件 = 原地覆盖升级，不会留下半套文件。 */
  const pluginsDir = path.join(CUSTOM_DIR, 'plugins');
  const target = path.join(pluginsDir, id);
  const stamp = Date.now();
  const tmp = path.join(pluginsDir, '.install-' + id + '-' + stamp);
  const backup = path.join(pluginsDir, '.old-' + id + '-' + stamp);
  let upgraded = false;
  try {
    /* models/ 不预先建：只有包里真的带模型时才由下面的写文件循环建出来。
     * 原先无条件 mkdir 会让「没有 glb 的插件」装完也留一个空 models 目录
     * （custom/plugins/<id>/models 空的，看着像模型丢了） */
    for (const [name, data] of files) {
      fs.mkdirSync(path.dirname(path.join(tmp, name)), { recursive: true });
      fs.writeFileSync(path.join(tmp, name), data);
    }
    upgraded = fs.existsSync(target);
    if (upgraded) fs.renameSync(target, backup);
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      if (upgraded) fs.renameSync(backup, target);   // 上位失败：把旧版本放回去
      throw e;
    }
    if (upgraded) fs.rmSync(backup, { recursive: true, force: true });
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    fail(500, '写入插件目录失败: ' + e.message);
  }

  log('[ha-3d-home] 插件已' + (upgraded ? '升级' : '安装') + ':', id, version || '(无版本)', '文件', files.size, '个');
  return {
    ok: true, id, version, upgraded,
    files: Array.from(files.keys()),
    dir: '/custom/plugins/' + id,
    manifest,
  };
}

module.exports = { INSTALL_MAX_BYTES, PLUGIN_ID_RE, listPlugins, installPluginZip };
