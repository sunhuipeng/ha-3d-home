/*
 * num-edit.test.mjs — EditApp 职责方法组（composables/ 拆分）回归测试
 *
 * 2026-11-28 结构重构第二轮把 EditApp 的属性编辑 / 房间与设备排序方法组抽到
 * composables/，本文件锁定搬运后的行为不变：
 *   - useNumEditing：labelOffset 共享纯函数（审计 2.13 去重）+ 数值底座
 *     （夹取 / 角度换算 / 取整 / 浮点步进尾巴）+ 标签抬升钳制；
 *   - useRooms / useDeviceOrder：排序的「原地按槽位覆写」约束与守卫分支。
 * 方法组是普通对象，用假 this（selItem + commit/dirty 记录器）直接驱动，
 * mode 固定 '2d' 以避开 View3D 全局依赖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* composables → model/catalog → services/ha.js（模块加载期写 window.HA）：
 * Node 下需要最小 window/document shim 后动态 import（与 catalog.test.mjs 同款） */
globalThis.window = { __HA_DBG: false, addEventListener() {}, removeEventListener() {} };
globalThis.document = {
  createElement: () => ({ style: {}, getContext: () => null, addEventListener() {}, appendChild() {}, setAttribute() {} }),
  addEventListener() {},
  body: { appendChild() {} },
};

const { numEditingMethods, labelOffsetDefaultOf, labelOffsetValOf, POSE_KEYS } = await import('../src/composables/useNumEditing.js');
const { roomMethods } = await import('../src/composables/useRooms.js');
const { deviceOrderMethods } = await import('../src/composables/useDeviceOrder.js');

function makeNumVm(selItem) {
  const commits = [];
  const vm = {
    selItem,
    mode: '2d',
    commit: (o) => commits.push(o),
    dirty: () => {},
    ...numEditingMethods,
  };
  return { vm, commits };
}

test('POSE_KEYS：位姿字段清单不含几何尺寸', () => {
  assert.deepEqual(POSE_KEYS, ['x', 'y', 'z', 'rot', 'pct']);
});

test('labelOffsetDefaultOf：无选中 / 非 device·door·window 一律 0.3（无 PluginEngine 环境）', () => {
  assert.equal(labelOffsetDefaultOf(null, 'device'), 0.3);
  assert.equal(labelOffsetDefaultOf({ style: 'x' }, 'wall'), 0.3);
  assert.equal(labelOffsetDefaultOf({ style: 'x' }, 'room'), 0.3);
  /* node 环境无 window.PluginEngine → 兜底 0.3（device 分支照常走到引擎探测） */
  assert.equal(labelOffsetDefaultOf({ style: 'p:light' }, 'device'), 0.3);
  assert.equal(labelOffsetDefaultOf({ style: 'p:door' }, 'door'), 0.3);
});

test('labelOffsetValOf：实例覆盖优先，未设置回落造型默认值', () => {
  assert.equal(labelOffsetValOf({ labelOffset: 1.2 }, 0.3), 1.2);
  assert.equal(labelOffsetValOf({ labelOffset: null }, 0.3), 0.3);
  assert.equal(labelOffsetValOf(null, 0.3), 0.3);
  assert.equal(labelOffsetValOf(undefined, 0.3), 0.3);
});

test('setFurnNum：比例钳制 20–300 且取整', () => {
  const it = { pct: 100 };
  const { vm, commits } = makeNumVm(it);
  vm.setFurnNum('pct', '350', null);
  assert.equal(it.pct, 300);
  vm.setFurnNum('pct', '5.6', null);
  assert.equal(it.pct, 20);
  assert.equal(commits.length, 2);
  /* pct 不是位姿字段 → 每次都要求整树重建 */
  assert.equal(commits[0].rebuild, true);
});

test('setOpenNum：门窗宽度最小 0.05m；deg 换算弧度', () => {
  const it = { w: 1, rot: 0 };
  const { vm } = makeNumVm(it);
  vm.setOpenNum('w', '-1', null);
  assert.equal(it.w, 0.05);
  vm.setOpenNum('rot', '90', 'deg');
  assert.ok(Math.abs(it.rot - Math.PI / 2) < 1e-12);
});

test('setDevNum：z 夹取 ≥0；NaN 直接忽略不写值', () => {
  const it = { z: 0.5, x: 1 };
  const { vm } = makeNumVm(it);
  vm.setDevNum('z', '-3', false);
  assert.equal(it.z, 0);
  vm.setDevNum('x', 'abc', false);
  assert.equal(it.x, 1);
});

test('applyNum 非 NaN 输入不改值：非法输入不压 commit', () => {
  const it = { x: 1 };
  const { vm, commits } = makeNumVm(it);
  vm.applyNum('x', 'abc', {});
  assert.equal(it.x, 1);
  assert.equal(commits.length, 0);
});

