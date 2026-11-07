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
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ASSET_DIR, CUSTOM_DIR, log } = require('./core');
const { installCatalogPackage } = require('./catalog-import');

const INSTALL_MAX_BYTES = 64 * 1024 * 1024;   // 单个安装包上限（插件包与家具包同一口径）

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
async function installPackage(zipBuf, requireId) {
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
    ok: true, kind: 'plugin', id, version, upgraded,
    files: Array.from(files.keys()),
    dir: '/custom/plugins/' + id,
    manifest,
  };
}

module.exports = { INSTALL_MAX_BYTES, PLUGIN_ID_RE, listPlugins, installPackage };
