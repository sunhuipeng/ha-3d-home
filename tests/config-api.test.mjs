'use strict';
/*
 * tests/config-api.test.mjs — 连接配置 API 合同锁定。
 *
 * 关键合同（2026-11-19 起 HA 鉴权由服务端代管）：
 *   · GET /api/config 只回 { haUrl, hasToken }，令牌绝不读回
 *   · POST 对非字符串字段回退当前值（不崩 500）
 *   · /api/config/test 连接失败也回 200，靠 body.ok 表达
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-config-api-'));
process.env.HA3D_DATA_DIR = tmp;
process.env.HA3D_CUSTOM_DIR = path.join(tmp, 'custom');
delete process.env.HA3D_AUTH_USER;
delete process.env.HA3D_AUTH_PASS;
delete process.env.HA3D_AUTH_PASS_HASH;

const require = createRequire(import.meta.url);
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

test('GET /api/config：不下发 token，只给 haUrl 与 hasToken 布尔', async () => {
  const res = await fetch(base + '/api/config');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(Object.keys(data).sort(), ['haUrl', 'hasToken']);
  assert.equal(data.hasToken, false);
  assert.ok(!('token' in data), '令牌字段不得出现');
});

test('POST /api/config：字符串 token 保存；后续 GET 只见 hasToken=true', async () => {
  const res = await fetch(base + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ haUrl: '', token: 'tok-secret-123' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.saved, true);
  assert.equal(data.test.ok, false, 'haUrl 为空不发起 HA 连接测试');

  const get = await fetch(base + '/api/config');
  const cfg = await get.json();
  assert.equal(cfg.hasToken, true, 'token 已保存');
  assert.ok(!('token' in cfg));
});

test('POST /api/config：token 传数字 / haUrl 传对象 → 回退旧值不崩', async () => {
  const res = await fetch(base + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ haUrl: { evil: 1 }, token: 999 }),
  });
  assert.equal(res.status, 200, '畸形输入不得 500');
  const get = await fetch(base + '/api/config');
  const cfg = await get.json();
  assert.equal(cfg.hasToken, true, 'token 数字 → 回退旧值 tok-secret-123');
  assert.equal(cfg.haUrl, '', 'haUrl 对象 → 回退旧值空串');
});

test('POST /api/config/test：未配置地址 → 200 + ok:false（HTTP 状态恒 200）', async () => {
  const res = await fetch(base + '/api/config/test', { method: 'POST' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.match(data.error, /未配置 Home Assistant 地址/);
});
