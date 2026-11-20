/**
 * 窄屏点按判定 + 页面手势状态单测（零浏览器 / 零 Vue，node --test 直接跑）。
 * 覆盖的是「滚动后浏览器补发 click」被根治的那套纯逻辑：
 * 组件测位移、页面测累计位移、抬手合流判定，任一环判滚动就不提交。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TAP_MOVE_PX, tapExceedsMove, tapInside, tapShouldFire,
  gestureState, beginGesture, markGestureMoved, setFlingRunning,
} from '../src/model/tapGesture.js';

/* 一次「全通过」的抬手：各用例只翻一个条件，验证缺一不可 */
const OK = {
  moved: false, gestureMoved: false, wasFling: false,
  cancelled: false, inside: true, disabled: false,
};

test('TAP_MOVE_PX 与 CardChoice 的起滑阈值同口径（8px）', () => {
  assert.equal(TAP_MOVE_PX, 8);
});

test('tapExceedsMove：累计位移按起点算，阈值严格大于，支持自定义阈值', () => {
  assert.equal(tapExceedsMove(100, 100, 100, 100), false, '原地不动');
  assert.equal(tapExceedsMove(100, 100, 107, 100), false, '手抖 7px 仍算轻点');
  assert.equal(tapExceedsMove(100, 100, 108, 100), false, '恰好 8px 不算滑动');
  assert.equal(tapExceedsMove(100, 100, 109, 100), true, '9px 判滑动');
  assert.equal(tapExceedsMove(100, 100, 100, 92), false, '恰好 8px 纵向也不算');
  assert.equal(tapExceedsMove(100, 100, 100, 91), true, '纵向 9px 判滑动');
  assert.equal(tapExceedsMove(100, 100, 106, 106), true, '对角线按 hypot，不是逐轴');
  assert.equal(tapExceedsMove(0, 0, 20, 0, 24), false, '自定义阈值');
  assert.equal(tapExceedsMove(0, 0, 25, 0, 24), true);
});

test('tapInside：抬手坐标落在实时矩形内（含边界），矩形缺失一律 false', () => {
  const r = { left: 10, right: 60, top: 20, bottom: 66 };
  assert.equal(tapInside(r, 10, 20), true, '左上角');
  assert.equal(tapInside(r, 60, 66), true, '右下角');
  assert.equal(tapInside(r, 35, 40), true, '内部');
  assert.equal(tapInside(r, 9, 40), false);
  assert.equal(tapInside(r, 61, 40), false);
  assert.equal(tapInside(r, 35, 19), false);
  assert.equal(tapInside(r, 35, 67), false);
  assert.equal(tapInside(null, 35, 40), false);
});

test('tapShouldFire：轻点全条件满足才提交', () => {
  assert.equal(tapShouldFire(OK), true);
});

test('tapShouldFire：任一否决条件成立都不提交', () => {
  assert.equal(tapShouldFire({ ...OK, inside: false }), false, '抬手滑出按钮');
  assert.equal(tapShouldFire({ ...OK, moved: true }), false, '组件自己测到滑动');
  assert.equal(tapShouldFire({ ...OK, gestureMoved: true }), false, '页面判为滚动（兜住漏收 pointermove）');
  assert.equal(tapShouldFire({ ...OK, wasFling: true }), false, '按下时惯性在跑：只刹停，不执行');
  assert.equal(tapShouldFire({ ...OK, cancelled: true }), false, '系统中断手势');
  assert.equal(tapShouldFire({ ...OK, disabled: true }), false, '按下后 HA 回推把按钮置灰');
  assert.equal(tapShouldFire({}), false, '字段全缺时保守不提交');
});

test('gestureState：新触摸清滚动标记、惯性状态独立、互不影响', () => {
  beginGesture();
  setFlingRunning(false);
  assert.equal(gestureState.moved, false);
  assert.equal(gestureState.flingRunning, false);

  markGestureMoved();
  assert.equal(gestureState.moved, true, '页面 touchmove 越过阈值后标记');
  setFlingRunning(true);
  assert.equal(gestureState.flingRunning, true, '抬手起惯性');
  assert.equal(gestureState.moved, true, '惯性不覆盖滚动标记');

  /* 惯性中再按一下：beginGesture 只清 moved，flingRunning 由 _flingStop 清 */
  beginGesture();
  assert.equal(gestureState.moved, false);
  assert.equal(gestureState.flingRunning, true);
  setFlingRunning(false);
  assert.equal(gestureState.flingRunning, false);
});

test('端到端口径：轻点 / 滚动 / 惯性中轻点 三条路径', () => {
  const rect = { left: 0, right: 100, top: 0, bottom: 46 };

  /* ① 轻点：手抖 5px，抬手仍在按钮内 */
  beginGesture(); setFlingRunning(false);
  const small = tapExceedsMove(50, 23, 55, 23);
  assert.equal(tapShouldFire({
    ...OK, moved: small, gestureMoved: gestureState.moved,
    wasFling: gestureState.flingRunning, inside: tapInside(rect, 55, 23),
  }), true, '轻点要能触发，不能被 4/6px 的方向判定误杀');

  /* ② 上滑压 3D 带：页面累计位移越阈值，即使组件漏收 pointermove 也不提交 */
  beginGesture(); setFlingRunning(false);
  markGestureMoved();
  assert.equal(tapShouldFire({
    ...OK, moved: false, gestureMoved: gestureState.moved,
    wasFling: gestureState.flingRunning, inside: tapInside(rect, 50, 23),
  }), false, '滚动后抬手（起点落在按钮上）不能触发');

  /* ③ 惯性中轻点：pointerdown 快照到 flingRunning=true，只刹停 */
  beginGesture(); setFlingRunning(true);
  assert.equal(tapShouldFire({
    ...OK, gestureMoved: gestureState.moved, wasFling: true,
    inside: tapInside(rect, 50, 23),
  }), false, '惯性中第一下只刹停');

  /* ④ 惯性停稳后正常轻点：状态而非 300ms 时间窗，立即恢复可点 */
  setFlingRunning(false); beginGesture();
  assert.equal(tapShouldFire({
    ...OK, gestureMoved: gestureState.moved, wasFling: gestureState.flingRunning,
    inside: tapInside(rect, 50, 23),
  }), true, '惯性停了就该立刻能点，不靠时间窗');
});
