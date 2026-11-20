/**
 * PanelApp 阶段 0 抽出的纯计算单测（零浏览器 / 零 Vue，直接 node 跑）。
 *   node --test tests/panel-math.test.mjs
 * 重点验证「公式逐字搬运」：与原 methods 里的算式逐项对齐，防止重构时改了口径。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneIcon, SCENE_ICONS } from '../src/model/sceneIcon.js';
import {
  stageBounds, clampBand, splitVerticalGesture, sampleMove, flingVelocity,
  nextFlingVelocity, flingFrameDt,
} from '../src/model/panelGesture.js';
import {
  squeezeOf, stageMetricsOf, viewOffsetOf, fitScaleOf, fitDistanceOf, screenBoundsOf,
} from '../src/model/panelCamera.js';
import {
  STAGE_BAND_INIT, STAGE_MIN_RATIO, STAGE_MIN_PX, STAGE_MAX_PX,
  WIDE_BREAKPOINT, RIGHT_PANEL_W, RIGHT_PANEL_GAP, CONTENT_MIN_W,
  FLING_WINDOW_MS, FLING_IDLE_MS, FLING_MIN_V, FLING_MAX_V, FLING_DECAY,
} from '../src/model/stageLayout.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('sceneIcon：关键词按顺序命中，未知名兜底 🎬', () => {
  assert.equal(sceneIcon('明亮模式'), '☀️');
  assert.equal(sceneIcon('观影模式'), '🎬');
  assert.equal(sceneIcon('晚安'), '🌙');
  assert.equal(sceneIcon('离家布防'), '🚪');
  assert.equal(sceneIcon('回家开灯'), '🏡');
  assert.equal(sceneIcon('PARTY 时间'), '🎉');
  assert.equal(sceneIcon('读书记得开灯'), '📖');   // 「阅读」优先于其它
  assert.equal(sceneIcon('随便一个名字'), '🎬');
  assert.equal(sceneIcon(null), '🎬');
  assert.equal(sceneIcon(undefined), '🎬');
  assert.equal(SCENE_ICONS.length, 12);
});

test('stageBounds：与原 _stageEnsure 的 min/max 公式一致', () => {
  for (const H of [400, 640, 800, 1000, 1440]) {
    const { max, min } = stageBounds(H);
    assert.equal(max, Math.round(H * STAGE_BAND_INIT));
    assert.equal(min, Math.max(STAGE_MIN_PX, Math.min(STAGE_MAX_PX, Math.round(H * STAGE_MIN_RATIO))));
    assert.ok(min <= max, `H=${H}: min(${min}) > max(${max})`);
  }
  assert.equal(stageBounds(400).min, STAGE_MIN_PX, '矮屏用 px 下限兜底');
  assert.equal(stageBounds(1000).min, STAGE_MAX_PX, '高屏用 px 上限兜底');
});

test('clampBand：取整后夹取，与 _setStageH 同口径', () => {
  assert.equal(clampBand(200.6, 110, 304), 201);
  assert.equal(clampBand(-20, 110, 304), 110);
  assert.equal(clampBand(9999, 110, 304), 304);
});

test('splitVerticalGesture：上滑先压带、压到底再滚卡片', () => {
  const st = { stageH: 300, stageMin: 110, stageMax: 300, scrollTop: 0, hasBody: true };
  const a = splitVerticalGesture(50, st);
  assert.deepEqual(a, { band: 250, scroll: 0 });
  const b = splitVerticalGesture(250, { ...st, stageH: 150 });
  assert.deepEqual(b, { band: 110, scroll: 210 }, '带压到 110 后剩余 210 给卡片');
  const c = splitVerticalGesture(20, { ...st, stageH: 110 });
  assert.deepEqual(c, { band: 110, scroll: 20 }, '已压到底，全部给卡片');
});

test('splitVerticalGesture：下滑先让卡片回顶，再放开 3D 带', () => {
  const st = { stageH: 110, stageMin: 110, stageMax: 300, scrollTop: 60, hasBody: true };
  const a = splitVerticalGesture(-20, st);
  assert.deepEqual(a, { band: 110, scroll: 40 });
  const b = splitVerticalGesture(-100, st);
  assert.deepEqual(b, { band: 150, scroll: 0 }, '卡片回顶后剩余 40 放带');
  const c = splitVerticalGesture(-9999, st);
  assert.deepEqual(c, { band: 300, scroll: 0 }, '放带到 max 即停，不回弹');
});

test('splitVerticalGesture：无卡片容器时位移只作用于 3D 带', () => {
  assert.deepEqual(
    splitVerticalGesture(50, { stageH: 300, stageMin: 110, stageMax: 300, scrollTop: 0, hasBody: false }),
    { band: 250, scroll: 0 },
  );
  assert.deepEqual(
    splitVerticalGesture(500, { stageH: 300, stageMin: 110, stageMax: 300, scrollTop: 0, hasBody: false }),
    { band: 110, scroll: 0 },
  );
  assert.deepEqual(
    splitVerticalGesture(-50, { stageH: 110, stageMin: 110, stageMax: 300, scrollTop: 0, hasBody: false }),
    { band: 160, scroll: 0 },
  );
});

test('splitVerticalGesture：与原分发算式在随机序列上逐点一致', () => {
  /* 参考实现 = 重构前 _stageGesture 的逐字逻辑（用局部变量代替 DOM 写入） */
  const reference = (dy, { stageH, stageMin, stageMax, scrollTop, hasBody }) => {
    let h = stageH, s = hasBody ? scrollTop : 0;
    if (dy > 0) {
      let rest = dy;
      if (h > stageMin) {
        const before = h;
        h = Math.max(stageMin, Math.min(stageMax, Math.round(before - rest)));
        rest -= (before - h);
      }
      if (rest > 0 && hasBody) s += rest;
    } else {
      let rest = -dy;
      if (hasBody && s > 0) {
        const before = s;
        s = Math.max(0, before - rest);
        rest -= (before - s);
      }
      if (rest > 0 && h < stageMax) h = Math.max(stageMin, Math.min(stageMax, Math.round(h + rest)));
    }
    return { band: h, scroll: s };
  };
  let seed = 20261115;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 500; i++) {
    const st = {
      stageH: 110 + Math.round(rnd() * 190), stageMin: 110, stageMax: 300,
      scrollTop: Math.round(rnd() * 900), hasBody: rnd() > 0.2,
    };
    const dy = Math.round((rnd() - 0.5) * 400);
    assert.deepEqual(splitVerticalGesture(dy, st), reference(dy, st), `dy=${dy} st=${JSON.stringify(st)}`);
  }
});

