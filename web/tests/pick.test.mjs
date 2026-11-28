/*
 * tests/pick.test.mjs — 3D 拾取筛选的纯逻辑单测
 *
 * deviceFromHits 是 View3D.pick 的内核：从射线命中列表里找"可点的设备组"。
 * 关键回归点：纯光效（光晕 Sprite / 光锥 / 贴面光 / 灯泡，带 userData.noPick）
 * 面积远大于灯体、且 Three r160 raycast 不看 visible，必须跳过，
 * 否则点灯周围的光会误开关。这里用最简 Object3D 桩复现父链结构。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceFromHits } from '../src/model/pick.js';

/* 造一条从命中 mesh 到根的父链：specs 按 [叶子, …, 根] 给 userData */
function chain(...specs) {
  let parent = null;
  let leaf = null;
  let root = null;
  for (let i = specs.length - 1; i >= 0; i--) {
    const node = { userData: specs[i], parent };
    parent = node;
    if (!root) root = node;    // 第一个造出的是 specs[last]（parent=null），即根
    leaf = node;               // 最后造出的是 specs[0]，即叶子
  }
  return { leaf, root };
}
const hit = (obj) => ({ object: obj });

const DEVICE = { device: { id: 'lamp' }, devType: 'light' };
const NO_PICK = { noPick: true };
const PICK_BLOCK = { pickBlock: true };

test('deviceFromHits：命中灯体 → 沿父链找到设备组', () => {
  const { leaf, root } = chain({}, {}, DEVICE);
  assert.equal(deviceFromHits([hit(leaf)]), root);
});

test('deviceFromHits：只命中光效 → null（点光不算点设备）', () => {
  const { leaf } = chain(NO_PICK, {}, DEVICE);
  assert.equal(deviceFromHits([hit(leaf)]), null);
});

test('deviceFromHits：光效在前、灯体在后 → 跳过光效取同一设备组', () => {
  /* 真实结构：光晕与灯体是同一个设备组的后代，近处光晕被跳过，远处灯体命中同一组 */
  const grp = { userData: { ...DEVICE }, parent: null };
  const halo = { userData: NO_PICK, parent: grp };   // 近处的大光晕
  const body = { userData: {}, parent: grp };        // 远处的真实灯体
  assert.equal(deviceFromHits([hit(halo), hit(body)]), grp);
});

test('deviceFromHits：光锥命中但父链更深才到设备 → 仍跳过', () => {
  /* noPick 打在光效 mesh 上，往上有若干装饰节点再到设备组 */
  const { leaf } = chain(NO_PICK, {}, {}, {}, DEVICE);
  assert.equal(deviceFromHits([hit(leaf)]), null);
});

test('deviceFromHits：空列表 / 无关对象 → null', () => {
  assert.equal(deviceFromHits([]), null);
  assert.equal(deviceFromHits(null), null);
  const { leaf } = chain({}, {});                 // 无 device 标记
  assert.equal(deviceFromHits([hit(leaf)]), null);
});

test('deviceFromHits：锚点热球（无 noPick）仍可命中', () => {
  /* 锚点热球是保底热区，只带 deviceRef、不带 noPick，必须照常可点 */
  const { leaf, root } = chain({ deviceRef: {} }, DEVICE);
  assert.equal(deviceFromHits([hit(leaf)]), root);
});

test('deviceFromHits：蒸汽（pickBlock）在前、锅体在后 → null（点蒸汽不算点设备）', () => {
  /* 蒸汽飘在锅上方，射线穿过命中下方锅体；pickBlock 让整条射线作废 */
  const grp = { userData: { ...DEVICE }, parent: null };
  const steam = { userData: PICK_BLOCK, parent: grp };
  const pot = { userData: {}, parent: grp };             // 锅体本体
  assert.equal(deviceFromHits([hit(steam), hit(pot)]), null);
});

test('deviceFromHits：只命中蒸汽 → null', () => {
  const { leaf } = chain(PICK_BLOCK, {}, DEVICE);
  assert.equal(deviceFromHits([hit(leaf)]), null);
});

test('deviceFromHits：同一 mesh 上 pickBlock 优先于 noPick', () => {
  const both = { userData: { ...PICK_BLOCK, ...NO_PICK }, parent: null };
  assert.equal(deviceFromHits([hit(both)]), null);
});
