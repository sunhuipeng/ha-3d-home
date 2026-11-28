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
 *     setMode / applyBg …）—— 仍留 EditApp.vue 的 methods。本文件的 Actions 只做「改状态」，
 *     不碰引擎，因此可以被任意组件直接调用，也可以在根组件用 mapActions 生成同名
 *     转发；engine 侧的 window.App.* 桥接由 bridge.js 直接调这些 Action 实现。
 *
 * 两个入口 main-edit.js（编辑页）/ main-index.js（展示页 → PanelApp）各自
 * createApp().use(createPinia())，是两份独立的 Pinia 实例 —— 编辑页与大屏页是
 * 不同文档，store 不跨页面共享内存；跨页同步仍由服务端
 * data/project.json 承担（大屏用 fetchProject() 读取）。
 *
 * 迁移口径: EditApp.vue 用 mapWritableState 生成同名可写 computed，因此所有 `this.project`
 * 读写（含 `this.project = snapshot` 整份替换）保持原样，撤销栈 Recode 的
 * JSON 深拷贝、serializeProject()、commit() 链路都不需要改。
 *
 * store 刻意不 import engine：避免把 three / HA 的模块图拉进状态层，也让 SSR 冒烟
 * 与单元测试可以单独加载本文件。getters 里访问非响应式服务层一律走 window.X，
 * 并靠 entVersion / histVer / bgTick 这些响应式信号显式触发重算。
 */