test('sampleMove：只留最近窗口内的采样（至少 2 个）', () => {
  const s = [];
  assert.equal(sampleMove(s, 10, 1000), 1000);
  sampleMove(s, 12, 1020);
  assert.equal(s.length, 2);
  sampleMove(s, 14, 1200);   // 距首条 200ms > 90ms
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((x) => x.t), [1020, 1200]);
  assert.equal(s[0].move, 12);
});

test('flingVelocity：停顿/采样不足/短跨度/低速/限速', () => {
  const s = [{ t: 1000, move: 0 }, { t: 1020, move: 10 }, { t: 1040, move: 10 }];
  near(flingVelocity(s, 1040, 1040), 20 / 40);
  assert.equal(flingVelocity(s, 1040 + FLING_IDLE_MS + 1, 1040), 0, '拖到位停住再松手不甩');
  assert.equal(flingVelocity([{ t: 1000, move: 10 }], 1000, 1000), 0);
  assert.equal(flingVelocity([{ t: 1000, move: 0 }, { t: 1004, move: 10 }], 1004, 1004), 0, 'span < 8');
  assert.equal(flingVelocity([{ t: 1000, move: 0 }, { t: 1040, move: 1 }], 1040, 1040), 0, '低于 FLING_MIN_V');
  const fast = [{ t: 1000, move: 0 }, { t: 1010, move: 1000 }];
  assert.equal(flingVelocity(fast, 1010, 1010), FLING_MAX_V, '上限限速');
  assert.equal(flingVelocity([{ t: 1000, move: 0 }, { t: 1010, move: -1000 }], 1010, 1010), -FLING_MAX_V, '反向限速');
  assert.equal(flingVelocity(s, 1040, 0), 0, 'lastMoveT=0');
});

test('nextFlingVelocity / flingFrameDt：衰减与帧时长', () => {
  near(nextFlingVelocity(1, 16.7), FLING_DECAY);
  near(nextFlingVelocity(1, 33.4), FLING_DECAY ** 2);
  assert.equal(flingFrameDt(1000, 0), 16.7, '首帧一整帧');
  assert.equal(flingFrameDt(1016, 1000), 16);
  assert.equal(flingFrameDt(9999, 1000), 34, '切后台回来上限 34ms');
  assert.equal(flingFrameDt(1000.4, 1000), 1, '最小 1ms');
});

test('squeezeOf：宽屏恒 0，窄屏按占比线性夹紧', () => {
  assert.equal(squeezeOf(0.2, 0.2, true), 0);
  assert.equal(squeezeOf(STAGE_BAND_INIT, 0.2, false), 0);
  assert.equal(squeezeOf(0.2, 0.2, false), 1);
  assert.equal(squeezeOf(0.1, 0.2, false), 1, '超过最矮夹紧到 1');
  assert.equal(squeezeOf(0.9, 0.2, false), 0, '超过初始夹紧到 0');
  const mid = squeezeOf(0.29, 0.2, false);
  near(mid, (STAGE_BAND_INIT - 0.29) / (STAGE_BAND_INIT - 0.2));
});

