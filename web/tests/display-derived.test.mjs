/*
 * tests/display-derived.test.mjs — 领域派生纯函数单测
 *
 * 两条主线：
 *   ① 选中范围 / 统计类函数与重构前算式逐点一致（含 scopeDevices 必须返回新数组）；
 *   ② 2026-11-15 展示项改造：配置列表是主表、HA 状态只做增强，场景 / 脚本 /
 *      开关实体混排，图标与服务的兜底链、上限、开关态都对。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  devicesOf, allDevicesOf, scopeDevicesOf, countOn, roomTabsOf, displayItemsOf,
  statusTextOf, netClassOf, cardKeyOf, isAllOf, activeIdOf,
} from '../src/model/displayDerived.js';
import {
  displayActionOf, domainMdiOf, isToggleDomain, MAX_DISPLAY_ITEMS, TOGGLE_DOMAINS,
} from '../src/model/displayAction.js';
import { sceneIcon } from '../src/model/sceneIcon.js';
import { haIconOf } from '../src/services/haIcon.js';

/* ---- 重构前的算式（逐字复制自 PanelApp.vue / DisplayApp.vue，作为基准） ---- */
function oldScopeDevices(fl, sel) {
  if (!fl) return [];
  const s = sel || {};
  if (s.kind === 'room') return (fl.devices || []).filter((d) => d.roomId === s.id);
  if (s.kind === 'device') return (fl.devices || []).filter((d) => d.id === s.id);
  if (s.kind === 'door' || s.kind === 'window') {
    const arr = (s.kind === 'door' ? fl.doors : fl.windows) || [];
    return arr.filter((d) => d.id === s.id);
  }
  return (fl.devices || []).slice();
}
/* 基准：编辑页顺序 + badge，再按「有开就降序、同数保编辑页顺序」重排
   （2026-11-19 新增的房间条动态排序口径，与被测实现分开写） */
function oldRoomTabs(fl, isOn) {
  const list = (fl && fl.rooms) || [];
  const devs = (fl && fl.devices) || [];
  const tabs = list.map((r, i) => ({
    id: r.id, name: r.name, i,
    badge: devs.filter((d) => d.roomId === r.id && isOn(d)).length,
  }));
  const any = tabs.some((t) => t.badge > 0);
  const out = any ? tabs.slice().sort((a, b) => b.badge - a.badge || a.i - b.i) : tabs;
  return out.map((t) => ({ id: t.id, name: t.name, badge: t.badge }));
}

/* 完整复刻真实 HA 客户端：friendly 依赖 this.getState，不能解绑成裸函数 */
function mockHa(states) {
  const by = new Map(states.map((s) => [s.entity_id, s]));
  return {
    entities: by,
    all() { return states; },
    getState(eid) { return this.entities.get(eid); },
    friendly(eid) {
      const s = this.getState(eid);
      return (s && s.attributes && s.attributes.friendly_name)
        || (eid || '').split('.').pop().replace(/_/g, ' ');
    },
  };
}

const ICONS = { iconOfState: haIconOf, iconOfName: sceneIcon };

/* ---- 测试数据 ---- */
const isOn = (d) => !!d.on;
const floor = {
  rooms: [{ id: 'r1', name: '客厅' }, { id: 'r2', name: '厨房' }],
  devices: [
    { id: 'd1', roomId: 'r1', on: true },
    { id: 'd2', roomId: 'r1', on: false },
    { id: 'd3', roomId: 'r2', on: true },
  ],
  doors: [{ id: 'o1', on: true }],
  windows: [{ id: 'w1', on: false }],
  display: { displayItems: [{ eid: 'scene.movie', kind: 'scene' }] },
};

const states = [
  { entity_id: 'scene.movie', state: '2026-11-14T20:00:00', attributes: { friendly_name: '观影模式', icon: 'mdi:Movie-Open' } },
  { entity_id: 'script.good_night', state: 'off', attributes: { friendly_name: '晚安脚本' } },
  { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: '厨房灯' } },
  { entity_id: 'switch.fan', state: 'off', attributes: { friendly_name: '风扇开关' } },
  { entity_id: 'input_boolean.guest', state: 'on', attributes: { friendly_name: '访客模式' } },
];
const itemFloor = {
  display: {
    displayItems: [
      { eid: 'scene.movie', kind: 'scene' },
      { eid: 'script.good_night', kind: 'script' },
      { eid: 'light.kitchen', kind: 'entity' },
      { eid: 'switch.fan', kind: 'entity' },
      { eid: 'input_boolean.guest', kind: 'entity' },
      { eid: 'light.missing', kind: 'entity' },                 // HA 里查不到，仍要显示
      { eid: 'light.custom', kind: 'entity', name: '自定义名', icon: 'sofa', action: 'turn_on' },
    ],
  },
};