test('wheelStep：浮点步进不留 0.30000000000000004 尾巴', () => {
  const it = { x: 0.2 };
  const { vm } = makeNumVm(it);
  vm.wheelStep('x', { deltaY: -120 }, 0.1, {});
  assert.equal(it.x, 0.3);
});

test('setDevLabelOffset：钳制 [-1, 6] 并保留两位小数；清空输入不写值', () => {
  const it = { labelOffset: 0.3 };
  const { vm } = makeNumVm(it);
  vm.setDevLabelOffset('9');
  assert.equal(it.labelOffset, 6);
  vm.setDevLabelOffset('-5');
  assert.equal(it.labelOffset, -1);
  vm.setDevLabelOffset('1.238');
  assert.equal(it.labelOffset, 1.24);
  vm.setDevLabelOffset('   ');
  assert.equal(it.labelOffset, 1.24);
  vm.setDevLabelOffset('abc');
  assert.equal(it.labelOffset, 1.24);
});

test('commitDevLabelOffset：清空 = 删掉实例覆盖回到造型默认', () => {
  const it = { labelOffset: 1.5 };
  const { vm } = makeNumVm(it);
  vm.commitDevLabelOffset('');
  assert.equal('labelOffset' in it, false);
  vm.commitDevLabelOffset('2');
  assert.equal(it.labelOffset, 2);
});

test('_applyRoomOrder：原地覆写同一数组引用，守卫分支全部拒绝', () => {
  const r1 = { id: 'r1' }, r2 = { id: 'r2' }, r3 = { id: 'r3' };
  const fl = { rooms: [r1, r2, r3] };
  const vm = { ...roomMethods };
  assert.equal(vm._applyRoomOrder(fl, ['r1', 'r2']), false);          // 长度不符
  assert.equal(vm._applyRoomOrder(fl, ['r1', 'r2', 'rX']), false);    // 未知 id
  assert.equal(vm._applyRoomOrder(fl, ['r1', 'r1', 'r3']), false);    // 重复 id
  assert.equal(vm._applyRoomOrder(fl, ['r1', 'r2', 'r3']), false);    // 顺序未变不压撤销
  const sameRef = fl.rooms;
  assert.equal(vm._applyRoomOrder(fl, ['r3', 'r1', 'r2']), true);
  assert.equal(fl.rooms, sameRef);                                    // 引用不变（Editor.floor 持有旧数组）
  assert.deepEqual(fl.rooms, [r3, r1, r2]);
});

test('_applyDeviceOrder：只重排可排序设备槽位，家具与未绑定设备位置不动', () => {
  const furn = { id: 'f1', type: 'furniture' };
  const a = { id: 'a', entityId: 'light.a' };
  const b = { id: 'b', entityId: 'switch.b' };
  const c = { id: 'c' };   // 未绑实体 → 不参与排序
  const fl = { devices: [furn, a, c, b] };
  const vm = { ...deviceOrderMethods };
  assert.equal(vm._applyDeviceOrder(fl, ['a']), false);           // 数量不符（面板与数据不同步）
  assert.equal(vm._applyDeviceOrder(fl, ['b', 'a', 'c']), false); // 数量不符（c 本身不可排序）
  assert.equal(vm._applyDeviceOrder(fl, ['a', 'b']), false);      // 顺序未变
  const sameRef = fl.devices;
  assert.equal(vm._applyDeviceOrder(fl, ['b', 'a']), true);
  assert.equal(fl.devices, sameRef);
  /* 槽位覆写：可排序的两个槽（1、3）互换，0/2 槽的家具与未绑定设备原地不动 */
  assert.deepEqual(fl.devices, [furn, b, c, a]);
});

test('toggleDeviceCardHide / showAllDeviceCards：hideCard 标记往返，无隐藏不压撤销', () => {
  const changes = [];
  const fakeEditor = { changed: (_r, label) => changes.push(label) };
  const d1 = { id: 'd1', hideCard: true };
  const d2 = { id: 'd2' };
  const vm = { cur: { devices: [d1, d2] }, ...deviceOrderMethods };
  const origEditor = globalThis.Editor;
  globalThis.Editor = fakeEditor;
  try {
    vm.toggleDeviceCardHide('d1');   // 已隐藏 → 删标记（显示）
    assert.equal('hideCard' in d1, false);
    vm.toggleDeviceCardHide('d2');   // 未设置 → 写标记（隐藏）
    assert.equal(d2.hideCard, true);
    vm.toggleDeviceCardHide('nope'); // 不存在的设备 → 无动作
    assert.equal(changes.length, 2);
    vm.showAllDeviceCards();         // 只剩 d2 隐藏 → 恢复并压一条
    assert.equal('hideCard' in d2, false);
    vm.showAllDeviceCards();         // 无隐藏 → 不压撤销
    assert.equal(changes.length, 3);
    assert.deepEqual(changes, ['device-hide:d1', 'device-hide:d2', 'device-hide:all']);
  } finally {
    if (origEditor === undefined) delete globalThis.Editor; else globalThis.Editor = origEditor;
  }
});
