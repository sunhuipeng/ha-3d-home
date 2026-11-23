/**
 * 插件清理列表派生单测（零浏览器 / 零 Vue，直接 node 跑）。
 *   node --test tests/plugin-cleanup.test.mjs
 * 覆盖：自定义筛选、显式 style、缺省 style 兜底、背景 alias、家具包 mid/model、id≠dir。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeCleanupList } from '../src/model/pluginCleanup.js';

const LIST = [
  { id: 'light', dir: 'light', type: 'light', kind: 'device' },                    // 内置
  { id: 'custom_sw', dir: 'dir_sw', name: '自定义开关', type: 'switch', kind: 'device', custom: true },
  { id: 'custom_bg', dir: 'dir_bg', name: '自定义背景', kind: 'background', custom: true },
  { id: 'custom_orphan', dir: 'dir_orphan', type: 'vacuum', kind: 'device', custom: true },
];
const DEFS = {
  custom_sw: { styles: [{ id: 'plug', name: '插座' }, { id: 'panel', name: '面板' }] },
  custom_bg: { styles: [{ id: 'grass', name: '草地' }, { id: 'snow', name: '雪地' }] },
  custom_orphan: { styles: [{ id: 'robot', name: '机器人' }] },
};
const CATALOG = [
  { id: 'bed', name: '床', type: 'bed', custom: false },                          // 内置
  { id: 'pack1:chair', sid: 'chair', pack: 'pack1', name: '椅子', model: '/custom/models/pack1/chair.glb', custom: true },
  { id: 'pack1:table', sid: 'table', pack: 'pack1', name: '桌子', model: '/custom/models/pack1/table.glb', custom: true },
  { id: 'pack2:sofa', sid: 'sofa', pack: 'pack2', name: '沙发', model: '/custom/models/pack2/sofa.glb', custom: true },
];

test('只输出自定义项：内置插件/家具不进列表', () => {
  const got = computeCleanupList({ floors: [], settings: {} }, CATALOG, LIST, DEFS);
  assert.deepEqual(got.map((x) => x.id).sort(), ['custom_bg', 'custom_orphan', 'custom_sw', 'pack1', 'pack2']);
});

test('家具包按 pack 聚合为一行，id/dir = pack', () => {
  const got = computeCleanupList({ floors: [], settings: {} }, CATALOG, LIST, DEFS);
  const p1 = got.find((x) => x.id === 'pack1');
  assert.equal(p1.kind, 'catalog');
  assert.equal(p1.dir, 'pack1');
  assert.equal(p1.styles.length, 2, '一个家具模型一行');
  assert.equal(p1.used, false);
});

test('显式 style 引用：逐样式标记，整体 used，删除禁用', () => {
  const project = {
    floors: [{ devices: [{ type: 'switch', style: 'custom_sw:plug' }] }],
    settings: {},
  };
  const got = computeCleanupList(project, CATALOG, LIST, DEFS);
  const sw = got.find((x) => x.id === 'custom_sw');
  assert.equal(sw.used, true);
  const plug = sw.styles.find((s) => s.id === 'custom_sw:plug');
  const panel = sw.styles.find((s) => s.id === 'custom_sw:panel');
  assert.equal(plug.used, true, '显式引用的样式标 used');
  assert.equal(panel.used, false, '未引用的样式标未引用');
  assert.equal(sw.dir, 'dir_sw', '删除按 dir 而非 id');
});

test('缺省 style 兜底：开关无 style → 默认插件 custom_sw 算被引用', () => {
  /* LIST 里 switch 类型只有 custom_sw 一个 → defaultIdForType 命中它 */
  const project = { floors: [{ devices: [{ type: 'switch' }] }], settings: {} };
  const got = computeCleanupList(project, CATALOG, LIST, DEFS);
  const sw = got.find((x) => x.id === 'custom_sw');
  assert.equal(sw.used, true, '缺省 style 的 type 兜底算被引用');
  assert.ok(sw.styles.some((s) => s.used), '缺省命中时至少一个样式被标记');
});

test('缺省兜底不会被别的自定义插件误命中', () => {
  const project = { floors: [{ devices: [{ type: 'switch' }] }], settings: {} };
  const got = computeCleanupList(project, CATALOG, LIST, DEFS);
  const orphan = got.find((x) => x.id === 'custom_orphan');
  assert.equal(orphan.used, false, 'vacuum 没出现，custom_orphan 可删');
});

test('背景引用：settings.background 按插件 id 精确命中，逐样式标记', () => {
  const project = { floors: [], settings: { background: 'custom_bg:grass' } };
  const got = computeCleanupList(project, CATALOG, LIST, DEFS);
  const bg = got.find((x) => x.id === 'custom_bg');
  assert.equal(bg.used, true);
  assert.equal(bg.styles.find((s) => s.id === 'custom_bg:grass').used, true);
  assert.equal(bg.styles.find((s) => s.id === 'custom_bg:snow').used, false);
});

test('家具包引用：mid 命中单个模型 → 整包禁用删除，另一个模型标未引用', () => {
  const project = { floors: [{ furniture: [{ mid: 'pack1:chair' }] }], settings: {} };
  const got = computeCleanupList(project, CATALOG, LIST, DEFS);
  const p1 = got.find((x) => x.id === 'pack1');
  assert.equal(p1.used, true);
  assert.equal(p1.styles.find((s) => s.id === 'pack1:chair').used, true);
  assert.equal(p1.styles.find((s) => s.id === 'pack1:table').used, false);
  assert.equal(got.find((x) => x.id === 'pack2').used, false);
});

test('家具包引用：实例手改 model 反查也算引用', () => {
  const project = { floors: [{ furniture: [{ model: '/custom/models/pack2/sofa.glb' }] }], settings: {} };
  const got = computeCleanupList(project, CATALOG, LIST, DEFS);
  assert.equal(got.find((x) => x.id === 'pack2').used, true);
});

test('样式定义未加载时仍把项目引用到的样式列出来，避免误删', () => {
  const project = {
    floors: [{ devices: [{ type: 'switch', style: 'custom_sw:legacy' }] }],
    settings: {},
  };
  const got = computeCleanupList(project, CATALOG, LIST, {});
  const sw = got.find((x) => x.id === 'custom_sw');
  assert.equal(sw.used, true);
  assert.ok(sw.styles.some((s) => s.id === 'custom_sw:legacy' && s.used));
});

test('异常输入不抛错，返回空数组', () => {
  assert.deepEqual(computeCleanupList(null, null, null, null), []);
  assert.deepEqual(computeCleanupList({}, [], [], {}), []);
});
