/*
 * tests/catalog.test.mjs — model/catalog.js 纯函数面（P1-1/2/3）。
 *
 * catalog.js 拖入 plugins/three，Node 下需要最小 window/document shim 后动态 import
 * （node --test 每文件独立进程，shim 不影响其它文件）。
 *
 * 覆盖三块：
 *   P1-1 serializeProject：白名单清洗 / 旧字段剥离 / displayItems 校验 / pts 取整
 *        / houseW 现算 / bgImage.src 去 ?t=
 *   P1-2 房间几何：roomArea 符号 / 共线退化 / pointInRoomStrict 三态 / 贴边容差
 *   P1-3 cloneFloor：id 全换新且 roomId / displayItems eid 跟随映射、实体绑定保留
 */
globalThis.window = { __HA_DBG: false, addEventListener() {}, removeEventListener() {} };
globalThis.document = {
  createElement: () => ({ style: {}, getContext: () => null, addEventListener() {}, appendChild() {}, setAttribute() {} }),
  addEventListener() {},
  body: { appendChild() {} },
};

const catalog = await import('../src/model/catalog.js');
import test from 'node:test';
import assert from 'node:assert/strict';
const { roomArea, roomCentroid, pointInRoomStrict, cloneFloor, serializeProject } = catalog;

/* ---------------- P1-2 房间几何 ---------------- */

const SQUARE = [[0, 0], [4, 0], [4, 3], [0, 3]];   // 4×3 矩形，逆时针

test('roomArea：面积按序号定符号（ CCW 正 / CW 负）；<3 点与共线退化为 0', () => {
  assert.equal(roomArea(SQUARE), 12);
  assert.equal(roomArea([...SQUARE].reverse()), -12, '方向相反面积取负（房间顶点存取顺序不保证）');
  assert.equal(roomArea([[0, 0], [1, 1]]), 0);
  assert.equal(roomArea([]), 0);
  assert.equal(roomArea([[0, 0], [1, 1], [2, 2], [3, 3]]), 0, '共线退化为 0');
});

test('roomCentroid：正常多边形重心；共线退化为顶点平均', () => {
  const [cx, cy] = roomCentroid(SQUARE);
  assert.ok(Math.abs(cx - 2) < 1e-9 && Math.abs(cy - 1.5) < 1e-9);
  const [dx, dy] = roomCentroid([[0, 0], [2, 2], [4, 4]]);
  assert.equal(dx, 2);
  assert.equal(dy, 2);
  assert.deepEqual(roomCentroid([]), [0, 0]);
});

test('pointInRoomStrict：in / edge / out 三态；edge 容差可覆盖（默认 0.15）', () => {
  assert.equal(pointInRoomStrict(SQUARE, 2, 1.5), 'in');
  assert.equal(pointInRoomStrict(SQUARE, 0.05, 1.5), 'edge', '距左墙 5cm < 默认 0.15 → 贴边');
  assert.equal(pointInRoomStrict(SQUARE, -0.05, 1.5), 'edge', '压墙线外侧也在容差内');
  assert.equal(pointInRoomStrict(SQUARE, 5, 5), 'out');
  assert.equal(pointInRoomStrict(SQUARE, 4.2, 1.5, 0.3), 'edge', '自定义容差 0.3 覆盖默认');
  assert.equal(pointInRoomStrict(SQUARE, 4.2, 1.5, 0.05), 'out', '小容差下同点算 outside');
  assert.equal(pointInRoomStrict([[0, 0], [1, 1]], 0, 0), 'out', '残片一律 out');
});

/* ---------------- P1-3 cloneFloor ---------------- */