test('devicesOf：空楼层 / 有设备两种口径', () => {
  assert.equal(devicesOf(null).length, 0);
  assert.equal(devicesOf({ devices: [] }).length, 0);
  assert.equal(devicesOf(floor).length, 3);
});

test('allDevicesOf：全家统计 = 所有楼层设备，切层不影响范围', () => {
  const f1 = { devices: [{ id: 'a', on: true }, { id: 'b', on: false }] };
  const f2 = { devices: [{ id: 'c', on: true }] };
  const f3 = { rooms: [] };                                   // 无 devices 的楼层
  const all = allDevicesOf([f1, f2, f3]);
  assert.deepEqual(all.map((d) => d.id), ['a', 'b', 'c']);
  assert.equal(countOn(all, isOn), 2);                        // 分子：全家在运行的
  assert.notEqual(all, f1.devices, '必须返回新数组');
  /* 空值 / 非数组兜底 */
  assert.deepEqual(allDevicesOf(null), []);
  assert.deepEqual(allDevicesOf([]), []);
  assert.deepEqual(allDevicesOf([null, {}]), []);
  /* 与「当前楼层」口径确实不同：只取一层时不会把另一层的设备算进来 */
  assert.deepEqual(allDevicesOf([f1]).map((d) => d.id), ['a', 'b']);
  assert.equal(countOn(allDevicesOf([f1]), isOn), 1);
});

test('scopeDevicesOf：五种选中态，且全屋恒返回新数组', () => {
  assert.deepEqual(scopeDevicesOf(floor, { kind: 'room', id: 'r1' }).map((d) => d.id), ['d1', 'd2']);
  assert.deepEqual(scopeDevicesOf(floor, { kind: 'device', id: 'd3' }).map((d) => d.id), ['d3']);
  assert.deepEqual(scopeDevicesOf(floor, { kind: 'door', id: 'o1' }).map((d) => d.id), ['o1']);
  assert.deepEqual(scopeDevicesOf(floor, { kind: 'window', id: 'w1' }).map((d) => d.id), ['w1']);
  const all = scopeDevicesOf(floor, { kind: 'all' });
  assert.deepEqual(all.map((d) => d.id), ['d1', 'd2', 'd3']);
  assert.notEqual(all, floor.devices, '必须返回新数组，否则下游 scopeOn 不会重算');
  assert.deepEqual(scopeDevicesOf(null, { kind: 'all' }), []);
  assert.deepEqual(scopeDevicesOf(floor, { kind: 'unknown' }), all);
});

test('countOn / roomTabsOf：插件 isOn 口径与角标', () => {
  assert.equal(countOn(devicesOf(floor), isOn), 2);
  assert.equal(countOn([], isOn), 0);
  assert.deepEqual(roomTabsOf(floor, isOn), [
    { id: 'r1', name: '客厅', badge: 1 },
    { id: 'r2', name: '厨房', badge: 1 },
  ]);
  assert.deepEqual(roomTabsOf(null, isOn), []);
});

test('roomTabsOf：有开按 badge 降序、同数保编辑页顺序；全 0 保默认顺序', () => {
  const mk = (order, onMap) => {
    const fl = { rooms: order.map((id) => ({ id, name: id })), devices: [] };
    fl.devices = Object.keys(onMap).flatMap((room, ri) =>
      onMap[room].map((on, i) => ({ id: room + '-' + i, roomId: room, on })));
    return fl;
  };
  const isOn = (d) => !!d.on;
  const idsOf = (tabs) => tabs.map((t) => t.id);

  /* 编辑页顺序 A/B/C/D；B 开 2 个、D 开 1 个 → B(2) D(1) 在前，A/C(0) 保原相对序 */
  const fl = mk(['A', 'B', 'C', 'D'], { B: [true, true], D: [true] });
  assert.deepEqual(idsOf(roomTabsOf(fl, isOn)), ['B', 'D', 'A', 'C']);
  assert.deepEqual(roomTabsOf(fl, isOn).map((t) => t.badge), [2, 1, 0, 0]);

  /* badge 相同按编辑页顺序：C 先于 A 就排 C 先于 A（稳定排序，不被 sort 打乱） */
  const fl2 = mk(['A', 'B', 'C'], { A: [true], C: [true], B: [true, true] });
  assert.deepEqual(idsOf(roomTabsOf(fl2, isOn)), ['B', 'A', 'C']);

  /* 全部没开 → 完全按编辑页默认顺序 */
  const fl3 = mk(['D', 'B', 'A', 'C'], { A: [false], B: [false] });
  assert.deepEqual(idsOf(roomTabsOf(fl3, isOn)), ['D', 'B', 'A', 'C']);
  assert.deepEqual(roomTabsOf(fl3, isOn).map((t) => t.badge), [0, 0, 0, 0]);

  /* 返回的是干净 tab（不漏 _index 之类的内部字段） */
  assert.deepEqual(Object.keys(roomTabsOf(fl, isOn)[0]).sort(), ['badge', 'id', 'name']);
});

