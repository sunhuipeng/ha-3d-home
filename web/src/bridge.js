/*
 * bridge.js — engine（非 Vue 模块单例）→ Pinia 的单向桥接
 *
 * 背景：engine/editor.js、engine/view3d.js 保留了改造前经典脚本的三个全局调用点：
 *   - Editor.select()            → App.setSelection({ kind, id })   ← 选中态同步
 *   - Editor.setZoom() / fit()   → App.updateZoomLabel(pct)         ← 缩放百分比
 *   - View3D 设备控制回调         → App.toast(msg)                   ← 操作提示
 * 它们都写着 `if (window.App) ...` 做存在性保护。Vite/SFC 改造时两个入口只写了
 * createApp(...).mount('#app')，从未把根组件实例赋给 window.App，于是这些调用
 * 全部静默短路：选中设备/家具/门窗后 Vue 侧的 selection 始终是 null，右侧属性栏
 * 永远停在「楼层设置」；缩放百分比与 3D 控制提示也一起失效。
 *
 * 这里刻意不把整个 Vue 组件实例挂到 window：那会把引擎耦合到组件内部方法名，
 * 而上一轮全局状态化就出过「mapActions 只留别名、原名没映射」导致 init()
 * 抛 TypeError 的事故。桥接对象只暴露 engine 真正用到的三个函数，直接调
 * Pinia Action，状态写入与组件树解耦 —— 组件改名、映射漏写都不再影响它。
 *
 * 安装时机：必须在 app.mount() 之前（mounted() 里的 init() 会立刻用到）。
 * 两个入口各自 createPinia()，所以各装一份，不跨页面共享内存。
 */
import { useEditorStore } from './stores/editor';
import { useUiStore } from './stores/ui';
import { useHaStore } from './stores/ha';

export function installAppBridge(pinia, overrides = {}) {
  if (typeof window === 'undefined') return null;   // SSR 冒烟不碰 window
  const editor = useEditorStore(pinia);
  const ui = useUiStore(pinia);
  const bridge = {
    setSelection: (sel) => editor.setSelection(sel),
    updateZoomLabel: (pct) => editor.setZoomPct(pct),
    toast: (msg) => ui.toast(String(msg)),
    ...overrides,
  };
  window.App = bridge;
  return bridge;
}

/* HA（非 Vue 传输客户端）→ ha store 的单向事件桥接。
 *
 * 以前两个根组件各写一遍 HA.on('status', s => this.setHaStatus(s))，状态散在
 * editor store 的镜像里，谁先注册、init 有没有跑完都会影响首帧显示。这里在
 * app.mount() 之前统一注册，事件边界只做「状态写入」：
 *   - status  → ha store 的 haStatus / connected / demo
 *   - change  → entityVersion++ 与 entityCount（HUD composable 的重算信号）
 * 渲染副作用仍归各页的 onHAChange()（要 Editor.render / View3D.refresh /
 * checkSceneWatchers），bridge 不代替编排，也不触碰 engine 的 listeners 顺序。
 *
 * 两个入口各自 createPinia()，所以各装一份；HA 连接也是两页各连一次 WebSocket。
 */
export function installHaBridge(pinia) {
  if (typeof window === 'undefined' || !window.HA) return null;
  const ha = useHaStore(pinia);
  window.HA.on('status', (s) => ha.setHaStatus(s));
  window.HA.on('change', () => ha.applyChange());
  return ha;
}
