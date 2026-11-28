'use strict';
/*
 * tests/shared-project.test.mjs — normProject 全字段校验锁定。
 *
 * project.json 一旦写坏，两个页面都起不来 —— normProject 是 POST/PUT /api/project
 * 的唯一防线：坏元素逐个丢弃（不整包拒绝）、字符串收数字、越界收口、骨架兜底。
 * 这里把策略逐条固化，防止后续重构（如 shared.js 拆分）时口径漂移。
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-shared-proj-'));
process.env.HA3D_DATA_DIR = tmp;
process.env.HA3D_CUSTOM_DIR = path.join(tmp, 'custom');

const require = createRequire(import.meta.url);
const { normProject } = require('../server/shared.js');

const fl = (over = {}) => Object.assign({ id: 'f1', name: '一楼' }, over);
const proj = (floors, over = {}) => Object.assign({ name: '家', floors }, over);
const wall = (over = {}) => Object.assign({ id: 'w1', x1: 0, y1: 0, x2: 3, y2: 0 }, over);

test('normProject：非对象 / 无 floors / 空 floors / 超过 50 层 → null', () => {
  assert.equal(normProject(null), null);
  assert.equal(normProject('x'), null);
  assert.equal(normProject([]), null);
  assert.equal(normProject({ name: '家' }), null);
  assert.equal(normProject({ floors: [] }), null);
  assert.equal(normProject({ floors: Array.from({ length: 51 }, () => fl()) }), null);
});

test('normProject：最小合法项目 → 骨架兜底（数组补空 / height 2.8 / wallOpacity 45 / display settings name）', () => {
  const p = normProject(proj([fl()]));
  assert.ok(p, '应通过');
  const f = p.floors[0];
  for (const k of ['walls', 'doors', 'windows', 'furniture', 'devices', 'rooms']) {
    assert.deepEqual(f[k], [], k + ' 缺省应补空数组');
  }
  assert.equal(f.height, 2.8);
  assert.equal(f.wallOpacity, 45);
  assert.deepEqual(f.display, {});
  assert.deepEqual(p.settings, {});
  assert.equal(p.name, '家');
});

test('normProject：楼层无 id / name 非字符串 → 丢层或整包拒绝', () => {
  const p = normProject(proj([{ name: '孤儿层' }, fl()]));
  assert.equal(p.floors.length, 1, '无 id 楼层丢弃，不影响其他层');
  assert.equal(p.floors[0].id, 'f1');
  assert.equal(normProject(proj([{ id: 'f1' }])), null, 'name 缺失 → null');
  assert.equal(normProject(proj([{ id: 'f1', name: '  ' }])), null, 'name 空白 → null');
});

test('normProject：坏元素丢弃、好元素保留（不整包 400）', () => {
  const f = fl({
    walls: [
      wall(),
      { id: 'bad', x1: NaN, y1: 0, x2: 1, y2: 1 },      // 坐标 NaN
      { x1: 0, y1: 0, x2: 1, y2: 1 },                   // 缺 id
      wall({ id: 'far', x1: 99999, y1: 0, x2: 100, y2: 0 }), // 坐标越界
      wall({ id: 'w2', x2: '4.5' }),                     // 字符串坐标也能收
    ],
  });
  const p = normProject(proj([f]));
  assert.equal(p.floors[0].walls.length, 2);
  assert.equal(p.floors[0].walls[1].x2, 4.5, '纯数值字符串宽收');
  assert.equal(p.floors[0].walls[1].t, 0.24, 't 缺省 0.24');
});

test('normProject：墙厚 t 与楼层层高 / 墙透明度收口到安全区间', () => {
  const f = fl({
    walls: [wall({ t: 5 }), wall({ id: 'w2', t: 0.5 })],
    height: -3, wallOpacity: 120,
  });
  const p = normProject(proj([f]));
  assert.equal(p.floors[0].walls[0].t, 0.24, 't 越界 → 0.24');
  assert.equal(p.floors[0].walls[1].t, 0.5, 't 合法保留');
  assert.equal(p.floors[0].height, 2.8, 'height 非法 → 2.8');
  assert.equal(p.floors[0].wallOpacity, 45, 'wallOpacity 越界 → 45');

  const p2 = normProject(proj([fl({ height: 5, wallOpacity: '80' })]));
  assert.equal(p2.floors[0].height, 5);
  assert.equal(p2.floors[0].wallOpacity, 80, '字符串数字收口');
});

test('normProject：单类元素超 2000 截断；rooms 顶点不足 3 个丢弃', () => {
  const many = Array.from({ length: 2001 }, (_, i) => wall({ id: 'w' + i }));
  const f = fl({
    walls: many,
    rooms: [
      { id: 'r1', pts: [[0, 0], [4, 0], [4, 3], [0, 3]], name: '客厅' },
      { id: 'r2', pts: [[0, 0], [4, 0]] },               // 只有 2 点
      { id: 'r3', pts: [[0, 0], [4, NaN], [1, 1]] },     // 坏点过滤后不足 3
      { id: 'r4', pts: [[0, 0], ['2', '2'], [4, 3], [0, 3]] }, // 字符串点收
    ],
  });
  const p = normProject(proj([f]));
  assert.equal(p.floors[0].walls.length, 2000);
  const rooms = p.floors[0].rooms;
  assert.equal(rooms.length, 2);
  assert.equal(rooms[0].name, '客厅');
  assert.deepEqual(rooms[1].pts[1], [2, 2], '字符串顶点收数');
});

test('normProject：device / furniture 最低渲染条件与字段清理', () => {
  const f = fl({
    devices: [
      { id: 'd1', x: 1, y: 2, z: 0.5, rot: 90, labelOffset: 0.2, type: 'light' },
      { id: 'd2', x: NaN, y: 2 },                        // 丢
      { id: 'd3', x: 1, y: 2, rot: 1e9, labelOffset: 99 }, // 越界字段删除
    ],
    furniture: [
      { id: 's1', mid: 'sofa', x: 1, y: 1, scale: 2 },
      { id: 's2', mid: 'sofa', x: 1, y: 1, scale: 999 }, // scale 越界删除
      { id: 's3', mid: '', x: 1, y: 1 },                 // 丢
    ],
  });
  const p = normProject(proj([f]));
  const [d1, d3] = [p.floors[0].devices[0], p.floors[0].devices[1]];
  assert.equal(p.floors[0].devices.length, 2);
  assert.equal(d1.rot, 90);
  assert.equal(d3.rot, undefined, '越界 rot 删除');
  assert.equal(d3.labelOffset, undefined);
  assert.equal(p.floors[0].furniture.length, 2, 's2 只删越界 scale 字段，元素保留');
  assert.equal(p.floors[0].furniture[0].scale, 2);
  assert.equal(p.floors[0].furniture[1].scale, undefined, 'scale 999 → 字段删除');
});

test('normProject：display 非对象 → null；settings/name 畸形兜底', () => {
  assert.equal(normProject(proj([fl({ display: [] })])), null);
  const p = normProject(proj([fl({ display: null })], { name: 123, settings: 'x' }));
  assert.deepEqual(p.floors[0].display, {}, 'display null 兜底空对象');
  assert.equal(p.name, '我的家', '数字 name → 兜底默认名');
  assert.deepEqual(p.settings, {});
});

test('normProject：门窗 z 缺省删除、rot 收口；w 非法回 1', () => {
  const f = fl({
    doors: [{ id: 'door1', x: 1, y: 0, w: 0.9, rot: 45 }],
    windows: [{ id: 'win1', x: 1, y: 1, w: -2, z: 1.2, rot: 9999999 }],
  });
  const p = normProject(proj([f]));
  assert.equal(p.floors[0].doors[0].w, 0.9);
  assert.equal(p.floors[0].doors[0].rot, 45);
  assert.equal(p.floors[0].windows[0].w, 1, 'w 非法 → 1');
  assert.equal(p.floors[0].windows[0].rot, 0, 'rot 越界 → 0');
  assert.equal(p.floors[0].windows[0].z, 1.2);
});
