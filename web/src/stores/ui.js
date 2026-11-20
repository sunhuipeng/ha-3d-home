/*
 * stores/ui.js — 跨组件 UI 状态层（Pinia）
 *
 * 为什么进全局状态：这 8 个 xxxOpen 不是「某块 UI 自己的局部状态」——
 * setTool() 会一次改 4 个、顶栏按钮各开 1 个、画布 mousedown 会关 2 个、
 * Esc 快捷键与弹窗自身的 × 也会改。之前靠 props 下发 + emit 回收，8 个组件
 * 各收一个 :open、各发一个 close，纯粹是透传。tooltip 同理：BgPanel、
 * DispCfgModal 与几十处根组件 method 都要触发，但只在 #tooltip 一处展示。
 *
 * viewportWide 同理，且更关键：它是「版面模式」的唯一真相，被三处同时消费 ——
 * 卡片控件（窄屏防误触）、PanelApp 的取景 / HUD、以及窄屏手势白名单。
 * 以前只在 PanelApp.data().wide 里，组件拿不到；若让每个控件自己加 resize 监听，
 * 跨断点那一帧就会出现「页面已放行手势、组件还在点选态」的错位。
 *
 * 刻意不进来的东西（保持组件自持）：上传进度、安装密钥、搜索词、输入框、
 * 分类页签、滚动渐隐、重置确认文本 —— 它们只服务一块 UI，进 store 只会变成杂物抽屉。
 * common/EntityInput.vue / OptionRow.vue 也因此继续保持纯 props + emits，
 * 不绑定任何 store（大屏页拆出的组件将来要复用它们）。
 *
 * 与 editor store 的分工：editor 放「项目数据与编辑态」，ui 放「界面开合、提示与版面模式」。
 * 各入口各自 createPinia()，本 store 只在本页文档内共享；matchMedia 监听由
 * bridge.js 的 installViewportWatcher() 统一安装，跨断点只触发一次。
 */
import { defineStore } from 'pinia';
/* 带 .js 后缀：Vite 与 Node 原生 ESM 都能解析，store 可被 node --test 直接加载
   （v-tap 指令的事件流单测要读 viewportWide）。 */
import { WIDE_BREAKPOINT } from '../model/stageLayout.js';

/* toast 的淡出定时器属于实现细节，不需要响应式，也不该进 $state 被序列化。
 * 模块级单例即可：一个页面文档只有一个 Pinia 实例。 */
let toastTimer = null;

export const useUiStore = defineStore('ui', {
  state: () => ({
    /* ---- 8 个浮层 / 弹窗开关（key = 语义名 + 'Open'） ---- */
    furnOpen: false,      // 家具库
    devOpen: false,       // 设备浮层
    connOpen: false,      // 连接与服务
    importOpen: false,    // 导入插件 / 包
    dispOpen: false,      // 展示大屏展示项配置
    bgOpen: false,        // 贴图（参考底图）菜单
    backdropOpen: false,  // 背景插件面板
    resetOpen: false,     // 重置本层确认弹窗

    /* ---- 全局轻提示（DOM 在 EditApp.vue 的 #tooltip） ---- */
    tooltipMsg: '',
    tooltipShow: false,
    tooltipStyle: {},

    /* ---- 版面模式（跨组件唯一真相） ----
     * 与 CSS @media (min-width:1024px) 和 PanelApp 取景共用 WIDE_BREAKPOINT。
     * 初值必须同步算出来：不能默认 false 等 mounted 再修，否则首帧会按
     * 「宽屏直接点」渲染卡片控件，再闪成滑动态。SSR 无 window 时按宽屏处理。 */
    viewportWide: typeof window === 'undefined' ? true : window.innerWidth >= WIDE_BREAKPOINT,
  }),

  actions: {
    /* 只由 bridge.js 的 matchMedia change 事件调用；写同值 Pinia 不触发重渲染 */
    syncViewport() {
      if (typeof window === 'undefined') return;
      this.viewportWide = window.innerWidth >= WIDE_BREAKPOINT;
    },

    /* key 用语义名：'furn' / 'dev' / 'conn' / 'import' / 'disp' / 'bg' / 'backdrop' / 'reset'。
     * 父级模板里 `@close="closeFlyout('bg')"` 这样写，组件不必知道自己对应哪个 state 键。 */
    setFlyout(key, val) {
      const k = key + 'Open';
      if (k in this) this[k] = !!val;
    },
    openFlyout(key) { this.setFlyout(key, true); },
    closeFlyout(key) { this.setFlyout(key, false); },

    /* setTool() 的四个浮层互斥开关一次改完，避免根组件散写四次 state。 */
    setToolFlyouts(tool) {
      this.furnOpen = tool === 'furniture';
      this.devOpen = tool === 'device';
      this.bgOpen = tool === 'bg';
      this.backdropOpen = tool === 'backdrop';
    },

    /* 兼容原来的根组件 toast()：组件里由 mapActions 生成同名方法继续调它，
     * engine 侧的 window.App.toast() 由 bridge.js 直接调这个 Action
     * （展示页入口会覆盖成 PanelApp.toastMsg，那里才有气泡 DOM）。 */
    toast(msg) {
      this.tooltipMsg = msg;
      this.tooltipShow = true;
      this.tooltipStyle = { left: '50%', top: '60px', transform: 'translateX(-50%)' };
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        this.tooltipShow = false;
        this.tooltipStyle = {};
      }, 2200);
    },
  },
});
