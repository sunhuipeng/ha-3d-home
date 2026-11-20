/**
 * 窄屏「点按」判定的纯计算 + 页面手势状态单一来源 —— 零 Vue / DOM / window，可在 Node 里单测。
 *
 * 为什么存在：窄屏 `.p-shell { touch-action:none }` 让浏览器原生滚动失效，滚动由
 * PanelApp 用 JS 改 `--p-band` / `scrollTop` 手动分发（见 model/panelGesture.js）。
 * 浏览器从未进入「滚动态」，于是「在按钮上按下 → 滑走 → 松手」在它眼里仍是一次
 * 完整 tap，会照常合成 click —— 误触发开关、甚至 automation / script。
 * 靠 touchend 的 preventDefault 只能压住一部分，且依赖各 WebView 的兼容性事件实现。
 * 长期解法是不再让浏览器决定「这是不是点击」：面板按钮统一走 v-tap
 * （composables/useTap.js），由 pointer 序列自己判定，滚动与点击共用同一套阈值。
 *
 * 这里只算数 + 存状态：DOM 监听与 handler 调用归指令，页面手势的状态写入归 PanelApp。
 */

/* 起滑阈值，与 CardChoice.vue 的 MOVE 同口径；页面手势也用它，避免「组件说点、
   页面说滚」的错位。8px 比浏览器 tap 容忍度略紧，但比页面原本 4/6px 的
   方向判定阈值宽松 —— 轻点时的手抖不会被判成滚动。 */
export const TAP_MOVE_PX = 8;

/* 位移是否越过「有意滑动」阈值（累计相对起点，不是逐段增量） */
export function tapExceedsMove(x0, y0, x, y, threshold = TAP_MOVE_PX) {
  return Math.hypot(x - x0, y - y0) > threshold;
}

/* 抬手坐标是否仍落在按钮矩形内。触摸有 implicit pointer capture，pointerup 的
   e.target 恒为按下时的元素，不能用 target 判 inside，只能按坐标 + 实时矩形算。 */
export function tapInside(rect, x, y) {
  return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * 一次抬手能否提交动作，条件缺一不可：
 *   inside        抬手仍落在按钮内
 *   !moved        组件自己没测到超阈值位移
 *   !gestureMoved 页面手势没把这次触摸判成滚动（同一份真相，兜住 pointermove 漏收）
 *   !wasFling     按下时惯性还在跑 —— 这一下只用来刹停，不执行动作
 *   !cancelled    没被 pointercancel / 系统打断
 *   !disabled     按钮此刻不是禁用态（HA 回推可能在按下后改状态）
 */
export function tapShouldFire({ moved, gestureMoved, wasFling, cancelled, inside, disabled }) {
  return !!(inside && !moved && !gestureMoved && !wasFling && !cancelled && !disabled);
}

/* ---------------- 页面手势状态：PanelApp 写、v-tap 读 ----------------
 * 刻意不进 Pinia：惯性期间每帧都在变，只需要在抬手时被读一次，不该触发任何重渲染。
 * 一个页面文档只有一个 PanelApp 实例，模块级单例就是唯一真相。
 * 用「状态」而不是「300ms 时间窗」表达意图，惯性刚结束的正常轻点不会被误吞。 */
export const gestureState = {
  moved: false,         // 本次触摸是否已越过起滑阈值
  flingRunning: false,  // 惯性滚动是否进行中
};

export function beginGesture() { gestureState.moved = false; }
export function markGestureMoved() { gestureState.moved = true; }
export function setFlingRunning(on) { gestureState.flingRunning = !!on; }