function sampleFloor() {
  return {
    id: 'src-floor', name: '一层', height: 3.1, wallOpacity: 60,
    walls: [{ x1: 0, y1: 0, x2: 5, y2: 0 }],
    rooms: [{ id: 'r1', name: '客厅', pts: [[0, 0], [4, 0], [4, 3], [0, 3]] }],
    doors: [{ id: 'd1', x: 1, y: 0, w: 0.9, roomId: 'r1' }],
    windows: [],
    furniture: [{ id: 'f1', mid: 'sofa1', x: 2, y: 1, roomId: 'r1' }],
    devices: [{ id: 'dev1', entityId: 'light.ceiling', type: 'light', x: 2, y: 2, roomId: 'r1' }],
    display: { dataCards: ['temp'], displayItems: [{ eid: 'dev1', kind: 'entity', name: '主灯' }, { eid: 'light.ceiling', kind: 'entity', name: '实体项' }] },
  };
}

test('cloneFloor：全部实例 id 换新；roomId / displayItems.eid 跟随映射；实体绑定原样保留', () => {
  const src = sampleFloor();
  const dst = cloneFloor(src, '二层');
  assert.equal(dst.id !== src.id, true);
  assert.equal(dst.name, '二层');
  assert.equal(dst.height, 3.1, 'height 跟随');
  assert.equal(dst.wallOpacity, 60);

  const nr = dst.rooms[0];
  assert.notEqual(nr.id, 'r1', '房间换新 id');
  assert.deepEqual(nr.pts, src.rooms[0].pts, '房间几何深拷贝');

  assert.notEqual(dst.doors[0].id, 'd1');
  assert.equal(dst.doors[0].roomId, nr.id, '门窗 roomId 换成新房间 id');
  assert.notEqual(dst.furniture[0].id, 'f1');
  assert.equal(dst.furniture[0].roomId, nr.id);
  assert.notEqual(dst.devices[0].id, 'dev1');
  assert.equal(dst.devices[0].roomId, nr.id);
  assert.equal(dst.devices[0].entityId, 'light.ceiling', 'HA 实体绑定原样保留');

  const items = dst.display.displayItems;
  assert.equal(items[0].eid, dst.devices[0].id, '指向本层元素的 eid 换映射');
  assert.equal(items[1].eid, 'light.ceiling', '指向 HA 实体的 eid 不动');
  assert.deepEqual(dst.walls, src.walls, '墙深拷贝');

  /* 原层不被改动（深拷贝语义） */
  assert.equal(src.rooms[0].id, 'r1');
  assert.equal(src.devices[0].roomId, 'r1');
});

test('cloneFloor：两层全部 id 无重复（id 撞车会跨层串撤销/拾取/分组）', () => {
  const src = sampleFloor();
  const a = cloneFloor(src, 'A');
  const b = cloneFloor(src, 'B');
  const collect = (fl) => [
    fl.id, ...fl.rooms.map((r) => r.id), ...fl.doors.map((d) => d.id),
    ...fl.furniture.map((f) => f.id), ...fl.devices.map((d) => d.id),
  ];
  const ids = [...collect(a), ...collect(b)];
  assert.equal(new Set(ids).size, ids.length, '两层 10 个 id 全局唯一');
});

/* ---------------- P1-1 serializeProject ---------------- */

function projectFixture() {
  const fl = sampleFloor();
  fl.walls.push({ x1: 5, y1: 0, x2: 5, y2: 4, t: 0.3 });       // 5×4 包围盒（maxFloorSize 用）
  fl.rooms.push({ name: '残片', pts: [[0, 0], [1, 1]] });      // <3 点：丢弃
  fl.rooms.push({ name: '取整', pts: [[1.23456, 2.34567], [3, 0], [0, 3]] });
  fl.furniture.push({ id: 'f2', mid: 'chair1', x: 1, y: 1, name: '旧版抄名', w: 0.5, d: 0.6, h: 0.7, color: '#fff' });
  fl.devices.push({ id: 'dev2', entityId: 'switch.plug', type: 'switch', x: 1, y: 1, foo: '绑定键', hideCard: true, hideCard2: false });
  fl.display.displayItems.push({ eid: 'nodot', kind: 'entity', name: '非法 eid' });
  fl.display.displayItems.push({ eid: 'abcDEF_1', kind: 'automation', name: '居控项' });
  fl.display.displayItems.push({ eid: 'scene.x', kind: 'weird-kind', name: '未知 kind' });
  return {
    name: '测试家',
    floors: [fl],
    settings: { background: 'sky', weatherEntity: 'weather.home', junk: '旧键' },
    bgImage: { src: '/custom/bg.png?t=1730000000', name: '背景', x: 1, y: 2, w: 12, opacity: 0.5, hidden: false },
  };
}

