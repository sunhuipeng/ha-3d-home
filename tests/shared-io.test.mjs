'use strict';
/*
 * tests/shared-io.test.mjs — shared.js 的 JSON 持久化与请求体读取。
 *
 *   · 原子写（tmp + rename）：经 saveProject / setInstallKey 走 writeJSON，
 *     成功后 data/ 不留 .tmp 残留
 *   · readJSON：文件不存在 / 损坏 → fallback
 *   · readRawBody（= collectBody 包装）：超限拒绝（status 413）
 *   · readBody：合法 JSON 解析；非法 JSON / 空 body → null（由调用端判断）
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-shared-io-'));
process.env.HA3D_DATA_DIR = tmp;
process.env.HA3D_CUSTOM_DIR = path.join(tmp, 'custom');

const require = createRequire(import.meta.url);
const core = require('../server/shared.js');

test('原子写：saveProject 落盘 data/project.json 且无 .tmp 残留', () => {
  const proj = { name: '家', floors: [{ id: 'f1', name: 'L1' }] };
  const r = core.saveProject(proj);
  assert.equal(r.saved, true);
  assert.deepEqual(core.readJSON(path.join(tmp, 'project.json'), null), proj);
  assert.deepEqual(core.loadProject(), proj, '保存后缓存同步刷新');
  const leftovers = fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'rename 后不得留临时文件');
});

test('原子写：setInstallKey 落盘 install-key.json；installKey() 读回', () => {
  core.setInstallKey('testkey-123');
  assert.equal(core.installKey(), 'testkey-123');
  assert.deepEqual(core.readJSON(path.join(tmp, 'install-key.json'), null), { key: 'testkey-123' });
});

test('readJSON：文件不存在 / 损坏 → fallback', () => {
  assert.equal(core.readJSON(path.join(tmp, 'nope.json'), 'fb'), 'fb');
  const broken = path.join(tmp, 'broken.json');
  fs.writeFileSync(broken, '{not json');
  assert.equal(core.readJSON(broken, null), null);
});

const reqOf = (chunks) => Readable.from(chunks);

test('readRawBody：超限拒绝且错误带 status 413；正常读取原文', async () => {
  const e = await core.readRawBody(reqOf([Buffer.alloc(100), Buffer.alloc(100)]), 50).catch((err) => err);
  assert.ok(e);
  assert.equal(e.status, 413);
  const ok = await core.readRawBody(reqOf([Buffer.from('abc')]), 50);
  assert.equal(ok.toString(), 'abc');
});

test('readBody：合法 JSON 解析；非法 JSON / 空 body → null', async () => {
  assert.deepEqual(await core.readBody(reqOf([Buffer.from('{"a":1}')])), { a: 1 });
  assert.equal(await core.readBody(reqOf([Buffer.from('{bad')])), null);
  assert.equal(await core.readBody(reqOf([])), null);
});
