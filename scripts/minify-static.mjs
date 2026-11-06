#!/usr/bin/env node
/* 静态资源压缩（css / js / json / html）—— 源目录只读，产物写到独立目录
 *
 * 用法：
 *   node scripts/minify-static.mjs                              # public assets → dist-min/public dist-min/assets
 *   node scripts/minify-static.mjs --out build/min public assets
 *   npm run minify
 *
 * 为什么不做原地压缩：本地一旦原地压过，public/ assets/ 的源码就不可读了，
 * 后面改代码、看 diff、排查问题全是灾难。所以这里**只读源目录**，
 * 压缩结果按源目录名镜像到输出目录（默认 dist-min/），源文件一个字节都不动。
 *
 * 规则：
 *   · 输出目录每次先清空重建，避免残留旧文件
 *   · 二进制（glb / 图片 / 字体 / 压缩包等）原样复制，产物目录可直接当静态根
 *   · 压不动（结果不比原文小）时写原文，不为了「压过」而改坏东西
 *   · three.min.js / vue.global.prod.js / *.min.js 已是压缩版，跳过
 *   · JSON 用 JSON.parse/stringify 归一化，解析失败就原样复制并告警
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { minify as minifyJs } from 'terser';
import { minify as minifyHtml } from 'html-minifier-terser';
import CleanCSS from 'clean-css';

/* ---- 参数 ---- */
const argv = process.argv.slice(2);
let outDir = 'dist-min';
const ROOTS = [];

for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--out' || a === '-o') {
    const v = argv[i + 1];
    if (!v) { console.error('--out 后面要跟输出目录'); process.exit(2); }
    outDir = v; i += 1;
  } else if (a === '--help' || a === '-h') {
    console.log('用法: node scripts/minify-static.mjs [--out <输出目录>] [源目录...]');
    console.log('默认: 源目录 public assets，输出目录 dist-min（产物 dist-min/public、dist-min/assets）');
    process.exit(0);
  } else if (a.startsWith('-')) {
    console.error('未知参数: ' + a); process.exit(2);
  } else {
    ROOTS.push(a);
  }
}
if (!ROOTS.length) ROOTS.push('public', 'assets');

const SKIP_JS = /(^|\/)(three\.min\.js|vue\.global\.prod\.js)$|\.min\.js$/i;
const HANDLED = new Set(['.js', '.css', '.html', '.htm', '.json']);

const stat = { minified: 0, copied: 0, before: 0, after: 0, skipped: 0 };
const warn = [];

/* ---- 路径守卫：绝不写进源目录 ---- */
const cwd = process.cwd();
const outAbs = path.resolve(cwd, outDir);

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/* 输出目录会在开跑时被清空重建，所以绝不能指向项目根 / 项目根的上级 / 系统根 */
if (outAbs === path.parse(outAbs).root || outAbs === cwd || inside(cwd, outAbs)) {
  console.error(`输出目录不能是系统根、当前目录或它的上级：${outDir}`);
  process.exit(2);
}

for (const root of ROOTS) {
  const srcAbs = path.resolve(cwd, root);
  if (outAbs === srcAbs || inside(outAbs, srcAbs)) {
    console.error(`输出目录不能放在源目录里：${outDir} ⊂ ${root}（会污染源码）`);
    process.exit(2);
  }
  if (inside(srcAbs, outAbs)) {
    console.error(`源目录不能放在输出目录里：${root} ⊂ ${outDir}`);
    process.exit(2);
  }
}

/* ---- 遍历 ---- */
async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/* ---- 各类资源的压缩器 ---- */

async function doJs(code) {
  const isModule = /^\s*(import|export)[\s{*]/m.test(code);
  const out = await minifyJs(code, {
    module: isModule,
    compress: { passes: 2 },
    /* 顶层名不混淆：home 的 js 全是经典脚本，靠全局变量互相通信（window.HA 等），
       混淆顶层声明会把 app.js 里的 HA 变成别的名字，运行时直接崩 */
    mangle: { toplevel: false },
    format: { comments: false, ascii_only: false },
  });
  if (!out || typeof out.code !== 'string' || !out.code) throw new Error('terser 没有输出');
  return out.code;
}

function doCss(code) {
  const out = new CleanCSS({ level: 1, returnPromise: false }).minify(code);
  if (out.errors && out.errors.length) throw new Error(out.errors.join('; '));
  return out.styles || code;
}

function doHtml(code) {
  return minifyHtml(code, {
    collapseWhitespace: true,
    conservativeCollapse: true,     // 折叠成一个空格，保留 Vue 插值两侧的间隔
    removeComments: true,
    removeRedundantAttributes: false,
    keepClosingSlash: true,
    minifyCSS: true,
    minifyJS: false,                // 内联脚本原样保留（里面是启动兜底逻辑，不值得冒险）
    removeOptionalTags: false,
    sortAttributes: false,
    sortClassName: false,
  });
}

function doJson(code) {
  return JSON.stringify(JSON.parse(code));
}

/* ---- 主流程：读源目录 → 写输出目录 ---- */

await fs.rm(outAbs, { recursive: true, force: true });      // 每次重建，避免残留旧产物
await fs.mkdir(outAbs, { recursive: true });

for (const root of ROOTS) {
  const srcAbs = path.resolve(cwd, root);
  const rel = path.relative(cwd, srcAbs);
  /* 输出按源目录名镜像：public → dist-min/public */
  const dstAbs = path.join(outAbs, rel && !rel.startsWith('..') ? rel : path.basename(srcAbs));

  let files;
  try { files = await walk(srcAbs); } catch (e) { console.warn(`跳过不存在的目录: ${root}`); continue; }

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const dst = path.join(dstAbs, path.relative(srcAbs, file));
    await fs.mkdir(path.dirname(dst), { recursive: true });

    /* 非文本资源：原样复制（glb / png / jpg / woff ...） */
    if (!HANDLED.has(ext)) {
      await fs.copyFile(file, dst);
      stat.copied += 1;
      continue;
    }
    if (ext === '.js' && SKIP_JS.test(file)) {
      await fs.copyFile(file, dst);
      stat.skipped += 1;
      continue;
    }

    const code = await fs.readFile(file, 'utf8');
    let out;
    try {
      if (ext === '.js') out = await doJs(code);
      else if (ext === '.css') out = doCss(code);
      else if (ext === '.json') out = doJson(code);
      else out = await doHtml(code);
    } catch (e) {
      warn.push(`${path.relative(cwd, file)}: ${e.message}（已原样复制）`);
      await fs.writeFile(dst, code);
      stat.skipped += 1;
      continue;
    }

    if (out.length >= code.length) {                     // 压不动就别动，照抄
      await fs.writeFile(dst, code);
      stat.skipped += 1;
      continue;
    }
    await fs.writeFile(dst, out);
    stat.minified += 1;
    stat.before += Buffer.byteLength(code);
    stat.after += Buffer.byteLength(out);
  }
}

const kb = (n) => (n / 1024).toFixed(1) + 'KB';
const saved = stat.before ? (100 - (stat.after / stat.before) * 100).toFixed(1) : '0';
console.log(`minify: ${stat.minified} 个文本文件 ${kb(stat.before)} → ${kb(stat.after)}（省 ${saved}%）`
  + `，原样复制 ${stat.copied} 个二进制，未压 ${stat.skipped} 个`);
console.log(`输出目录: ${path.relative(cwd, outAbs) || outAbs}（源目录未改动）`);
if (warn.length) {
  console.warn('minify 跳过（原样保留）：');
  for (const w of warn) console.warn('  · ' + w);
}
