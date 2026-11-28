'use strict';
/*
 * tests/project-api.test.mjs — /api/project 与 /api/house/size（P1-6）。
 *
 * · POST /api/project 坏数据 400（normProject 拒绝）
 * · 合法数据保存后 GET 原样读回
 * · /api/house/size 两条路：墙包围盒现算（0.1m 取整）vs 无墙时回退 project.json
 *   里已存的 houseW/houseD（前端 serializeProject 写入；服务端 normProject 不保留）
 *
 * 顺序敏感：loadProject 有进程内缓存（首次读文件后固定），所以「回退」用例必须在
 * 任何保存动作之前跑（before 里直接写 project.json）；后续用例经 API 保存刷新缓存。
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-project-api-'));
process.env.HA3D_DATA_DIR = tmp;
delete process.env.HA3D_AUTH_USER;
delete process.env.HA3D_AUTH_PASS;
delete process.env.HA3D_AUTH_PASS_HASH;

const require = createRequire(import.meta.url);
const { createApp } = require('../server/index.js');

let home = null;
let base = '';

test.before(async () => {
  /* 预置一份前端 serializeProject 形态的存档（带 houseW/houseD，无墙） */
  fs.writeFileSync(path.join(tmp, 'project.json'), JSON.stringify({
    name: '回退', houseW: 12.5, houseD: 7.2,
    floors: [{ id: 'fl1', name: '一层', walls: [] }],
  }));
  home = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => home.once('listening', resolve));
  base = 'http://127.0.0.1:' + home.address().port;
});

test.after(async () => {
  if (home) await new Promise((resolve) => home.close(resolve));
});

const save = (body) => fetch(base + '/api/project', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('GET /api/house/size：无墙回退已存的 houseW/houseD', async () => {
  const ok = await (await fetch(base + '/api/house/size')).json();
  assert.deepEqual({ ok: ok.ok, houseW: ok.houseW, houseD: ok.houseD }, { ok: true, houseW: 12.5, houseD: 7.2 });
});

test('POST /api/project：无 floors 坏数据 400；合法数据保存后读回', async () => {
  const bad = await save({ name: '坏数据' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /不合法/);

  const ok = await save({
    name: '测试家',
    floors: [{
      id: 'fl1',
      name: '一层',
      walls: [{ id: 'w1', x1: 0, y1: 0, x2: 10, y2: 0 }, { id: 'w2', x1: 0, y1: 0, x2: 0, y2: 8 }],
      doors: [], windows: [], furniture: [], devices: [], rooms: [],
    }],
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).saved, true);

  const read = await fetch(base + '/api/project');
  assert.equal(read.status, 200);
  const proj = await read.json();
  assert.equal(proj.name, '测试家');
  assert.equal(proj.floors.length, 1);
  assert.equal(proj.floors[0].walls.length, 2);
});

test('GET /api/house/size：墙包围盒现算，0.1m 取整', async () => {
  await save({
    name: '现算',
    floors: [{ id: 'fl1', name: '一层', walls: [{ id: 'w3', x1: 1.23, y1: 2.34, x2: 10.11, y2: 2.34 }, { id: 'w4', x1: 1.23, y1: 2.34, x2: 1.23, y2: 9.87 }] }],
  });
  const data = await (await fetch(base + '/api/house/size')).json();
  assert.equal(data.ok, true);
  assert.equal(data.houseW, 8.9, '10.11 - 1.23 = 8.88 → 8.9');
  assert.equal(data.houseD, 7.5, '9.87 - 2.34 = 7.53 → 7.5');
});

test('GET /api/house/size：normProject 不保留 houseW，经 API 保存后无墙 → ok:false', async () => {
  await save({ name: '无墙', floors: [{ id: 'fl1', name: '一层', walls: [] }] });
  const none = await (await fetch(base + '/api/house/size')).json();
  assert.deepEqual(none, { ok: false, houseW: null, houseD: null });
});
