/*
 * stores/editor.js — 编辑页全局状态层（Pinia）
 *
 * 职责: 业务/编辑状态（项目、当前楼层与选中对象、工具/视图状态、HA 与插件的刷新
 *       版本号、保存/撤销状态）+ 只依赖这些状态的派生数据 getters + 纯状态 Actions。
 *       它们是多个互不相邻的组件都要读写的，放在根组件 data() 里就得靠 props
 *       一层层下发，正是全局状态层要解决的痛点。
 *
 * 不放什么（重要）:
 *  1. UI 瞬时状态 —— 弹窗开关 (xxxOpen)、tooltip 在 stores/ui.js；拖拽上传进度、
 *     搜索词、输入框等只服务一块 UI 的局部状态仍留在各自组件 data()。
 *  2. THREE 对象 / PluginEngine.instances / View3D.scene / Editor —— 引擎是非 Vue 响应式
 *     的模块单例，仍走 engine/index.js 的 window 桥接。Pinia 默认对 state 做深层 reactive，
 *     Proxy 包裹 Object3D 会破坏 instanceof 与遍历；这类对象绝对不能进 store。
 *  3. 需要 $nextTick / DOM / 撤销栈 / 引擎重放的编排动作（commit / dirty / undo / setTool /
 *     setMode / applyBg …）—— 仍留 App.vue 的 methods。本文件的 Actions 只做「改状态」，
 *     不碰引擎，因此可以被任意组件直接调用，也可以在根组件用 mapActions 生成同名
 *     转发；engine 侧的 window.App.* 桥接由 bridge.js 直接调这些 Action 实现。
 *
 * 两个入口 main.js / main-display.js 各自 createApp().use(createPinia())，是两份独立的
 * Pinia 实例 —— 编辑页与大屏页是不同文档，store 不跨页面共享内存；跨页同步仍由服务端
 * data/project.json 承担（大屏用 fetchProject() 读取）。
 *
 * 迁移口径: App.vue 用 mapWritableState 生成同名可写 computed，因此所有 `this.project`
 * 读写（含 `this.project = snapshot` 整份替换）保持原样，撤销栈 Recode 的
 * JSON 深拷贝、serializeProject()、commit() 链路都不需要改。
 *
 * store 刻意不 import engine：避免把 three / HA 的模块图拉进状态层，也让 SSR 冒烟
 * 与单元测试可以单独加载本文件。getters 里访问非响应式服务层一律走 window.X，
 * 并靠 entVersion / histVer / bgTick 这些响应式信号显式触发重算。
 */
import { defineStore } from 'pinia';
import { useHaStore } from './ha';

/* 项目 settings 的默认骨架与 catalog.js 的 newSettings() 一致（目前返回 {}）。 */
function emptyProject() {
  return { name: '我的家', floors: [], settings: {} };
}