test('displayItemsOf：配置是主表，场景 / 脚本 / 实体混排且顺序不变', () => {
  const got = displayItemsOf(itemFloor, mockHa(states), ICONS);
  assert.deepEqual(got.map((x) => x.eid), itemFloor.display.displayItems.map((x) => x.eid));
  assert.equal(got.length, 7);
  assert.deepEqual(got.map((x) => x.name), ['观影模式', '晚安脚本', '厨房灯', '风扇开关', '访客模式', 'missing', '自定义名']);
  /* 场景：HA icon 优先，走回执型 turn_on */
  assert.equal(got[0].mdi, 'movie-open');
  assert.equal(got[0].icon, '🎬');
  assert.equal(got[0].service, 'turn_on');
  assert.equal(got[0].toggle, false);
  /* 脚本：列出来、turn_on、无 mdi 时用 📜 */
  assert.equal(got[1].kind, 'script');
  assert.equal(got[1].mdi, '');
  assert.equal(got[1].icon, '📜');
  assert.equal(got[1].service, 'turn_on');
  /* 三个开关域：domain 兜底 mdi + toggle + 状态灯 */
  assert.equal(got[2].mdi, 'lightbulb');
  assert.equal(got[2].on, true);
  assert.equal(got[2].toggle, true);
  assert.equal(got[2].service, 'toggle');
  assert.equal(got[3].mdi, 'toggle-switch-variant');
  assert.equal(got[3].on, false);
  assert.equal(got[4].on, true);
  /* HA 里查不到的实体照样显示：名字回退、domain 图标、状态未知 */
  assert.equal(got[5].name, 'missing');
  assert.equal(got[5].mdi, 'lightbulb');
  assert.equal(got[5].on, false);
  assert.equal(got[5].state, '');
  /* 项目自定义 name / icon / action 生效；action 覆盖后不再算 toggle */
  assert.equal(got[6].name, '自定义名');
  assert.equal(got[6].mdi, 'sofa');
  assert.equal(got[6].service, 'turn_on');
  assert.equal(got[6].toggle, false);
});

test('displayItemsOf：HA.friendly / getState 必须保留 this（真实 HA 形态回归）', () => {
  const A = mockHa(states);
  const got = displayItemsOf(itemFloor, A, ICONS);
  assert.equal(got[0].name, '观影模式');
  /* 只给 all()、不给 getState/friendly 的极简 HA，也不能抛错 */
  const minimal = { all() { return states; } };
  assert.equal(displayItemsOf(itemFloor, minimal, ICONS)[0].name, 'scene.movie');
  /* 完全没有 HA 客户端时，配置主表依然出项 */
  assert.equal(displayItemsOf(itemFloor, null, ICONS).length, 7);
  assert.equal(displayItemsOf(null, A, ICONS).length, 0);
  assert.deepEqual(displayItemsOf({ display: {} }, A, ICONS), []);
});

test('displayItemsOf：图标优先级 HA icon > 项目 icon > domain mdi；上限 60', () => {
  const fl = { display: { displayItems: [
    { eid: 'light.a', kind: 'entity', icon: 'custom-a' },
  ] } };
  const A = mockHa([{ entity_id: 'light.a', state: 'on', attributes: { icon: 'mdi:lamp', friendly_name: 'A 灯' } }]);
  assert.equal(displayItemsOf(fl, A, ICONS)[0].mdi, 'lamp');
  const many = { display: { displayItems: Array.from({ length: 75 }, (_, i) => ({ eid: `scene.s${i}`, kind: 'scene' })) } };
  assert.equal(displayItemsOf(many, mockHa([]), ICONS).length, MAX_DISPLAY_ITEMS);
  /* 非法项（无 eid / 无 domain）静默丢弃 */
  const dirty = { display: { displayItems: [{ eid: 'broken', kind: 'entity' }, null, { eid: 'light.ok', kind: 'entity' }] } };
  assert.deepEqual(displayItemsOf(dirty, mockHa([]), ICONS).map((x) => x.eid), ['light.ok']);
});

