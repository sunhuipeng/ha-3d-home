'use strict';
/*
 * 最小 zip 读取器（零 npm 依赖，只用内置 zlib）。
 * 从 library.js 拆出（审计 3.1）：这是库级代码，家具包 / 插件包两条安装链共用，
 * 与 library.js 的业务（清单扫描 / 安装落盘）无关。
 *
 * 只走中央目录，支持 stored(0)/deflate(8)，不支持 zip64（安装包远小于 4GB）。
 * studio 打包用 jszip，产出正是 DEFLATE。
 */
const zlib = require('zlib');

/* 解压预算：压缩包本身 ≤64MB（library.js 的 INSTALL_MAX_BYTES），但 deflate 可以把
 * 几十 KB 撑成几十 GB（zip bomb）。单条目与整包都设上限，zlib 的 maxOutputLength
 * 会在超限当场抛错，不会先分配内存。 */
const UNZIP_MAX_ENTRY = 64 * 1024 * 1024;
const UNZIP_MAX_TOTAL = 128 * 1024 * 1024;

function toPosix(s) { return String(s).replace(/\\/g, '/'); }

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
  const name = toPosix(raw).replace(/^\.\/+/, '');
  if (!name || name.startsWith('/') || name.includes('\0')) return null;
  if (name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return name;
}

module.exports = { unzipEntries, normEntryName, UNZIP_MAX_ENTRY, UNZIP_MAX_TOTAL };
