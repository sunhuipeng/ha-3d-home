/**
 * 舞台布局常量 —— PanelApp 取景 / 手势逻辑在 JS 侧的唯一出处。
 *
 * ⚠ CSS 无法引用 JS 常量，下面几处必须与本文件手工保持同步（阶段 1 拆分后
 *   断点分布在各 panel 组件的 <style scoped> 里，改判据时逐个核对）：
 *   - `@media (min-width: 1024px)`                         ↔ 原 WIDE_BREAKPOINT（保留兼容）
 *   - 等价组合 media query（见 WIDE_MEDIA_QUERY 注释）      ↔ isWideViewport 三段式
 *                                                             （panel/*.vue 共 5 处 + PanelApp.vue 骨架）
 *   - `grid-template-columns: ... 340px`                   ↔ RIGHT_PANEL_W（PanelApp.vue 宽屏骨架）
 *   - `.p-shell { --p-band: .38 }`                         ↔ STAGE_BAND_INIT（PanelApp.vue 骨架）
 * 抽常量只为「同一含义只有一个定义」，**不改变任何既有取值**：
 * 取景参数经过多轮实测定稿，改数值属于产品决策，不在这里做。
 */

/* 版面 */
export const WIDE_BREAKPOINT = 1024;   // 窄屏 / 宽屏分界（保留：≥1024 无条件宽屏，原行为不变）
export const WIDE_MIN_W = 768;         // 横屏兜底：CSS 宽度下限（右栏 340 + 间隙 14 + 左列最小 320 = 674，留余量）
export const WIDE_MIN_H = 450;         // 横屏兜底：CSS 高度下限（排除横屏手机：短边多在 390~430，投影缩放后 540/720 不受影响）
export const WIDE_MIN_ASPECT = 1.3;    // 横屏兜底：宽高比下限（4:3=1.33 算横屏，竖屏 0.75 / 0.46 不算）

/* 宽屏判据（版面模式的唯一真相，JS 侧所有消费点都调它）：
 *   ① W >= 1024                → 宽屏（原逻辑，零回归）
 *   ② 横屏兜底：W >= 768 且 H >= 450 且 W/H >= 1.3 → 宽屏
 *      解决「物理横屏大屏、但 CSS 像素被缩放压到 1024 以下」被误判成窄屏的问题
 *      （典型：1080p 投影 / 电视盒子缩放 150%~200% 后 CSS 宽 960、高 540）。
 *   其余 → 窄屏（手机竖屏、平板竖屏、小窗口）。
 * H >= 450 这道闸专门排除「横屏手机」——它的宽高比也很高（~2.1），但短边多在 390~430；
 * 投影仪缩放后高度 540/720 远高于此，不受影响。 */
export function isWideViewport(W, H) {
  const w = Number(W) || 0, h = Number(H) || 0;
  return w >= WIDE_BREAKPOINT ||
    (w >= WIDE_MIN_W && h >= WIDE_MIN_H && h > 0 && w / h >= WIDE_MIN_ASPECT);
}

/* 与 isWideViewport 等价的 CSS media query 文本（供 bridge.js 的 matchMedia 与手工同步参考）：
 *   逗号 = OR；`and` 连接 = AND。CSS 侧写成：
 *   @media (min-width: 1024px), (min-width: 768px) and (min-height: 450px) and (min-aspect-ratio: 13/10) { ... }
 * 注意 13/10 = 1.3，与 WIDE_MIN_ASPECT 必须一致。 */
export const WIDE_MEDIA_QUERY =
  '(min-width: 1024px), (min-width: 768px) and (min-height: 450px) and (min-aspect-ratio: 13/10)';

/* 与 WIDE_MEDIA_QUERY 严格互斥的「窄屏」条件（CSS 侧 4 处 max-width media query 用它）。
 * 必须是逻辑非而非简单的 max-width:1023px —— 否则 768~1023 的横屏窗口两套 media
 * query 同时命中，窄屏 ::after 的 left:0/right:0 漏进宽屏，把右侧羽化面板拉成
 * 左侧一整块黑纱（2026-11-22 投影仪模拟实测踩坑）。逗号 = OR：
 *   W<768；或 W<1024 且 H<450；或 W<1024 且宽高比<1.3（13/10 的取反 = 1299/1000）。 */
export const RIGHT_PANEL_W = 340;      // 宽屏右侧竖栏宽
export const RIGHT_PANEL_GAP = 14;     // 左列与右栏之间的间隙（旧代码写死 354 = 340 + 14）
export const CONTENT_MIN_W = 320;      // 左列最小可视宽度

/* 窄屏 3D 可视带 */
export const STAGE_BAND_INIT = 0.38;   // 初始占屏高（与 CSS --p-band 初值一致）
export const STAGE_MIN_RATIO = 0.2;    // 最矮占屏高
export const STAGE_MIN_PX = 110;       // 最矮下限
export const STAGE_MAX_PX = 160;       // 最矮上限

/* 取景填充率：完整可见是硬约束，越压越贴边 */
export const FILL_STAGE_WIDE = 0.94;
export const FILL_STAGE_INIT = 0.88;
export const FILL_STAGE_GAIN = 0.08;   // 最矮 = 0.96
export const FILL_ROOM_WIDE = 0.78;
export const FILL_ROOM_GAIN = 0.14;    // 最矮 = 0.92

/* 相机平滑逼近系数（每帧向目标靠拢的比例） */
export const SMOOTH_K = 0.22;

/* 窄屏惯性（fling）参数：窄屏 touch-action:none + JS 手动分发滚动，浏览器不会给
   momentum，松手就立刻停，手感明显「顿」。这里按抬手速度做一段指数衰减滚动补回来。
   数值按 Android 原生 fling 的观感调：一甩约 0.6~1s、滑几百 px 后自然停下。
   纯计算在 model/panelGesture.js，数值仍集中在本文件。 */
export const FLING_WINDOW_MS = 90;   // 速度采样窗口（只用最近这段时间的位移算速度）
export const FLING_IDLE_MS = 90;     // 抬手前已停顿超过这个时长 → 是「拖到位再松手」，不甩
export const FLING_MIN_V = 0.12;     // px/ms，低于此不启动惯性
export const FLING_MAX_V = 2.4;      // px/ms 限速，防止极端采样甩飞
export const FLING_DECAY = 0.94;     // 每 16.7ms 保留的速度比例