test('serializeProject：houseW/houseD 从墙包围盒现算（0.1m 取整）', () => {
  const out = serializeProject(projectFixture());
  assert.equal(out.houseW, 5);
  assert.equal(out.houseD, 4);
  assert.equal(out.rotUnit, 'deg');
});

test('serializeProject：家具旧版抄写字段剥离；未知键保留（防丢插件绑定）', () => {
  /* plugins.js import 时把 PluginEngine 挂上 window（defs=[]，无插件注册），
   * 白名单分支下未知键丢弃；显式清掉走「插件未加载」兜底分支验证防丢绑定语义 */
  const savedPE = window.PluginEngine;
  window.PluginEngine = undefined;
  try {
    const out = serializeProject(projectFixture());
    const f2 = out.floors[0].furniture.find((f) => f.mid === 'chair1');
    assert.equal(f2.name, undefined, 'name 是目录派生字段，不入档');
    assert.equal(f2.w, undefined);
    assert.equal(f2.d, undefined);
    assert.equal(f2.h, undefined);
    assert.equal(f2.color, undefined);
    const dev2 = out.floors[0].devices.find((d) => d.entityId === 'switch.plug');
    assert.equal(dev2.foo, '绑定键', '插件未加载时未知键原样保留（宁带旧键不丢绑定）');
    assert.equal(dev2.hideCard, true, 'hideCard 只在 true 时写');
  } finally {
    window.PluginEngine = savedPE;
  }
});

test('serializeProject：displayItems 白名单校验（非法 eid 丢 / 短码放行 / kind 归一）', () => {
  const out = serializeProject(projectFixture());
  const items = out.floors[0].display.displayItems;
  assert.equal(items.some((it) => it.eid === 'nodot'), false, '无 domain. 前缀的非 automation 项丢弃');
  const auto = items.find((it) => it.eid === 'abcDEF_1');
  assert.ok(auto, 'automation 短码放行');
  assert.equal(auto.kind, 'automation');
  const weird = items.find((it) => it.eid === 'scene.x');
  assert.equal(weird.kind, 'entity', '未知 kind 归一为 entity');
  assert.deepEqual(out.floors[0].display.dataCards, ['temp']);
});

test('serializeProject：房间 pts 取整两位、<3 点残片丢弃；settings 只出白名单键', () => {
  const out = serializeProject(projectFixture());
  assert.equal(out.floors[0].rooms.length, 2, '残片房间被丢弃');
  const rounded = out.floors[0].rooms.find((r) => r.name === '取整');
  assert.deepEqual(rounded.pts[0], [1.23, 2.35]);
  assert.deepEqual(out.settings, {
    background: 'sky',
    backgroundOptions: {},
    backgroundFields: {},
    weatherEntity: 'weather.home',
  }, 'settings 旧键 junk 不写回');
});

test('serializeProject：bgImage.src 去掉 ?t= 防缓存时间戳', () => {
  const out = serializeProject(projectFixture());
  assert.equal(out.bgImage.src, '/custom/bg.png');
  assert.equal(out.bgImage.opacity, 0.5);
});

test('serializeProject：空项目 / 无楼层 → null；缺省字段兜底', () => {
  assert.equal(serializeProject(null), null);
  assert.equal(serializeProject({ floors: [] }), null);
  const out = serializeProject({ name: 123, floors: [{ walls: 'x' }] });
  assert.equal(out.name, '我的家', '非字符串名回默认');
  assert.equal(out.floors[0].height, 2.8, '默认层高');
  assert.equal(out.floors[0].wallOpacity, 45, '默认墙不透明度');
  assert.deepEqual(out.floors[0].walls, [], '非数组 walls 兜底空数组');
  assert.equal('houseW' in out, false, '无墙时不算 houseW');
});
