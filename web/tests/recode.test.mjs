/*
 * tests/recode.test.mjs — engine/recode.js 快照式撤销/重做核心语义（P1-5）。
 *
 * 覆盖：600ms 同 label 合并窗 / redo 分叉截断 / MAX=100 裁剪 / pushView 同步 floorIdx
 * 与合并 / undo 深拷贝（返回新对象不共享引用）/ restoring 与非法入参防线。
 * 时间依赖 Date.now —— 用猴补桩控制合并窗内/外，测完恢复。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { Recode } = await import('../src/engine/recode.js');

const proj = (tag) => ({ floors: [{ id: 'f1', tag }] });
let now = 1000000;
const realNow = Date.now;
Date.now = () => now;

test.after(() => { Date.now = realNow; });

test('init/push/undo/redo：基本往返，undo 返回深拷贝', () => {
  Recode.init(proj('v0'), 0, { ox: 0, oy: 0, ppm: 100 });
  assert.equal(Recode.canUndo(), false, 'init 后无可撤销');

  now += 1000;
  Recode.push(proj('v1'), 0, 'drag', null);
  now += 1000;
  Recode.push(proj('v2'), 1, 'edit', { ox: 5, oy: 6, ppm: 120 });
  assert.equal(Recode.stack.length, 3);
  assert.ok(Recode.canUndo() && Recode.canRedo() === false);

  const back = Recode.undo();
  assert.equal(back.project.floors[0].tag, 'v1');
  assert.equal(back.floorIdx, 0, 'undo 跳回当时楼层');
  assert.equal(back.undone, 'edit', 'undone = 被撤销那步的 label');
  back.project.floors[0].tag = 'MUTATED';
  const again = Recode.undo();
  assert.equal(again.project.floors[0].tag, 'v0', '快照独立，改返回值不污染栈');
  assert.deepEqual(again.view, { ox: 0, oy: 0, ppm: 100 }, '回到 init 快照并还原当时视图');

  const fwd = Recode.redo();
  assert.equal(fwd.project.floors[0].tag, 'v1');
  assert.equal(fwd.floorIdx, 0);
});

test('合并窗：同 label 600ms 内替换栈顶（拖一步 = 一步撤销）；换 label 不合并', () => {
  Recode.init(proj('v0'), 0, null);
  now += 1000;
  Recode.push(proj('v1'), 0, 'drag', null);
  now += 100;    // 窗内
  const merged = Recode.push(proj('v2'), 0, 'drag', null);
  assert.equal(merged, true);
  assert.equal(Recode.stack.length, 2, '合并后栈不增长');
  assert.equal(Recode.undo().project.floors[0].tag, 'v0', '一步直接回到初始态');

  now += 1000;
  Recode.push(proj('v3'), 0, 'drag', null);
  now += 100;
  Recode.push(proj('v4'), 0, 'wall', null);   // 换 label → 新一步
  assert.equal(Recode.stack.length, 3, '不同 label 不合并');

  /* undo 断开合并链：undo 后紧接同 label push 也算新一步 */
  Recode.undo();
  now += 100;
  Recode.push(proj('v5'), 0, 'drag', null);
  assert.equal(Recode.stack.length, 3, 'undo 后合并链重置');
});

test('合并窗：超过 600ms 不合并', () => {
  Recode.init(proj('v0'), 0, null);
  now += 1000;
  Recode.push(proj('v1'), 0, 'drag', null);
  now += 700;    // 超窗
  Recode.push(proj('v2'), 0, 'drag', null);
  assert.equal(Recode.stack.length, 3);
});

test('从 redo 分叉 push：丢弃 redo 分支', () => {
  Recode.init(proj('v0'), 0, null);
  now += 1000; Recode.push(proj('v1'), 0, 'drag', null);
  now += 1000; Recode.push(proj('v2'), 0, 'edit', null);
  Recode.undo(); Recode.undo();
  assert.equal(Recode.canRedo(), true);
  now += 1000;
  Recode.push(proj('v3'), 0, 'wall', null);
  assert.equal(Recode.canRedo(), false, '旧 redo 分支已截断');
  assert.equal(Recode.stack.length, 2);
});

test('MAX=100：栈深裁剪丢最旧，undo 到头是第 100 步', () => {
  Recode.init(proj('v0'), 0, null);
  for (let i = 1; i <= 105; i++) { now += 1000; Recode.push(proj('v' + i), 0, 'step' + i, null); }
  assert.equal(Recode.stack.length, 100);
  let hops = 0;
  while (Recode.undo()) hops++;
  assert.equal(hops, 99, 'init + 99 步 = 栈深 100');
  assert.equal(Recode.undo(), null, '到头返回 null');
});

test('pushView：合并为一条并同步 floorIdx；视图操作也截断 redo 分支', () => {
  Recode.init(proj('v0'), 0, null);
  now += 1000; Recode.push(proj('v1'), 0, 'drag', null);
  Recode.undo();
  now += 1000;
  Recode.pushView(proj('v0'), 0, { ox: 1, oy: 1, ppm: 50 });   // view 顶：截断 redo
  assert.equal(Recode.canRedo(), false);
  now += 100;
  Recode.pushView(proj('v0'), 2, { ox: 2, oy: 2, ppm: 60 });   // 连续 view 合并 + 楼层跟随
  const top = Recode.stack[Recode.idx];
  assert.equal(top.label, 'view');
  assert.equal(top.floorIdx, 2, '切层后 view 快照的 floorIdx 同步为新层');
  assert.deepEqual(top.view, { ox: 2, oy: 2, ppm: 60 });

  const back = Recode.undo();
  assert.equal(back.undone, 'view', '回退的正是视图那一步');
  assert.equal(back.view, null, '回退到 init 态（无视图记录）');
});

test('setBaseView：补记初始快照视图；非法输入不动栈', () => {
  Recode.init(proj('v0'), 0, null);
  Recode.setBaseView({ ox: 9, oy: 8, ppm: 70 });
  assert.deepEqual(Recode.stack[0].view, { ox: 9, oy: 8, ppm: 70 });
  Recode.setBaseView(null);
  assert.equal(Recode.stack.length, 1);
});

test('防线：restoring / 空 floors / 无 view 时 pushView 拒绝', () => {
  Recode.init(proj('v0'), 0, null);
  Recode.restoring = true;
  assert.equal(Recode.push(proj('x'), 0, 'drag', null), false);
  assert.equal(Recode.pushView(proj('x'), 0, { ox: 0, oy: 0, ppm: 1 }), false);
  Recode.restoring = false;
  assert.equal(Recode.push({ floors: [] }, 0, 'drag', null), false, '无楼层不进栈');
  assert.equal(Recode.push(null, 0, 'drag', null), false);
  assert.equal(Recode.stack.length, 1, '栈未被污染');
});
