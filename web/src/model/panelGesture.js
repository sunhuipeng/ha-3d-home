/**
 * 窄屏手势的纯计算 —— 零 Vue / DOM / window，可在 Node 里单测（阶段 0）。
 *
 * 窄屏 `.p-shell { touch-action:none }` 让浏览器原生滚动与 momentum 全部失效，
 * 滚动由 JS 手动分发：纵向「先压 3D 带、压到底再滚卡片」，横向滚场景/房间条，
 * 抬手后按速度补一段指数衰减惯性。这里只算数，副作用（写 CSS 变量 / scrollTop）
 * 仍留在 PanelApp.vue 的 _setStageH / _stageGesture / _startFling 里。
 *
 * 数值常量集中在 model/stageLayout.js；公式从原 methods 逐字搬来，未改口径。
 */
import {
  STAGE_BAND_INIT, STAGE_MIN_RATIO, STAGE_MIN_PX, STAGE_MAX_PX,
  FLING_WINDOW_MS, FLING_IDLE_MS, FLING_MIN_V, FLING_MAX_V, FLING_DECAY,
} from './stageLayout.js';

/* 3D 可视带的上下限：与 _stageEnsure 一致（H = 视口高，px） */
export function stageBounds(H) {
  const max = Math.round(H * STAGE_BAND_INIT);
  const min = Math.max(STAGE_MIN_PX, Math.min(STAGE_MAX_PX, Math.round(H * STAGE_MIN_RATIO)));
  return { max, min };
}

/* _setStageH 的夹取口径（取整后才落值）：抽出来给纵向分发复用，避免两处各算一套 */
export function clampBand(px, min, max) {
  return Math.max(min, Math.min(max, Math.round(px)));
}

/**
 * 纵向增量分发（同一手势内跨阶段连续）：
 *   上滑先压 3D 带，压到最小后把剩余位移喂给卡片滚动；
 *   下滑反向，卡片先回到顶再放开 3D 带。
 * 入参是当前状态，返回目标状态；调用方据此写 CSS 变量与 scrollTop。
 * hasBody=false 表示卡片滚动容器不存在（晚挂载 / 空态），此时位移只作用在 3D 带上。
 */
export function splitVerticalGesture(dy, { stageH, stageMin, stageMax, scrollTop, hasBody }) {
  let band = stageH;
  let scroll = hasBody ? scrollTop : 0;
  if (dy > 0) {
    let rest = dy;
    if (band > stageMin) {
      const before = band;
      band = clampBand(before - rest, stageMin, stageMax);
      rest -= (before - band);
    }
    if (rest > 0 && hasBody) scroll = scroll + rest;
  } else {
    let rest = -dy;
    if (hasBody && scroll > 0) {
      const before = scroll;
      scroll = Math.max(0, before - rest);
      rest -= (before - scroll);
    }
    if (rest > 0 && band < stageMax) band = clampBand(band + rest, stageMin, stageMax);
  }
  return { band, scroll };
}

/* 记录一段位移采样，队列只留最近 FLING_WINDOW_MS（抬手前的减速/停顿能如实反映）。
   返回当前时间戳，供调用方记 lastMoveT。 */
export function sampleMove(samples, move, now) {
  samples.push({ t: now, move });
  while (samples.length > 2 && now - samples[0].t > FLING_WINDOW_MS) samples.shift();
  return now;
}

/**
 * 抬手速度（px/ms，正 = 上滑）。返回 0 表示不该启动惯性：
 * 慢慢拖到位停住再松手、采样不足、时间跨度太短、速度低于阈值，都与原生列表一致。
 */
export function flingVelocity(samples, now, lastMoveT) {
  if (!lastMoveT || now - lastMoveT > FLING_IDLE_MS) return 0;
  if (!samples || samples.length < 2) return 0;
  const span = samples[samples.length - 1].t - samples[0].t;
  if (span < 8) return 0;
  let sum = 0;
  for (let i = 1; i < samples.length; i++) sum += samples[i].move;
  const v = Math.max(-FLING_MAX_V, Math.min(FLING_MAX_V, sum / span));
  return Math.abs(v) < FLING_MIN_V ? 0 : v;
}

/* 每帧速度衰减：dt 归一到 16.7ms 一帧，切后台回来不会一次甩飞 */
export function nextFlingVelocity(v, dt) {
  return v * Math.pow(FLING_DECAY, dt / 16.7);
}

/* 惯性循环的帧时长：首帧按一整帧算（last=0 时 dt≈1ms 会被误判成「到边界」） */
export function flingFrameDt(now, last) {
  return last ? Math.min(34, Math.max(1, now - last)) : 16.7;
}