test('displayActionOf / domainMdiOf：按域分派与图标兜底', () => {
  assert.equal(MAX_DISPLAY_ITEMS, 60);
  assert.deepEqual(TOGGLE_DOMAINS, ['light', 'switch', 'input_boolean']);
  assert.equal(isToggleDomain('light'), true);
  assert.equal(isToggleDomain('scene'), false);
  assert.deepEqual(displayActionOf({ eid: 'scene.movie' }), { domain: 'scene', service: 'turn_on', toggle: false });
  assert.deepEqual(displayActionOf({ eid: 'script.x' }), { domain: 'script', service: 'turn_on', toggle: false });
  assert.deepEqual(displayActionOf({ eid: 'automation.x' }), { domain: 'automation', service: 'trigger', toggle: false });
  assert.deepEqual(displayActionOf({ eid: 'button.x' }), { domain: 'button', service: 'press', toggle: false });
  assert.deepEqual(displayActionOf({ eid: 'light.x' }), { domain: 'light', service: 'toggle', toggle: true });
  assert.deepEqual(displayActionOf({ eid: 'switch.x' }), { domain: 'switch', service: 'toggle', toggle: true });
  assert.deepEqual(displayActionOf({ eid: 'input_boolean.x' }), { domain: 'input_boolean', service: 'toggle', toggle: true });
  assert.equal(displayActionOf({ eid: 'light.x', type: 'light', action: 'turn_on' }).toggle, false);
  assert.equal(domainMdiOf('input_boolean'), 'toggle-switch-variant');
  assert.equal(domainMdiOf('scene'), '');
});

test('statusTextOf / netClassOf：五种连接状态逐字一致', () => {
  assert.equal(statusTextOf({ status: 'connected' }), 'Home Assistant 已连接 · 实时同步中');
  assert.equal(statusTextOf({ status: 'demo' }), '演示模式（未配置 Home Assistant）');
  assert.equal(statusTextOf({ status: 'connecting', message: '握手中' }), '握手中');
  assert.equal(statusTextOf({ status: 'connecting' }), '连接中…');
  assert.equal(statusTextOf({ status: 'error', message: '超时' }), '超时');
  assert.equal(statusTextOf({ status: 'error' }), '连接失败');
  assert.equal(statusTextOf({ status: 'off' }), '未连接');
  assert.equal(statusTextOf(null), '未连接');
  assert.deepEqual(netClassOf({ status: 'connected' }), { on: true, demo: false, off: false });
  assert.deepEqual(netClassOf({ status: 'demo' }), { on: false, demo: true, off: false });
  assert.deepEqual(netClassOf({ status: 'error' }), { on: false, demo: false, off: true });
});

test('cardKeyOf / isAllOf / activeIdOf：选中态标识', () => {
  assert.equal(cardKeyOf({ kind: 'all' }), 'card:all:');
  assert.equal(cardKeyOf({ kind: 'room', id: 'r1' }), 'card:room:r1');
  assert.equal(cardKeyOf(null), 'card:all');
  assert.equal(isAllOf({ kind: 'all' }), true);
  assert.equal(isAllOf({ kind: 'room', id: 'r1' }), false);
  assert.equal(isAllOf(null), false);
  assert.equal(activeIdOf({ kind: 'room', id: 'r1' }), 'r1');
  assert.equal(activeIdOf({ kind: 'device', id: 'd1' }), null);
  assert.equal(activeIdOf(null), null);
});

/* 随机逐点比对：200 组楼层 / 选中态，确保抽取没有改变任何边界口径 */
test('随机 200 组：与重构前算式逐点一致', () => {
  let seed = 20261115;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let n = 0; n < 200; n++) {
    const devs = Array.from({ length: Math.floor(rnd() * 9) }, (_, i) => ({
      id: 'd' + i, roomId: 'r' + Math.floor(rnd() * 3), on: rnd() > 0.5,
    }));
    const fl = {
      rooms: [{ id: 'r0', name: 'A' }, { id: 'r1', name: 'B' }, { id: 'r2', name: 'C' }],
      devices: devs,
      doors: [{ id: 'o0', on: true }],
      windows: [{ id: 'w0', on: false }],
      display: { displayItems: [{ eid: 'scene.a', kind: 'scene' }] },
    };
    const kinds = ['all', 'room', 'device', 'door', 'window', 'wall', null];
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    const sel = kind === null ? null : { kind, id: ['r0', 'r1', 'r2', 'd0', 'd1', 'o0', 'w0'][Math.floor(rnd() * 7)] };
    assert.deepEqual(scopeDevicesOf(fl, sel), oldScopeDevices(fl, sel), `scope n=${n} ${kind}`);
    assert.deepEqual(roomTabsOf(fl, isOn), oldRoomTabs(fl, isOn), `tabs n=${n}`);
    assert.equal(countOn(scopeDevicesOf(fl, sel), isOn), oldScopeDevices(fl, sel).filter(isOn).length);
  }
});
