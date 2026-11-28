'use strict';
/*
 * tests/helpers/zip.cjs — 手写最小 zip 构造器（零依赖，stored 条目）。
 *
 * 供 library-install / install-api 测试构造插件包与家具包，并复现恶意包：
 *   · entries: [{ name, data(Buffer|string), rawSize? }]
 *     rawSize 可伪造中央目录里声明的"解压后大小"（测 zip bomb 限额路径）；
 *   · name 原样写入（不做任何归一化），所以能构造 ../evil.js、/abs.js、..\evil.js
 *     等穿越条目名 —— 服务端 normEntryName 的防护正是针对这些。
 *
 * 与 server/library.js unzipEntries 对读：本地头 + 中央目录 + EOCD，全部 stored(0)。
 */
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime() {
  // 固定 2026-01-01 00:00:00（低字 time，高字 date）
  return { time: 0, date: ((2026 - 1980) << 9) | (1 << 5) | 1 };
}

/**
 * 构造 zip Buffer。
 * @param {Array<{name:string, data:Buffer|string, rawSize?:number}>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosDateTime();

  for (const ent of entries) {
    const data = Buffer.isBuffer(ent.data) ? ent.data : Buffer.from(String(ent.data), 'utf8');
    const nameBuf = Buffer.from(ent.name, 'utf8');
    const crc = crc32(data);
    const compSize = data.length;
    const rawSize = ent.rawSize != null ? ent.rawSize : data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header sig
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(rawSize, 22);     // 本地头声明值也同步伪造
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra len
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir sig
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);         // method: stored
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compSize, 20);
    central.writeUInt32LE(rawSize, 24);   // 可伪造的"解压后大小"
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra len
    central.writeUInt16LE(0, 32);         // comment len
    central.writeUInt16LE(0, 34);         // disk start
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0, 38);         // external attrs
    central.writeUInt32LE(offset, 42);    // local header offset
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);       // cd offset（本地数据总长）
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

module.exports = { buildZip };
