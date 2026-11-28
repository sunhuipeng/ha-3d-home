'use strict';
/*
 * tests/ha-media.test.mjs — HA 媒体代理（/api/ha-media/*）集成测试。
 *
 * 合同：
 *   · 转发时带服务端落盘 token（Bearer），Content-Type / Cache-Control 原样带回
 *   · 上游 HTTP 错误状态码透传
 *   · 上游不可达 → 502，且错误文案不泄漏 HA 内网地址
 *   · 未配置 HA → 503
 *
 * （注：上游流中途断开的进程不崩回归，归 4-后端.1 修复轮一并补——
 *   当前实现 pipe 无 error 监听，对着坏实现写会直接打死测试进程。）
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-media-'));
process.env.HA3D_DATA_DIR = tmp;
process.env.HA3D_CUSTOM_DIR = path.join(tmp, 'custom');
delete process.env.HA3D_AUTH_USER;
delete process.env.HA3D_AUTH_PASS;
delete process.env.HA3D_AUTH_PASS_HASH;

const require = createRequire(import.meta.url);
const { createApp } = require('../server/index.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let ha = null;       // mock HA
let haBase = '';
let home = null;
let base = '';
const seen = [];

test.before(async () => {
  ha = http.createServer((req, res) => {
    const p = req.url.split('?')[0];   // 查询串不参与路由匹配（token=abc 是 HA 侧的）
    seen.push({ url: req.url, auth: req.headers.authorization || '' });
    if (p === '/api/config') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ version: '2026.1', location_name: '家' }));
    }
    if (p === '/ok.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=60' });
      return res.end(PNG);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  });
  await new Promise((resolve) => ha.listen(0, '127.0.0.1', resolve));
  haBase = 'http://127.0.0.1:' + ha.address().port;
});

test.after(async () => {
  if (home) await new Promise((resolve) => home.close(resolve));
  if (ha) await new Promise((resolve) => ha.close(resolve));
});

test.before(async () => {
  home = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => home.once('listening', resolve));
  base = 'http://127.0.0.1:' + home.address().port;
  // 配置 HA 地址 + token（POST 会顺带触发连接测试，mock 已备 /api/config）
  await fetch(base + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ haUrl: haBase, token: 'ha-token-xyz' }),
  });
});

test('媒体转发：带 Bearer token、回传 Content-Type/Cache-Control 与字节', async () => {
  const res = await fetch(base + '/api/ha-media/ok.png?token=abc');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=60');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...buf], [...PNG]);
  assert.equal(seen[seen.length - 1].url, '/ok.png?token=abc', '查询串原样拼接');
  assert.equal(seen[seen.length - 1].auth, 'Bearer ha-token-xyz', '转发必须带服务端 token');
});

test('上游 404 → 状态码透传', async () => {
  const res = await fetch(base + '/api/ha-media/missing.png');
  assert.equal(res.status, 404);
});

test('上游不可达 → 502 且不泄漏 HA 地址', async () => {
  await fetch(base + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ haUrl: 'http://127.0.0.1:9', token: 'ha-token-xyz' }),
  });
  const res = await fetch(base + '/api/ha-media/ok.png');
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.ok(!data.error.includes('127.0.0.1:9'), '内网地址必须抹掉: ' + data.error);
});

test('未配置 HA → 503', async () => {
  await fetch(base + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ haUrl: '', token: 'ha-token-xyz' }),
  });
  const res = await fetch(base + '/api/ha-media/ok.png');
  assert.equal(res.status, 503);
});