export const useEditorStore = defineStore('editor', {
  state: () => ({
    /* ---- 项目与编辑态 ---- */
    project: emptyProject(),
    floorIdx: 0,
    selection: null,          // { kind, id }
    tool: 'select',
    mode: '2d',
    showLabels: true,         // 3D 设备标签显示开关

    /* ---- 刷新信号 / 状态标记（供子组件与 computed 触发重算） ---- */
    entVersion: 0,            // HA 实体变化版本号（非响应式全局目录的重算信号）
    histVer: 0,               // 撤销栈版本号（撤销/重做按钮置灰态）
    bgTick: 0,                // 背景参数变更计数器
    savedState: '已保存',

    /* HA 连接状态与配置镜像已全部迁到 stores/ha.js（唯一真相）。
     * 下面 getters / actions 里保留的同名成员只是薄代理，供尚未改源的调用点过渡，
     * 不要再往这里加新的 HA 字段。token 只在页面内存，不进 project 快照。 */

    /* ---- 画布/视图派生展示值 ---- */
    houseW: 0, houseD: 0,     // 本层户型长宽（米，2D 徽标）
    zoomPct: 100,

    /* ---- 参考贴图（生命周期跨楼层切换/撤销恢复，属于编辑态而非浮层局部态） ---- */
    bgW: 10,
    bgInfo: { has: false, hidden: false },
  }),

  /* 共享派生数据：原先 App.vue / BackdropPanel / FloorSettings / SelectionInspector
   * 各自算一份 cur、bgStyle、selItem、kindName，现在收敛到一处。
   * Pinia getter 会缓存，只有响应式依赖变化才重算；访问非响应式服务层时
   * 必须显式 `void this.xxx` 读一次版本信号，语义与原 Vue computed 完全一致。 */
  getters: {
    cur: (s) => (s.project ? s.project.floors[s.floorIdx] : null),
    bgStyle: (s) => (s.project && s.project.settings && s.project.settings.background) || '',
    kindName: (s) => (s.selection
      ? ({ wall: '墙体', door: '门', window: '窗', furniture: '家具', device: '设备' })[s.selection.kind] || ''
      : ''),
    /* ↓ HA 状态薄代理 → stores/ha.js（过渡用，新代码直接 useHaStore）。 */
    haStatus() { return useHaStore().haStatus; },
    haUrl() { return useHaStore().haUrl; },
    haToken() { return useHaStore().haToken; },
    haHasToken() { return useHaStore().haHasToken; },
    haCfgVersion() { return useHaStore().haCfgVersion; },
    haCfgError() { return useHaStore().haCfgError; },
    connClass() { return useHaStore().connClass; },
    connText() { return useHaStore().connText; },
    haUrlText() { return useHaStore().haUrlText; },
    /* 撤销栈是 engine 的非响应式单例，histVer 是它唯一的重算信号。
     * window.Recode 做了存在性保护，单独加载本文件（无 engine 桥接）也不会抛错。 */
    canUndo(s) {
      void s.histVer;
      const R = typeof window !== 'undefined' && window.Recode;
      return !!(R && R.canUndo());
    },
    canRedo(s) {
      void s.histVer;
      const R = typeof window !== 'undefined' && window.Recode;
      return !!(R && R.canRedo());
    },
    /* 依赖其它 getter 时用 this（不能写成箭头函数）。 */
    selItem() {
      if (!this.selection || !this.cur) return null;
      const map = { wall: 'walls', door: 'doors', window: 'windows', furniture: 'furniture', device: 'devices' };
      const arr = this.cur[map[this.selection.kind]];
      return arr ? arr.find((x) => x.id === this.selection.id) || null : null;
    },
  },

  /* 纯状态 Actions：只改本 store 的 state，不碰引擎 / DOM / 定时器 / 网络。
   * 组件可以直接 mapActions 调用，省掉一层 emit；根组件也用 mapActions 生成
   * 同名方法，让 85 个 methods 保持原样；window.App 桥接见 bridge.js。 */
  actions: {
    bumpEntities() { this.entVersion++; },
    bumpHistory() { this.histVer++; },
    bumpBg() { this.bgTick++; },
    setSelection(sel) { this.selection = sel; },
    /* ↓ HA Actions 薄代理 → stores/ha.js；新代码直接调 useHaStore 的同名 Action。 */
    setHaStatus(s) { useHaStore().setHaStatus(s); },
    applyHaConfig(c) { useHaStore().applyHaConfig(c); },
    setHaCfgError(msg) { useHaStore().setHaCfgError(msg); },
    setZoomPct(pct) { this.zoomPct = pct; },
    /* 2D 编辑器只暴露 ppm；「60px/米 = 100%」的换算口径原先在 App.vue 里散写 4 处
     * （setFloor / locateDevice / zoomStep / zoomFit），统一收进 Action。
     * bridge.js 的 updateZoomLabel 收到的是引擎已算好的 pct，仍走 setZoomPct。 */
    setZoomFromPpm(ppm) { this.zoomPct = Math.round(ppm / 60 * 100); },
    setHouseSize(w, d) { this.houseW = w; this.houseD = d; },
    markSaved() { this.savedState = '已保存'; },
    markUnsaved() { this.savedState = '未保存'; },
  },
});
