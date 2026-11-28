/*
 * services/prefs.js — 前端偏好存储（localStorage）的唯一入口
 *
 * 为什么单独一个文件：
 *  - localStorage 在隐私模式 / 存储被禁 / 坏 JSON 时会抛异常，各处散写 try/catch
 *    很容易漏，一漏就是整页 init 中断（比丢一个开关难查得多）。
 *  - 键名散落在组件里会撞车（`ha3d.showCards` vs `ha3d.displayCards`…），
 *    统一在这里列出来，改名只需改一处。
 *  - 不进 Pinia state：偏好是「浏览器本地事实」，不是页面运行态；store 只把它
 *    当初始值读一次，之后由 Action 落盘，避免双向 watch 循环。
 *
 * 约定：所有偏好只影响「本机这个浏览器」的显示，不参与项目数据、不同步服务端。
 */

/* 键名清单（新增偏好请加在这里，不要写裸字符串）
 * 按值类型选对应的读写函数：
 *   · 布尔（prefBool / prefSetBool，存 '1' / '0'）
 *   · 数值（prefInt / prefSetInt）
 */
export const PREF_KEYS = {
  /* —— 布尔开关 —— */
  autoRotate: 'ha3d.autoRotate',       // 大屏：自动旋转
  showLabels: 'ha3d.showLabels',       // 编辑页：设备标签（2026-11-20 前与展示页共用，现仅编辑页写）
  panelShowLabels: 'ha3d.panelShowLabels', // 大屏展示页：设备标签（首读回退旧共用键，见 PanelApp）
  editorCards: 'ha3d.showCards',       // 编辑页：2D/3D 卡片预览浮层开关
  nightMode: 'ha3d.nightMode',         // 全站：黑暗模式（3D 光照 + DOM 主题，engine/lighting.js 读）

  /* —— 数值 —— */
  displayFloor: 'ha3d.displayFloor',   // 大屏：上次查看的楼层索引
  lightLevel: 'ha3d.lightLevel',       // 全站：全局亮度微调 20~100（%），叠加在日/夜基线之上
};

const LS = typeof localStorage !== 'undefined' ? localStorage : null;

export function prefGet(key, def) {
  if (!LS) return def;
  try {
    const raw = LS.getItem(key);
    return raw == null ? def : raw;
  } catch (e) {
    return def;   // 隐私模式 / 配额满 / 被禁
  }
}

export function prefSet(key, value) {
  if (!LS) return;
  try { LS.setItem(key, value); } catch (e) { /* 静默：偏好丢失不该影响功能 */ }
}

/* 布尔偏好：存 '1' / '0'。历史值（'0' 视为关、其它一律开）与自动旋转/标签同一口径。 */
export function prefBool(key, def) {
  const raw = prefGet(key, null);
  if (raw == null) return def;
  return raw !== '0';
}

export function prefSetBool(key, value) {
  prefSet(key, value ? '1' : '0');
}

/* 数值偏好：非数字 / 空串一律回默认值（楼层索引一旦是 NaN，页面会直接白屏） */
export function prefInt(key, def) {
  const n = parseInt(prefGet(key, ''), 10);
  return Number.isFinite(n) ? n : def;
}

export function prefSetInt(key, value) {
  const n = Number(value);
  prefSet(key, Number.isFinite(n) ? String(Math.trunc(n)) : '');
}

/* 对象偏好（机位 / 锚点）：坏 JSON 按「没有记录」处理，由调用方走默认值 */