import { defineStore } from 'pinia';
import { useHaStore } from './ha';
import { useCatalogStore } from './catalog';
import { PREF_KEYS, prefBool, prefSetBool } from '../services/prefs';
import { KIND_ARR, KIND_NAME } from '../model/catalog';
import { labelOffsetDefaultOf, labelOffsetValOf } from '../composables/useNumEditing';
import { PPM_BASE } from '../engine/editor';

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
    /* 3D 设备标签显示开关：初值读本机偏好（编辑页键 ha3d.showLabels；展示页已拆到
     * panelShowLabels，2026-11-20 起两页各自独立），toggleLabels 落盘 ——
     * 之前编辑页只存内存，刷新即恢复默认、两页口径不一致。 */
    showLabels: prefBool(PREF_KEYS.showLabels, true),
    /* 2D 卡片预览开关（画布右上角浮层）：初值读本机偏好，之后由 toggleCards 落盘，
     * 刷新/重开编辑器保持上次选择。默认关（320px 浮层会占掉右上角）。 */
    showCards: prefBool(PREF_KEYS.editorCards, false),

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
    kindName: (s) => (s.selection ? KIND_NAME[s.selection.kind] || '' : ''),
    /* ↓ HA 状态薄代理 → stores/ha.js（过渡用，新代码直接 useHaStore）。
     * 仅保留仍被 DevPanel.vue（haStatus）与 TopBar.vue（connClass / connText）
     * 从本 store 读取的三个；其余零消费的代理已删除。 */
    haStatus() { return useHaStore().haStatus; },
    connClass() { return useHaStore().connClass; },
    connText() { return useHaStore().connText; },
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
      const arr = this.cur[KIND_ARR[this.selection.kind]];
      return arr ? arr.find((x) => x.id === this.selection.id) || null : null;
    },

    /* ---- 选中项派生（审计 3.15：原 SelectionInspector.vue 独有派生收敛至此） ----
     * 这些派生依赖非响应式服务层（window.PluginEngine / window.HA / catalog 函数），
     * 统一靠 `void this.entVersion` 触发重算 —— 组件不再各自手写失效信号，且
     * 多组件共享同一份缓存。纯文案 / 纯逻辑类（roomOptions / selFieldsTip /
     * bindingTip / clickCheckboxText / clickTip / kindLabel / selStyleTitle /
     * devClickText / hasDeviceContract）不依赖服务层，仍留在组件内。
     * 服务层一律走 window.X（本 store 刻意不 import engine，见文件头口径）。 */
    selName() {
      const it = this.selItem;
      if (!it || !this.selection) return '';
      void this.entVersion;
      return window.itemDisplayName(this.selection.kind, it);
    },
    /* 选中家具有没有可用模型：目录与实例都没给地址时，面板才露出「模型地址」手填行 */
    selHasModel() {
      const it = this.selItem;
      if (!it || !this.selection || this.selection.kind !== 'furniture') return true;
      return !!(it.model || window.furnSpec(it).model);
    },
    /* 选中家具的同类模型（右侧切换，按固定类型聚合） */
    sameModels() {
      void this.entVersion;
      const it = this.selItem;
      if (!it || this.selection.kind !== 'furniture') return [];
      const t = window.furnSpec(it).type;
      if (!t) return [];
      return window.allFurniture().filter((f) => (t === 'other' ? window.isOtherFurnType(f.type) : f.type === t));
    },
    /* 选中对象的插件样式列表: 设备按 type 聚合，门窗按插件 styles 聚合 */
    selStyleList() {
      const it = this.selItem;
      if (!it) return [];
      const k = this.selection.kind;
      if (k === 'device') return window.deviceStyles(window.devTypeOf(it)) || [];
      if (k === 'door' || k === 'window') {
        void this.entVersion;
        if (!window.PluginEngine || !window.PluginEngine.ready) return [];
        return window.PluginEngine.styles(k) || [];
      }
      return [];
    },
    selStyleId() {
      const it = this.selItem;
      if (!it) return '';
      if (this.selection.kind === 'device') {
        const s = window.deviceStyleDef(it, window.devTypeOf(it));
        return s ? s.id : '';
      }
      const list = this.selStyleList;
      const s = (it.style && list.find((x) => x.id === it.style)) || list[0];
      return s ? s.id : '';
    },
    selStyleDesc() {
      const s = this.selStyleList.find((x) => x.id === this.selStyleId);
      return s && s.desc ? s.desc : '';
    },
    devIsLight() {
      const it = this.selItem;
      if (!it || this.selection.kind !== 'device') return false;
      return window.devTypeOf(it) === 'light';
    },
    /* 家具插件实例（device + type:'furniture'）的家具分类中文名（柜架/床品/桌几…）:
     * 分类键来自插件造型的 ftype（styles[].ftype 覆盖插件级），由引擎透传到聚合造型条目。
     * 未声明 ftype 回退「家具」，枚举外的值经 furnTypeOfStyle 归「其他」。非家具返回 ''。 */
    furnKind() {
      const it = this.selItem;
      if (!it || this.selection.kind !== 'device' || window.devTypeOf(it) !== 'furniture') return '';
      void this.entVersion;   // 插件加载/热刷新后 ftype 才有值，跟样式列表同一信号重算
      void useCatalogStore().types; // 家具分类枚举来自 /api/catalog，目录到齐后中文名才可解析
      return window.furnTypeName(window.furnTypeOfDevice(it)) || '家具';
    },
    /* 当前造型名（「设备绑定」区的模型 chip）：设备按 devTypeOf 解析，
     * 门/窗按插件聚合样式列表取 —— 与设备同一套展示，不再回退成「默认造型」。 */
    devStyleName() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it) return '';
      if (k === 'device') {
        const s = window.deviceStyleDef(it, window.devTypeOf(it));
        return s ? s.name : '';
      }
      if (k === 'door' || k === 'window') {
        const s = this.selStyleList.find((x) => x.id === this.selStyleId);
        return s ? s.name : '';
      }
      return '';
    },
    /* 标签抬升高度：共享纯函数（composables/useNumEditing.js，消审计 2.13 的双份实现） */
    labelOffsetDefault() {
      return labelOffsetDefaultOf(this.selItem, this.selection && this.selection.kind);
    },
    /* 面板显示值：实例覆盖 obj.labelOffset 优先，没设过就显示造型默认值 */
    labelOffsetVal() {
      return labelOffsetValOf(this.selItem, this.labelOffsetDefault);
    },
    /* 当前样式的条目参数（值 = 默认值 ∪ 实例已存值 obj.styleOpts） */
    selOptList() {
      void this.entVersion;
      const k = this.selection && this.selection.kind;
      if (k !== 'device' && k !== 'door' && k !== 'window') return [];
      const it = this.selItem;
      if (!it) return [];
      const s = this.selStyleList.find((x) => x.id === this.selStyleId);
      const schema = window.PluginEngine.normalizeOptions((s && s.options) || []);
      if (!schema.length) return [];
      /* 取值合并（默认∪已存）直接用引擎的 mergeOptions —— 与 model3d/plan2d 渲染时
       * styleOptionsOf 是同一套规则，面板显示什么、场景就画什么，不会各改各的 */
      const merged = window.PluginEngine.mergeOptions(schema, it.styleOpts || {});
      return schema.map((o) => Object.assign({}, o, { value: merged[o.key] }));
    },
    /* 选中对象的插件绑定字段（按当前样式所属插件取 fields 声明） */
    selFields() {
      const k = this.selection.kind;
      if (k !== 'device' && k !== 'door' && k !== 'window') return [];
      if (!window.PluginEngine) return [];
      void this.entVersion;
      const it = this.selItem;
      const kindOrType = k === 'device' ? window.devTypeOf(it) : k;
      const def = window.PluginEngine.defFor(kindOrType, it && it.style);
      return def ? window.PluginEngine.fieldsOf(def) : [];
    },
    /* 点击控制规格（插件声明优先，否则内置默认；null = 不支持点击）。
     * devClickSpec = 插件**声明**的原始 click 规格（label / on / off 供下拉与文案展示，
     * 不含实例覆盖 —— 面板正是编辑覆盖的地方）；「能不能点」的实例级判定走
     * PluginEngine.instanceClickSpec（与 3D 标签 clickable / toggleDevice 同一口径） */
    devClickSpec() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it || !window.PluginEngine) return null;
      if (k !== 'device' && k !== 'door' && k !== 'window') return null;
      return window.PluginEngine.clickSpec(k === 'device' ? window.devTypeOf(it) : k, it.style);
    },
    devClickOn() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it || !window.PluginEngine) return false;
      if (k !== 'device' && k !== 'door' && k !== 'window') return false;
      /* 勾选框编辑的正是 obj.click：显式值直接回显（否则勾上又自己弹回）；
       * 未设置时跟随 instanceClickSpec 的默认结论（插件 defaultOn / clickSvc 覆盖都算进来），
       * 与 3D 标签是否可点、卡片电源开关是否渲染完全同一口径。
       * type 要传真实 HA 域（设备取 devTypeOf，门窗就是 kind），不能直接传 'device'。 */
      if (it.click === true || it.click === false) return it.click;
      return !!window.PluginEngine.instanceClickSpec(it, k === 'device' ? window.devTypeOf(it) : k);
    },
    devClickSvcOpts() {
      if (!window.PluginEngine) return [];
      return window.PluginEngine.clickServiceOptions();
    },
    /* 选中设备 / 门窗的 HA 实时读数（“22.5°C”这类）；未绑定或查不到返回 '' */
    devState() {
      void this.entVersion;
      const it = this.selItem;
      if (!it || !it.entityId) return '';
      const st = window.HA.getState(it.entityId);
      if (!st) return '';
      return st.state + window.HA.unitOf(st);
    },
    /* 绑定字段的实时读数（函数式 getter：面板按字段 key 逐个取） */
    devFieldState() {
      return (key) => {
        void this.entVersion;
        const it = this.selItem;
        const eid = it && it[key];
        if (!eid) return '';
        const st = window.HA.getState(eid);
        if (!st) return '未找到';
        return st.state + window.HA.unitOf(st);
      };
    },
  },

  /* 纯状态 Actions：只改本 store 的 state，不碰引擎 / DOM / 定时器 / 网络。
   * 组件可以直接 mapActions 调用，省掉一层 emit；根组件也用 mapActions 生成
   * 同名方法，让 85 个 methods 保持原样；window.App 桥接见 bridge.js。 */
  actions: {
    bumpEntities() { this.entVersion++; },
    bumpHistory() { this.histVer++; },
    bumpBg() { this.bgTick++; },
    /* 卡片预览开关：纯翻转 + 落盘（本机偏好）。toast 与 3D/引擎联动仍留根组件。
     * 落盘写在 Action 里，而不是 watch(showCards)：任何调用点（按钮 / 快捷键 /
     * 桥接）都能记住，也不需要额外的 watch 生命周期。 */
    toggleCards() {
      this.showCards = !this.showCards;
      prefSetBool(PREF_KEYS.editorCards, this.showCards);
    },
    setSelection(sel) { this.selection = sel; },
    /* HA 的 Action 一律直接走 stores/ha.js（编辑页与展示页共用同一入口），
     * 这里只保留上面三个 getter 薄代理供旧组件读取状态。 */
    setZoomPct(pct) { this.zoomPct = pct; },
    /* 2D 编辑器只暴露 ppm；「60px/米 = 100%」的换算口径原先在 App.vue 里散写 4 处
     * （setFloor / locateDevice / zoomStep / zoomFit），统一收进 Action。
     * bridge.js 的 updateZoomLabel 收到的是引擎已算好的 pct，仍走 setZoomPct。 */
    setZoomFromPpm(ppm) { this.zoomPct = Math.round(ppm / PPM_BASE * 100); },
    setHouseSize(w, d) { this.houseW = w; this.houseD = d; },
    markSaved() { this.savedState = '已保存'; },
    markUnsaved() { this.savedState = '未保存'; },
  },
});
