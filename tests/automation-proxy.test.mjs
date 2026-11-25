'use strict';
/* home 服务端 automation 代理：候选列表 + 一次性触发。
 * 用本地 mock automation HTTP 服务 + 临时 DATA，不碰真实 automation / HA。 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-auto-proxy-'));
process.env.HA3D_DATA_DIR = tmp;
delete process.env.HA3D_AUTH_USER;
delete process.env.HA3D_AUTH_PASS;
delete process.env.HA3D_AUTH_PASS_HASH;
const { createApp } = require('../server/index.js');

let upstream = null;
let home = null;
let upstreamBase = '';
let homeBase = '';
const seen = [];

test.before(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/actions') {
      return res.end(JSON.stringify({ items: [{ id: 'abc123', name: '测试动作', kind: 'script', triggerable: true }] }));
    }
    if (req.url === '/api/script/abc123/trigger') {
      return res.end(JSON.stringify({ ok: true, id: 'abc123', version: 2, devMode: false }));
    }
    if (req.url === '/api/script/nopub/trigger') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: '脚本没有正式版本，无法触发（请先发布）' }));
    }
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => upstream.listen(0, resolve));
  upstreamBase = 'http://127.0.0.1:' + upstream.address().port;
  process.env.HA3D_AUTOMATION_URL = upstreamBase;

  home = createApp().listen(0);
  await new Promise((resolve) => home.once('listening', resolve));
  homeBase = 'http://127.0.0.1:' + home.address().port;
});

test.after(async () => {
  if (home) await new Promise((resolve) => home.close(resolve));
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
});

test('GET /api/automation/actions：经服务端代理转发，返回候选数组', async () => {
  const res = await fetch(homeBase + '/api/automation/actions');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].id, 'abc123');
  assert.deepEqual(seen[0], { method: 'GET', url: '/api/actions' });
});

test('POST /api/automation/trigger/:id：透传回执，上游地址不出现在响应', async () => {
  const res = await fetch(homeBase + '/api/automation/trigger/abc123', { method: 'POST' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.version, 2);
  assert.ok(!JSON.stringify(data).includes(upstreamBase));
});

test('触发非法 id 本地拒绝；上游错误原样带错误文案', async () => {
  const bad = await fetch(homeBase + '/api/automation/trigger/' + encodeURIComponent('../etc/passwd'), { method: 'POST' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /id 非法/);

  const noPub = await fetch(homeBase + '/api/automation/trigger/nopub', { method: 'POST' });
  assert.equal(noPub.status, 502);
  assert.match((await noPub.json()).error, /没有正式版本/);
});
