'use strict';
/*
 * tests/library-install.test.mjs — 安装包解析 / 落盘 / 卸载的安全防护锁定。
 *
 * 覆盖 server/library.js 的三条不可破防线（全部来自外部不可信输入）：
 *   1. zip 条目名归一化：../、绝对路径、反斜杠、空段 —— 一律 400 且不落盘
 *   2. zip bomb 限额：中央目录声明的解压后大小超限当场拒绝（zlib maxOutputLength 同理）
 *   3. 卸载双重防护：目录名白名单 + 父目录 resolve 校验
 * 另覆盖最小插件包 / 家具包的正常安装路径与 requireId 一致性校验。
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-lib-install-'));
process.env.HA3D_DATA_DIR = tmp;
process.env.HA3D_CUSTOM_DIR = tmp;   // custom/ 即临时根：models/ plugins/ 都落这里

const require = createRequire(import.meta.url);
const { buildZip } = require('./helpers/zip.cjs');
const { installPackage, uninstallPlugin, uninstallCatalog } = require('../server/library.js');

const statusOf = (fn) => {
  try { fn(); } catch (e) { return e; }
  return null;
};

test('installPackage：路径穿越条目（../、..\\、绝对路径、空段）全部 400 且不落盘', () => {
  const zip = buildZip([
    { name: '../evil.js', data: 'pwned' },
    { name: 'a/../../evil2.js', data: 'pwned' },
    { name: '/abs.js', data: 'pwned' },
    { name: '..\\evil3.js', data: 'pwned' },
    { name: 'plugin.json', data: JSON.stringify({ id: 'evil', kind: 'device', name: 'x' }) },
    { name: 'plugin.js', data: 'PluginEngine.register({});' },
  ]);
  const e = statusOf(() => installPackage(zip, 'evil'));
  assert.ok(e, '必须拒绝');
  assert.equal(e.status, 400);
  assert.match(e.message, /不安全的文件名/);
  assert.equal(fs.existsSync(path.join(tmp, 'plugins')), false, '不得创建 plugins 目录');
  assert.equal(fs.existsSync(path.join(tmp, 'models')), false, '不得创建 models 目录');
});

test('installPackage：zip bomb —— 中央目录声明解压后 >64MB 当场拒绝', () => {
  // 实际数据只有几字节，伪造 rawSize = 100MB
  const zip = buildZip([
    { name: 'plugin.json', data: JSON.stringify({ id: 'bomb', kind: 'device' }), rawSize: 100 * 1024 * 1024 },
    { name: 'plugin.js', data: 'x' },
  ]);
  const e = statusOf(() => installPackage(zip, 'bomb'));
  assert.ok(e);
  assert.equal(e.status, 400);
  assert.match(e.message, /过大|zip 条目解压后/);
});

test('installPackage：最小插件包正常安装（目录落盘 + 返回 files）', () => {
  const zip = buildZip([
    { name: 'plugin.json', data: JSON.stringify({ id: 'myplug', kind: 'device', name: '测试插件', version: '1.0.0' }) },
    { name: 'plugin.js', data: 'PluginEngine.register({});' },
    { name: 'models/box.glb', data: Buffer.from([0x67, 0x6c, 0x54, 0x46]) },
  ]);
  const r = installPackage(zip, 'myplug');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'plugin');
  assert.equal(r.upgraded, false, '首次安装');
  assert.ok(r.files.includes('models/box.glb'));
  assert.equal(fs.readFileSync(path.join(tmp, 'plugins', 'myplug', 'plugin.js'), 'utf8'), 'PluginEngine.register({});');
});

test('installPackage：requireId 与清单 id 不一致 → 400', () => {
  const zip = buildZip([
    { name: 'plugin.json', data: JSON.stringify({ id: 'other', kind: 'device' }) },
    { name: 'plugin.js', data: 'x' },
  ]);
  const e = statusOf(() => installPackage(zip, 'myplug'));
  assert.ok(e);
  assert.equal(e.status, 400);
  assert.match(e.message, /不一致/);
});

test('installPackage：插件白名单 —— 多余文件 / plugin.js 缺失拒绝', () => {
  const extra = buildZip([
    { name: 'plugin.json', data: JSON.stringify({ id: 'x1', kind: 'device' }) },
    { name: 'plugin.js', data: 'x' },
    { name: 'hack.sh', data: 'rm -rf' },
  ]);
  const e1 = statusOf(() => installPackage(extra, 'x1'));
  assert.equal(e1.status, 400);
  assert.match(e1.message, /不允许的文件/);

  const noJs = buildZip([
    { name: 'plugin.json', data: JSON.stringify({ id: 'x2', kind: 'device' }) },
  ]);
  const e2 = statusOf(() => installPackage(noJs, 'x2'));
  assert.equal(e2.status, 400);
  assert.match(e2.message, /缺少 plugin\.js/);
});

test('installPackage：最小家具包（套一层目录）安装成功，item id = 项目id:条目id', () => {
  const itemJson = {
    kind: 'catalog', id: 'pack01', name: '客厅套装', version: '1.0.0',
    items: [{ id: 'sofa', name: '三人沙发', type: 'sofa', w: 2.1, d: 0.9, model: 'sofa.glb' }],
  };
  const zip = buildZip([
    { name: 'pack01/item.json', data: JSON.stringify(itemJson) },
    { name: 'pack01/sofa.glb', data: Buffer.from([0x67, 0x6c, 0x54, 0x46]) },
  ]);
  const r = installPackage(zip, null);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'catalog');
  assert.equal(r.count, 1);
  assert.equal(r.items[0].id, 'pack01:sofa');
  assert.ok(fs.existsSync(path.join(tmp, 'models', 'pack01', 'item.json')));
  assert.ok(fs.existsSync(path.join(tmp, 'models', 'pack01', 'sofa.glb')));
});

test('installPackage：kind 混装（catalog + device）→ 400 要求拆包', () => {
  const zip = buildZip([
    { name: 'item.json', data: JSON.stringify({ kind: 'catalog', id: 'a1', items: [{ id: 'x', name: 'X', type: 'other', w: 1, d: 1 }] }) },
    { name: 'x.glb', data: 'glb' },
    { name: 'plugin.json', data: JSON.stringify({ id: 'a2', kind: 'device' }) },
    { name: 'plugin.js', data: 'x' },
  ]);
  const e = statusOf(() => installPackage(zip, null));
  assert.equal(e.status, 400);
  assert.match(e.message, /拆成两个包/);
});

test('uninstallPlugin/uninstallCatalog：白名单 + 父目录双重防护', () => {
  for (const dir of ['../models', '..', 'a/b', '../../data', '.old-x', 'Sub', 'a\\b']) {
    const e1 = statusOf(() => uninstallPlugin(dir));
    assert.ok(e1, 'plugin 卸载应拒绝: ' + dir);
    assert.equal(e1.status, 400, dir);
    const e2 = statusOf(() => uninstallCatalog(dir));
    assert.equal(e2.status, 400, dir);
  }
});

test('uninstall：不存在 → 404；存在 → 删除并清目录', () => {
  const e = statusOf(() => uninstallPlugin('notexist'));
  assert.equal(e.status, 404);

  fs.mkdirSync(path.join(tmp, 'plugins', 'goodplug'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'plugins', 'goodplug', 'plugin.js'), 'x');
  const r = uninstallPlugin('goodplug');
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(tmp, 'plugins', 'goodplug')), false);
});

test('uninstallCatalog：目录名合法但带路径段 → 400，绝不触达 custom 之外的 data', () => {
  // data/auth-sessions.json 与 models 同在 tmp 下，若白名单失守 ../../data 可达
  fs.mkdirSync(path.join(tmp, 'models', 'fine'), { recursive: true });
  const e = statusOf(() => uninstallCatalog('fine/../../data'));
  assert.equal(e.status, 400);
  assert.ok(fs.existsSync(path.join(tmp, 'models', 'fine')), '合法目录不受影响');
});
