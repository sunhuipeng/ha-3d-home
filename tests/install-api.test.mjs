'use strict';
/*
 * tests/install-api.test.mjs — 远程安装 / 导入 / 卸载 API 集成测试。
 *
 * 合同：
 *   · /api/plugins/install 是白名单里的匿名接口，但由 X-Install-Key 鉴权：
 *     未设密钥 401 → 错 key 401 → 对 key 放行
 *   · ?id= 与 X-Plugin-Id 同时出现必须一致
 *   · /api/plugins/import（编辑页本站上传）无需密钥
 *   · 安装成功后 /api/plugins 与 /api/catalog 快照重建；卸载后消失
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-install-api-'));
process.env.HA3D_DATA_DIR = tmp;
process.env.HA3D_CUSTOM_DIR = path.join(tmp, 'custom');
delete process.env.HA3D_AUTH_USER;
delete process.env.HA3D_AUTH_PASS;
delete process.env.HA3D_AUTH_PASS_HASH;

const require = createRequire(import.meta.url);
const { buildZip } = require('./helpers/zip.cjs');
const { createApp } = require('../server/index.js');

let home = null;
let base = '';

test.before(async () => {
  home = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => home.once('listening', resolve));
  base = 'http://127.0.0.1:' + home.address().port;
});

test.after(async () => {
  if (home) await new Promise((resolve) => home.close(resolve));
});

const pluginZip = (id) => buildZip([
  { name: 'plugin.json', data: JSON.stringify({ id, kind: 'device', name: '测试设备插件' }) },
  { name: 'plugin.js', data: 'PluginEngine.register({});' },
]);

const postZip = (url, zip, headers = {}) => fetch(base + url, {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/zip' }, headers), body: zip,
});

test('未配置安装密钥 → 401；设置密钥后错 key → 401', async () => {
  const noKey = await postZip('/api/plugins/install?id=myplug', pluginZip('myplug'));
  assert.equal(noKey.status, 401);
  assert.match((await noKey.json()).error, /未配置安装密钥/);

  const setKey = await fetch(base + '/api/install/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'testkey-123' }),
  });
  assert.equal(setKey.status, 200);
  assert.equal((await setKey.json()).keyTail, '-123');

  const cfg = await fetch(base + '/api/install/config');
  const c = await cfg.json();
  assert.equal(c.hasKey, true);
  assert.ok(!('key' in c), '密钥明文不下发');

  const wrongKey = await postZip('/api/plugins/install?id=myplug', pluginZip('myplug'), { 'X-Install-Key': 'wrong' });
  assert.equal(wrongKey.status, 401);
  assert.match((await wrongKey.json()).error, /不正确/);
});

test('?id 与 X-Plugin-Id 不一致 → 400；id 非法 → 400', async () => {
  const mismatch = await postZip('/api/plugins/install?id=aaa', pluginZip('bbb'), { 'X-Install-Key': 'testkey-123' });
  assert.equal(mismatch.status, 400);
  assert.match((await mismatch.json()).error, /不一致/);

  const badId = await postZip('/api/plugins/install?id=' + encodeURIComponent('../evil'), pluginZip('evil'), { 'X-Install-Key': 'testkey-123' });
  assert.equal(badId.status, 400);
});

test('远程安装成功：落盘 custom/plugins/<id>/，/api/plugins 快照可见', async () => {
  const res = await postZip('/api/plugins/install?id=myplug', pluginZip('myplug'), { 'X-Install-Key': 'testkey-123' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.kind, 'plugin');
  assert.equal(data.upgraded, false);
  assert.ok(fs.existsSync(path.join(tmp, 'custom', 'plugins', 'myplug', 'plugin.js')));

  const list = await fetch(base + '/api/plugins');
  const plugins = (await list.json()).plugins;
  assert.ok(plugins.some((p) => p.id === 'myplug' && p.custom === true), '安装的插件应出现在清单里');

  // 同 id 二次安装 = 覆盖升级
  const again = await postZip('/api/plugins/install?id=myplug', pluginZip('myplug'), { 'X-Install-Key': 'testkey-123' });
  const againData = await again.json();
  assert.equal(againData.upgraded, true);
});

test('编辑页导入（无密钥）：家具包 → /api/catalog 出现 <项目id>:<条目id>', async () => {
  const itemJson = {
    kind: 'catalog', id: 'roompack', name: '卧室套装',
    items: [{ id: 'bed1', name: '双人床', type: 'bed', w: 1.8, d: 2.0 }],
  };
  const zip = buildZip([
    { name: 'item.json', data: JSON.stringify(itemJson) },
    { name: 'bed.glb', data: Buffer.from([0x67, 0x6c, 0x54, 0x46]) },
  ]);
  const res = await postZip('/api/plugins/import', zip);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.kind, 'catalog');
  assert.equal(data.items[0].id, 'roompack:bed1');

  const catalog = await fetch(base + '/api/catalog');
  const body = await catalog.json();
  assert.ok(body.items.some((it) => it.id === 'roompack:bed1'), '导入的家具应出现在目录');
  assert.ok(Array.isArray(body.types) && body.types.length > 0);
});

test('卸载 API：kind=catalog 删除目录且目录快照消失；坏 kind 400', async () => {
  const badKind = await fetch(base + '/api/uninstall', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'oops', dir: 'roompack' }),
  });
  assert.equal(badKind.status, 400);

  const res = await fetch(base + '/api/uninstall', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'catalog', dir: 'roompack' }),
  });
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(path.join(tmp, 'custom', 'plugins', 'myplug')), '插件目录不受影响');
  assert.equal(fs.existsSync(path.join(tmp, 'custom', 'models', 'roompack')), false);

  const catalog = await fetch(base + '/api/catalog');
  const body = await catalog.json();
  assert.ok(!body.items.some((it) => it.id === 'roompack:bed1'), '卸载后目录快照重建');
});
