/**
 * 舞台布局常量 —— PanelApp 取景 / 手势逻辑在 JS 侧的唯一出处。
 *
 * ⚠ CSS 无法引用 JS 常量，下面三处必须与本文件手工保持同步（阶段 1 拆分后
 *   断点分布在各 panel 组件的 <style scoped> 里，改断点时逐个核对）：
 *   - `@media (min-width: 1024px)`            ↔ WIDE_BREAKPOINT
 *                                                （panel/*.vue 共 5 处 + PanelApp.vue 骨架）
 *   - `grid-template-columns: ... 340px`      ↔ RIGHT_PANEL_W（PanelApp.vue 宽屏骨架）
 *   - `.p-shell { --p-band: .38 }`            ↔ STAGE_BAND_INIT（PanelApp.vue 骨架）
 * 抽常量只为「同一含义只有一个定义」，**不改变任何既有取值**：
 * 取景参数经过多轮实测定稿，改数值属于产品决策，不在这里做。
 */

/* 版面 */
export const WIDE_BREAKPOINT = 1024;   // 窄屏 / 宽屏分界
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