test('stageMetricsOf：窄屏 / 宽屏字段与原算式一致', () => {
  const H = 800, W = 390;
  const n = stageMetricsOf({ W, H, stageFrac: 0.38, stageMin: 160, visibleH: 304, defaultDist: 18 });
  assert.equal(n.wide, false);
  assert.equal(n.contentW, W);
  assert.equal(n.contentH, 304);
  assert.equal(n.cx, W / 2);
  assert.equal(n.cy, 304 / 2);
  near(n.dist, 18 * (H / 304) * 1.12);
  near(n.squeeze, squeezeOf(0.38, 160 / H, false));

  const W2 = WIDE_BREAKPOINT + 400;
  const w = stageMetricsOf({ W: W2, H, stageFrac: null, stageMin: null, visibleH: H, defaultDist: 18 });
  assert.equal(w.wide, true);
  assert.equal(w.contentW, Math.max(CONTENT_MIN_W, W2 - RIGHT_PANEL_W - RIGHT_PANEL_GAP));
  assert.equal(w.contentH, H);
  assert.equal(w.squeeze, 0);
  assert.equal(w.cx, w.contentW / 2);
  assert.equal(w.cy, H / 2);
  near(w.dist, 18 * 1.18);
});

test('viewOffsetOf：像素偏移 = 可视区中心差 + 透视修正', () => {
  const m = { W: 390, H: 800, cx: 195, cy: 152 };
  assert.deepEqual(viewOffsetOf(m, 0), { dx: 0, dy: -248 });
  assert.deepEqual(viewOffsetOf(m, 12), { dx: 0, dy: -236 });
  assert.deepEqual(viewOffsetOf(m, undefined), { dx: 0, dy: -248 });
  const m2 = { W: 1440, H: 900, cx: 540, cy: 450 };
  assert.deepEqual(viewOffsetOf(m2, 3), { dx: -180, dy: 3 });
});

test('fitScaleOf：宽/高谁是限制项取较大者（完整可见约束）', () => {
  const m = { contentW: 400, contentH: 300 };
  near(fitScaleOf({ w: 200, h: 150 }, m, 0.5), 1);
  near(fitScaleOf({ w: 300, h: 100 }, m, 0.75), 1);      // 宽方向更紧
  near(fitScaleOf({ w: 100, h: 300 }, m, 0.75), 4 / 3);  // 高方向更紧
});

test('fitDistanceOf：半角换算 / fill 默认 / depthK 默认与显式', () => {
  const base = { hw: 4, hh: 3, hd: 1, fov: 50, contentW: 390, contentH: 304, canvasH: 800 };
  const manual = (fill, k) => {
    const f = fill || 0.9;
    const tan = Math.tan((50 * Math.PI) / 360);
    const tanV = tan * (304 / 800);
    const tanH = tan * (390 / 800);
    return Math.max(4 / (tanH * f), 3 / (tanV * f)) + 1 * k;
  };
  near(fitDistanceOf({ ...base, fill: 0.95, depthK: 0.6 }), manual(0.95, 0.6));
  near(fitDistanceOf({ ...base, fill: 0.8, depthK: 0.3 }), manual(0.8, 0.3));
  near(fitDistanceOf({ ...base }), manual(undefined, 0.6), 1e-9);
  assert.ok(fitDistanceOf({ ...base, contentH: 200, fill: 0.9 }) > fitDistanceOf({ ...base, fill: 0.9 }),
    '可视区越矮，需要的视距越远');
});

test('screenBoundsOf：NDC 角点 → 屏幕包围盒宽高与中心', () => {
  const pts = [
    { x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 },
    { x: -0.5, y: 0.5 }, { x: 0.5, y: 0.5 },
  ];
  const b = screenBoundsOf(pts, 400, 800);
  assert.equal(b.w, 200);
  assert.equal(b.h, 400);
  assert.equal(b.cx, 200);
  assert.equal(b.cy, 400);
  const shifted = screenBoundsOf([{ x: -0.2, y: -0.2 }, { x: 0.6, y: 0.4 }], 400, 800);
  assert.equal(shifted.cx, 240);   // NDC 中心 0.2 → (0.1+0.5)*400
  assert.equal(shifted.cy, 360);   // NDC 中心 0.1 → (-0.05+0.5)*800
});

test('FLING 常量口径未改（防止顺手调手感）', () => {
  assert.deepEqual(
    [FLING_WINDOW_MS, FLING_IDLE_MS, FLING_MIN_V, FLING_MAX_V, FLING_DECAY],
    [90, 90, 0.12, 2.4, 0.94],
  );
});
