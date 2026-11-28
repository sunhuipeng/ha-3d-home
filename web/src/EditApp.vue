<template>
  <!-- 启动遮罩（两页共用 components/common/BootOverlay.vue），由 boot.js 的 bootDone() 移除 -->
  <boot-overlay />

  <!-- 顶栏：批次 2 拆到 components/pages/editor/TopBar.vue；全局状态化后零 props，
       状态由组件自己从 store 直读，只剩动作 emits 回根组件编排。 -->
  <top-bar
    @open-display="openDisplay" @select-floor="selectFloor" @add-floor="addFloor"
    @undo="undo" @redo="redo" @set-mode="setMode"
    @toggle-labels="toggleLabels" @toggle-cards="toggleCards" @reset-anchor="resetAnchor"
    @open-conn="openConn" @open-import="openImport" />

  <div id="appBody">
    <!-- 左侧导航：批次 2 拆到 components/pages/editor/ToolRail.vue。
         统一状态机不变：除"重置本层"外全部平级，tool 由组件从 store 直读驱动高亮。 -->
    <tool-rail @set-tool="setTool" @reset-floor="openResetFloor" />

    <!-- 画布区：批次 4 拆到 components/pages/editor/CanvasStage.vue，内部再分
         Editor2D.vue / Viewer3D.vue 两个引擎容器。引擎在 init() 里持有这两个 DOM，
         因此组件一律用 v-show 常驻，改 v-if 会销毁元素让 Editor / View3D 失效。
         画布区状态与缩放动作全部走 Pinia；只有压视图撤销栈 emit 回根组件。 -->
    <canvas-stage @view-dirty="viewDirty" />

    <!-- 右侧属性栏（2D/3D 预览均保留）：批次 3 的分支组件拆到 components/pages/editor/。
         分支条件与 DOM #sidePanel 保持不变；组件通过 mapState 直读全局 store（Pinia），
         动作一律 emit 回根组件，由根组件完成 commit / 撤销栈 / 引擎刷新。 -->
    <aside id="sidePanel" v-if="cur">
      <!-- 分支一：左侧「背景」工具激活时的专用面板 -->
      <backdrop-panel v-if="tool === 'backdrop'"
        @set-wall-opacity="setWallOpacity" @set-bg-opt="setBgOpt" @set-bg-field="setBgField" />

      <!-- 分支二：左侧「房间」绘制工具激活时的房间属性（列表排序 + 单间属性）。
           沿用「背景」的 tool 驱动模式；优先级放在「选中房间」之前 —— 画房间 / 在画布上
           选中房间时右侧都稳定停在本面板，不会被独立的 RoomPanel 分支顶掉。
           面板内部按选中态排区块：有选中房间时「选中房间 → 房间属性 → 房间顺序」，
           未选中时「房间顺序 → 选中提示」。setTool('room') 不清选中态，
           所以 RoomPanel 仍能显示当前选中房间的名称/面积/颜色。 -->
      <rooms-panel v-else-if="tool === 'room'"
        @reorder="reorderRooms" @select-room="selectRoom"
        @set-room-prop="setRoomProp" @del-selected="delSelected" />

      <!-- 分支三：左侧「设备」工具激活时的设备排序（顺序即卡片权重）。
           点设备 tab 会同时弹出设备浮层，右侧固定停在这里；列表只放设备（家具与
           未绑实体的不出卡，不列）。卡片端「单元素组 / 多控件卡片」的分类排序在
           CardEngine.buildListCard 内完成，权重就是 fl.devices 的数组顺序。 -->
      <dev-order-panel v-else-if="tool === 'device'"
        @reorder="reorderDevices" @select-device="selectDevice"
        @toggle-hide="toggleDeviceCardHide" @show-all="showAllDeviceCards" />

      <!-- 分支四：选中房间 → 单间属性（名称 / 面积 / 地面颜色 / 删除）。
           房间不是「元素」：没有 x/y、没有插件样式与参数，所以单独一个面板，
           不塞进 SelectionInspector 的样式/参数区（那里所有分支都假设 x/y 存在）。 -->
      <room-panel v-else-if="selection && selection.kind === 'room'"
        @set-room-prop="setRoomProp" @del-selected="delSelected" />

      <!-- 分支五：未选中 / 选中墙体时的楼层与项目设置 -->
      <floor-settings v-else-if="!selection || selection.kind === 'wall'"
        @set-project-name="setProjectName" @set-floor-height="setFloorHeight" @set-floor-name="setFloorName"
        @add-floor="addFloor" @copy-floor="copyFloor" @del-floor="delFloor" @set-weather="setWeather"
        @set-card="setCard" @add-card="addCard" @remove-card="removeCard"
        @open-disp-cfg="openDispCfg" />

      <!-- 分支六：选中对象的属性编辑（样式 / 参数 / 家具 / 3D 位置 / 绑定 / 点击控制）。
           动作经 :act props 打包下发（名单唯一出处 components/pages/editor/inspectorActs.js，
           审计 2.18：原先 20 个 emits 通道 + 两侧行样板，新增输入框要同步改 4 处） -->
      <selection-inspector v-else-if="selItem" :act="inspectorAct" />
    </aside>
  </div>

  <!-- ===== 批次 1：8 个弹窗 / 浮层已拆到 components/pages/editor/ 下 =====
       全局状态化后连 :open props 都去掉：开关在 stores/ui.js，由组件 mapState 直读，
       × 统一调 closeFlyout()；根组件只留需要操作引擎/项目数据并压撤销栈的动作。
       弹窗自身的输入框、搜索、页签滚动、上传与密钥等局部状态仍由各组件自持。 -->

  <!-- 贴图（参考底图）菜单 -->
  <bg-panel @close="closeFlyout('bg')" @uploaded="applyBgImage($event.url, $event.name)"
            @toggle="toggleBg" @scale="onBgScale" @clear="clearBg"></bg-panel>

  <!-- 重置当前楼层确认 -->
  <reset-modal @close="closeFlyout('reset')" @confirm="confirmResetFloor"></reset-modal>

  <!-- 家具库 -->
  <furn-panel @close="closeFlyout('furn')" @pick="pickFurniture"></furn-panel>

  <!-- 背景面板（背景插件按插件分组，只显示图标+文字，点击即应用） -->
  <backdrop-picker @close="setTool('select', true)" @select="setBackground"></backdrop-picker>

  <!-- 设备面板 -->
  <dev-panel @close="closeFlyout('dev')" @pick="pickEntity" @locate="locateDevice"></dev-panel>

  <!-- 连接与服务 -->
  <conn-modal @close="closeFlyout('conn')"></conn-modal>

  <!-- 导入插件：拖拽 / 点击选择 zip，选好就自动上传 -->
  <import-modal @close="closeFlyout('import')"></import-modal>

  <!-- 展示大屏配置（勾选场景与设备） -->
  <disp-cfg-modal @close="closeFlyout('disp')" @dirty="dirty()"></disp-cfg-modal>

  <!-- 左下角版本号：编译期由 src/version.js 从仓库根 package.json 导入，不写死 -->
  <span class="tb-ver tb-ver-corner" :title="appTitle">v{{ appVersion }}</span>
</template>

<script>
/*
 * EditApp.vue — 编辑页根组件（SFC，原 App.vue，2026-11-13 随 edit.html 改名）
 *
 * 迁移口径与展示页 PanelApp 一致：
 *  - 模板 = 原 public/index.html 的 #app 内容（v-* 指令原样保留）
 *  - data / computed / methods / watch / mounted 原样保留（Options API）
 *  - Editor / View3D / PluginEngine / Recode / fetchProject / buildDefaultProject 等
 *    引擎与领域层符号仍按 window 全局使用（engine/index.js 的兼容桥接）；
 *    HA 状态、HUD 派生、家具目录已分别迁到 stores/ha.js、composables/useHud.js、
 *    stores/catalog.js + model/catalog.js（见下方分层说明）。
 *    动态插件依赖 window.PluginEngine / window.THREE / window.HA，桥接不能删。
 *  - 组件按两层归类：components/common/ 放跨页面复用的纯接口组件（EntityInput /
 *    OptionRow，只靠 props + emits 通信）；components/pages/<页面>/ 放该页面专用组件，
 *    编辑页在 pages/editor/，后续大屏页拆出的组件放 pages/display/。
 *
 * 批次 1（UI 局部组件拆分）：8 个弹窗 / 浮层拆到 components/pages/editor/ 下，模板与
 * 「只服务该弹窗」的局部状态一起搬走。全局状态化后连 :open / :version / :project 等
 * props 都撤掉了：组件用 mapState 直读两个 store，根组件只留要操作 Editor / View3D /
 * PluginEngine / 项目数据并压撤销栈的动作（emits 回收 + store Actions）。
 * 本轮不动服务层、不动 CSS（全局选择器仍按原 id/class 命中，组件根元素 DOM 不变）。
 *
 * 批次 3（右侧属性栏分支）：BackdropPanel / RoomPanel / FloorSettings / SelectionInspector
 * 拆到 components/pages/editor/，它们用 mapState 直读全局 store（含收敛后的共享 getters），
 * 独有派生数据在组件内算，动作 emit 回根组件；根组件只留分支条件与 #sidePanel 容器。
 * 2026-11-13 新增 RoomsPanel（tool==='room' 分支，房间/设备 ↑↓ 排序，优先级高于选中房间分支）。
 *
 * 批次 4（画布区 / 引擎容器）：CanvasStage.vue 包住 #canvasWrap 与覆盖层，内部
 * Editor2D.vue（canvas#c2d）/ Viewer3D.vue（div#c3dWrap）是两个引擎容器。
 * 关键约束：Editor.init() / View3D.init() 在根组件 init() 里持有 DOM，容器必须
 * 常驻 —— 一律 v-show，绝不能改 v-if。三个组件零 props，状态与缩放动作走 Pinia，
 * 只有压视图撤销栈的 viewDirty() 用 emit 回根组件。
 *
 * 全局状态层（Pinia）：业务/编辑态在 stores/editor.js，浮层开关与 tooltip 在
 * stores/ui.js，二者都带 getters 与纯状态 Actions。根组件 data() 已清空，全靠
 * computed 的 mapWritableState / mapState 与 methods 的 mapActions 展开成同名属性；
 * engine 的 window.App 桥接由 bridge.js 承担。
 * 引擎对象仍走 window 桥接，不进 store（Proxy 会破坏 THREE.Object3D）。
 *
 * 结构重构（2026-11-28 第二轮）：属性编辑 / 参考底图 / 背景插件 / 房间与设备排序 /
 * 键盘绑定六个职责方法组拆到 composables/（见 import 处说明），本组件只留
 * init / 撤销栈 / 楼层 / 视图切换 / setTool / 引擎事件编排等生命周期强耦合部分。
 */
import { mapState, mapWritableState, mapActions } from 'pinia';
import { PREF_KEYS } from './services/prefs';
import { APP_NAME, APP_VERSION } from './version';
/* 3D 拾取 → 选中 → 卡片：与 index 大屏共用同一套判定（model/pick.js） */
import { selOfPick, applyPickHi } from './model/pick';
import { useSceneMode } from './composables/useSceneMode';
import { useEditorStore } from './stores/editor';
import { useUiStore } from './stores/ui';
import { useHaStore } from './stores/ha';
import { useCatalogStore } from './stores/catalog';
/* 结构重构（2026-11-28 第二轮）：原根组件的方法组按职责拆到 composables/ 下，
 * 以「方法组对象」形态导出，在此摊进 methods —— Vue 把每个 method 绑定到组件
 * 实例，`this` 语义与原地内联完全一致，纯搬运零行为变化：
 *   useNumEditing  属性编辑家族（setProp + 数值底座 + 标签抬升）
 *   useRefImage    参考底图（/api/refimg 全项目一张）
 *   useBackground  背景插件（applyBg / bindBgSettings / setBgOpt / setBgField / setBackground）
 *   useRooms       房间属性与排序
 *   useDeviceOrder 设备排序与卡片隐藏标记
 *   useEditorKeys  全局键盘绑定（bindKeys）
 * init / 撤销栈 / 楼层 / 视图切换 / setTool 等与引擎生命周期强耦合的编排仍留在本组件。 */
import { numEditingMethods } from './composables/useNumEditing';
import { refImageMethods } from './composables/useRefImage';
import { backgroundMethods } from './composables/useBackground';
import { roomMethods } from './composables/useRooms';
import { deviceOrderMethods } from './composables/useDeviceOrder';
import { editorKeysMethods } from './composables/useEditorKeys';
import { floorMethods } from './composables/useFloors';
import { INSPECTOR_ACTS } from './components/pages/editor/inspectorActs';
import { disposeEngine } from './engine';
import BootOverlay from './components/common/BootOverlay.vue';
import { bootDone, armBootFallback } from './components/common/boot.js';
import BgPanel from './components/pages/editor/BgPanel.vue';
import ResetModal from './components/pages/editor/ResetModal.vue';
import FurnPanel from './components/pages/editor/FurnPanel.vue';
import BackdropPicker from './components/pages/editor/BackdropPicker.vue';
import DevPanel from './components/pages/editor/DevPanel.vue';
import ConnModal from './components/pages/editor/ConnModal.vue';
import ImportModal from './components/pages/editor/ImportModal.vue';
import DispCfgModal from './components/pages/editor/DispCfgModal.vue';
import TopBar from './components/pages/editor/TopBar.vue';
import ToolRail from './components/pages/editor/ToolRail.vue';
import BackdropPanel from './components/pages/editor/BackdropPanel.vue';
import FloorSettings from './components/pages/editor/FloorSettings.vue';
import SelectionInspector from './components/pages/editor/SelectionInspector.vue';
import RoomPanel from './components/pages/editor/RoomPanel.vue';
import RoomsPanel from './components/pages/editor/RoomsPanel.vue';
import DevOrderPanel from './components/pages/editor/DevOrderPanel.vue';
import CanvasStage from './components/pages/editor/CanvasStage.vue';
import { initLighting } from './engine/lighting.js';

export default {
  name: 'EditApp',
  components: {
    BootOverlay, TopBar, ToolRail, CanvasStage,
    BackdropPanel, FloorSettings, SelectionInspector, RoomPanel, RoomsPanel, DevOrderPanel,
    BgPanel, ResetModal, FurnPanel, BackdropPicker,
    DevPanel, ConnModal, ImportModal, DispCfgModal,
  },

  /* 编辑页不渲染 HUD（hudTemp / hudSubs / hudCards 仅在展示页 PanelApp 模板绑定），
   * 故本页不调用 useHud()，也不需要 setup()。 */

  data() {
    /* 已经清空：业务/编辑态在 stores/editor.js，浮层开关与 tooltip 在 stores/ui.js，
     * 全部由 computed 里的 map* 展开成同名属性，所以 85 个 methods 里的
     * `this.xxxOpen = ...` / `this.project = ...` 等读写一行都不用改。
     * 各弹窗内部的输入框、搜索、页签滚动、上传进度、安装密钥仍是组件自己的局部状态。 */
    return {};
  },

  computed: {
    /* 编译期常量（非状态）：来自仓库根 package.json，见 src/version.js */
    appVersion() { return APP_VERSION; },
    appTitle() { return APP_NAME + ' ' + APP_VERSION; },
    /* 全部状态来自两个 store，data() 是空的。
     * editor / ui 的可写态用 mapWritableState → 58 处 this.project、撤销栈整份替换、
     * `this.entVersion++`、以及 `this.xxxOpen = ...` 这些直接赋值全部照旧可用。
     * 只读态分两类：tooltip 三件套（ui）与 editor 的共享 getters
     * （cur / bgStyle / selItem / kindName / canUndo / canRedo）；connClass / connText
     * 改从 ha store 直读。原先散在根组件和三个属性栏组件里各算一份，现在收敛到 store。 */
    ...mapWritableState(useEditorStore, [
      'project', 'floorIdx', 'selection', 'tool', 'mode', 'showLabels', 'showCards',
      'entVersion', 'histVer', 'savedState', 'bgTick',
      'houseW', 'houseD', 'zoomPct', 'bgW', 'bgInfo',
    ]),
    ...mapWritableState(useUiStore, [
      'furnOpen', 'devOpen', 'connOpen', 'importOpen', 'dispOpen',
      'bgOpen', 'backdropOpen', 'resetOpen',
    ]),
    ...mapState(useUiStore, ['tooltipMsg', 'tooltipShow', 'tooltipStyle']),
    ...mapState(useEditorStore, [
      'cur', 'bgStyle', 'selItem', 'kindName', 'canUndo', 'canRedo',
      /* 标签抬升高度：store getter（共享纯函数实现，审计 2.13/3.15 —— EditApp
       * 与 SelectionInspector 共用同一份，本组件不再自带 computed） */
      'labelOffsetDefault', 'labelOffsetVal',
    ]),
    ...mapState(useHaStore, ['connClass', 'connText']),
    /* SelectionInspector 的动作打包（inspectorActs.js 名单契约，审计 2.18）：
     * 按名单把同名编排方法收进一个对象经 :act props 下发。数值家族落点在
     * composables/useNumEditing.js 方法组，其余在根组件 methods；Vue 的 options
     * methods 已自动绑定实例，直接引用即可。名单里的方法缺一会在运行时报
     * this[n] is not a function —— 新增/改名时名单与方法必须同步。 */
    inspectorAct() {
      const o = {};
      INSPECTOR_ACTS.forEach((n) => { o[n] = this[n]; });
      return o;
    },
    /* 有任何弹窗开着（连接 / 导入 / 展示项 / 重置确认）→ 顶栏的单键快捷键一律不抢：
     * 否则在连接弹窗里敲字母（虽然输入框已过滤，但焦点可能在按钮/空白处）会顺手切视图。 */
    dialogOpen() { return !!(this.connOpen || this.importOpen || this.dispOpen || this.resetOpen); },

    /* 设备页签 → DevPanel.vue；家具页签 → FurnPanel.vue；连接弹窗文案 → ConnModal.vue；
     * 背景分组 → BackdropPicker.vue。编辑页不渲染 HUD，故无 HUD 派生 computed。 */
  },

  methods: {
    /* store Actions → 同名方法（mapActions 转发）。组件内部大量调用 this.toast() 等，
     * 保持同名即可零改动；实现已下沉到 store。
     * engine 侧的 window.App.toast / setSelection / updateZoomLabel 不再指向本组件，
     * 而是由 bridge.js 在入口安装 Pinia 后直接调 store Action —— 引擎不依赖组件
     * 方法名，别名漏映射也不会再让 init() 崩。
     * 其余编排动作（commit / dirty / undo / setTool / setMode / applyBg …）仍在下面，
     * 它们要压撤销栈、$nextTick 后 resize 3D 容器、重放插件场景，不适合放进纯状态 store。 */
    ...mapActions(useUiStore, ['toast', 'openFlyout', 'closeFlyout', 'setToolFlyouts']),
    ...mapActions(useCatalogStore, ['loadCatalog', 'refreshPlugins']),
    /* HA 配置只在「连接与服务」弹窗打开时读取（ConnModal.reloadConfig）；
     * 启动序列不请求 /api/config，HA 连接直接开 WS（未配置 → 服务端 4400 → 演示模式） */
    ...mapActions(useEditorStore, [
      'bumpEntities', 'bumpHistory', 'bumpBg',
      'setHouseSize', 'markSaved', 'markUnsaved', 'setZoomFromPpm',
    ]),
    /* 卡片开关的纯翻转在 store（Action toggleCards），这里映射成**别名**，
     * 好让下面的同名方法叠加 toast —— 对象写法只生成别名，不会再生成原名。 */
    ...mapActions(useEditorStore, { toggleCardsState: 'toggleCards' }),

    /* ------- 职责方法组（composables/ 拆分，见文件头 import 处说明） ------- */
    ...numEditingMethods,   // setProp / 数值底座 / 设备·门窗·家具数值 / 标签抬升
    ...refImageMethods,     // 参考底图（applyBgImage / syncBg / toggleBg / onBgScale / clearBg / writeBg）
    ...backgroundMethods,   // 背景插件（applyBg / bindBgSettings / setBgOpt / setBgField / setBackground）
    ...roomMethods,         // 房间属性与排序（setRoomProp / reorderRooms / _applyRoomOrder / selectRoom）
    ...deviceOrderMethods,  // 设备排序与卡片隐藏（reorderDevices / toggleDeviceCardHide / … / locateDevice）
    ...editorKeysMethods,   // 全局键盘绑定（bindKeys）
    ...floorMethods,        // 楼层（setFloor / selectFloor / addFloor / copyFloor / delFloor / 属性 / 重置）
    ...useSceneMode.methods, // 场景模式装配共享底座（toggleLabelsCore / applySceneCore / pickHi / refresh3dQuiet）

    /* 设备页签的横向滚动 / 两端渐隐 / 列表复位 → components/pages/editor/DevPanel.vue */

    /* ------- 初始化 ------- */
    async init() {
      /* HA 不再在启动时读 /api/config：连接由 services/ha.js 直连代理 WS，
       * 未配置走服务端 4400 → 演示模式；配置表单在「连接与服务」弹窗打开时才拉取。 */

      try {
        /* 目录加载走 catalog store 的 Action：model 层写引擎要读的非响应式数据，
         * store 同步写响应式投影，家具列表/页签自动更新（不再需要 bumpEntities）。 */
        await this.loadCatalog();   // 目录先于项目加载（示例户型需要按形态 id 引用家具）
        await this.loadProject();
        await PluginEngine.loadAll();   // 加载 assets/plugins 有状态模型插件
        this.refreshPlugins();   // 插件家具造型 → 家具库条目（loadCatalog 时插件还没注册）
        this.bumpEntities();   // 同理: 插件注册完成后再触发一次（背景分组/设备造型等）
        await this.$nextTick();

        Editor.init(document.getElementById('c2d'));
        Editor.onChange = (light, label) => { this.dirty(label || (light ? 'drag' : 'edit')); };
        Editor.onViewChange = () => this.viewDirty();   // 平移/缩放也进撤销栈（见 recode.js pushView）
        this.setFloor();
        if (typeof Recode !== 'undefined') Recode.setBaseView(Editor.viewState());   // 初始快照也记视图
        View3D.init('c3dWrap');
        View3D.frame({ dir: [9, 10, 11], dist: Math.hypot(9, 10, 11), target: [0, 0, 0] });   // 编辑器取景由 app 自己控制（= 原默认视角）
        this.applyBg();   // 恢复项目里保存的背景插件地面（空则默认纯色 + 网格）

        // 关闭页面前确保已保存
        /* 句柄存实例（审计 4-应用.4）：beforeUnmount 成对移除 */
        this._onBeforeUnload = () => {
          if (this.savedState !== '已保存' && this.project) {
            /* 与手动保存 / autoSave 走同一份 serializeProject 快照：原始 this.project
             * 可能带着过期的运行期字段，整份提交会干扰服务端。
             * 用 keepalive fetch 而不是 sendBeacon：sendBeacon 不走全局 fetch 守卫、
             * App 端注入不了 X-HA3D-Token，登录态靠 header 的场景下最后一次保存会被
             * 鉴权 401 静默丢弃；keepalive fetch 照常过守卫且浏览器保证离页后发完。 */
            fetch('/api/project', {
              method: 'POST',
              keepalive: true,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(serializeProject(this.project)),
            }).catch(() => { /* 离页保存失败已无 UI 可提示 */ });
          }
        };
        window.addEventListener('beforeunload', this._onBeforeUnload);

        View3D.startLoop();
        /* 光照控制器：房间 mesh 已建、插件实例已生成。编辑页不走 useStageBoot，
         * 必须自己接一次；它自己注册 HA change 与切层重建事件。 */
        initLighting(this.project, () => this.floorIdx);
        this.applySceneMode();   // 标签显隐 ⇔ 点击语义（?view=3d 由 setMode 再装一次，幂等）
        this.bindKeys();

        // 支持 ?view=3d 直达 3D 视图
        const q = new URLSearchParams(location.search);
        if (q.get('view') === '3d') this.setMode('3d');
        // 点画布关闭悬浮面板 → Editor2D.vue 的 mounted 自己绑事件，
        // 直接调 ui store 的 closeFlyout() Action，不再跨组件查 DOM。
      } catch (e) {
        console.error('[ha3d] 页面初始化异常:', e);
        this.toast('初始化异常：' + (e.message || e));
      } finally {
        /* 无论引擎段成功与否，HA 一定尝试连接、启动遮罩一定移除。
         * status/实体状态写入 ha store 已由 installHaBridge() 统一注册，
         * 这里只保留本页的 change → 渲染编排与发起连接。 */
        this.startHA();
        bootDone();   // 初始化完成，移除启动遮罩
      }
    },

    /* 幂等：init 走到哪一步，HA 连接都只发起一次。 */
    startHA() {
      if (this._haStarted) return;
      this._haStarted = true;
      HA.on('change', () => this.onHAChange());
      HA.connect();
    },

    async loadProject() {
      this.project = await fetchProject() || buildDefaultProject();
      Recode.init(this.project, this.floorIdx);   // 撤销栈以载入的项目为初始态
      this.applyTitle();
      this.updateHouseSize();
    },

    /* 本层户型长宽（米）：2D 画布右上角徽标（跟随当前楼层，切层/改墙即刷新）。
     * studio 背景占位盒参考的是「各层最大尺寸」（保存时落盘 houseW/houseD），不再看这个徽标 */
    updateHouseSize() {
      const fp = (typeof floorFootprint === 'function') ? floorFootprint(this.cur) : null;
      this.setHouseSize(fp ? Math.round(fp.w * 10) / 10 : 0, fp ? Math.round(fp.d * 10) / 10 : 0);
    },

    /* 浏览器标签页标题: 项目名称 · 编辑（名称改动/撤销重做后由 watch 同步） */
    applyTitle() { document.title = (this.project && this.project.name ? this.project.name : 'HA 3D Home') + ' · 编辑'; },

    dirty(label) {
      // 快照式撤销: 每次数据改动压栈（restoring 期间的 dirty 来自恢复动作本身，不进栈）
      if (typeof Recode !== 'undefined') Recode.push(this.project, this.floorIdx, label || 'edit', Editor.viewState());
      this.bumpHistory();
      this.updateHouseSize();   // 墙体增删/拖动都会走到这里，长宽徽标实时跟着变
      this._save();
    },
    /* 视图改动（平移/缩放）单独压栈: 数据没变 → 不动保存状态、不用重算长宽。
     * 有了这条，「先平移视图、再改东西」后撤销时才不会把画面拽回平移前的取景 */
    viewDirty() {
      if (typeof Recode === 'undefined' || !this.project) return;
      if (Recode.pushView(this.project, this.floorIdx, Editor.viewState())) this.bumpHistory();   // 让撤销按钮可用态刷新
    },
    _save() {
      this.markUnsaved();
      // 自动保存: 编辑停止 1 秒后同步到服务器
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.autoSave(), 1000);
    },

    /* ------- 撤销 / 重做（快照式，见 web/src/engine/recode.js） -------
     * canUndo / canRedo 已变成 editor store 的共享 getters（顶栏直接 mapState 读），
     * 不必再把方法结果当 props 传下去。 */
    undo() {
      const s = Recode.undo();
      if (!s) return;
      this._applySnapshot(s);
      this.toast(s.undone === 'view' ? '已撤销视图（平移/缩放）' : '已撤销');
    },
    redo() {
      const s = Recode.redo();
      if (!s) return;
      this._applySnapshot(s);
      this.toast(s.undone === 'view' ? '已重做视图（平移/缩放）' : '已重做');
    },
    /* 恢复快照 + 全套联动刷新（restoring 抑制期间的 dirty 进栈） */
    _applySnapshot(s) {
      Recode.restoring = true;
      try {
        /* 3D 里若快照把楼层换掉了，视角必须重新取景（旧 orbit 中心指向的是另一层）；
         * 同层撤销（挪设备、改参数）则保留用户视角，画面不跳。 */
        const sameFloor = View3D.currentFloorIdx === Math.min(Math.max(0, s.floorIdx), s.project.floors.length - 1);
        this.project = s.project;
        this.floorIdx = Math.min(Math.max(0, s.floorIdx), this.project.floors.length - 1);
        Editor.select(null);   // 选中对象可能已不在恢复后的数据里
        /* 楼层重指向但不重新 fit: 视图直接用快照里存的，撤销/重做时画面不跳 */
        this.setFloor(false);
        Editor.setView(s.view);   // 同步缩放标签（setView 内部回调 updateZoomLabel）
        this.applyBg();        // 背景插件地面（settings.background 属于快照）
        this.rebuild3D({ keepView: sameFloor });   // 3D 模式下重建（2D 模式 no-op，进 3D 时 setMode 会再建）
        this.updateHouseSize(); // 快照里的墙体可能不同，长宽徽标同步
        this.bumpHistory();
        this._save();          // 恢复的结果也要落盘（刷新页面不回跳）
      } finally {
        Recode.restoring = false;
      }
    },
    async autoSave() {
      if (!this.project) return;
      const body = serializeProject(this.project);   // 与手动保存同一份干净快照
      if (!body) return;
      try {
        await fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        this.markSaved();
      } catch (e) { /* 下次编辑会重试 */ }
    },

    /* ------- 楼层 -------
     * setFloor / selectFloor / addFloor / copyFloor / delFloor / setFloorName /
     * setWallOpacity / setFloorHeight / confirmResetFloor 已拆到
     * composables/useFloors.js（文件头 import 处摊进 methods）。
     * openResetFloor（浮层开关）与 setProjectName（项目级）留在本组件。 */
    setProjectName(v) { this.project.name = v.trim() || '我的家'; this.dirty(); },

    /* 本层户型长宽徽标的刷新（updateHouseSize）留在根组件：撤销恢复路径也调它 */

    /* ------- 数据卡（按楼层独立，动态数量，实体搜索输入） ------- */
    setCard(i, v) {
      const cards = this.cur.display.dataCards = this.cur.display.dataCards || [];
      cards[i] = String(v || '').trim();
      this.dirty();
    },
    addCard() {
      const cards = this.cur.display.dataCards = this.cur.display.dataCards || [];
      cards.push('');
      this.dirty();
    },
    removeCard(i) {
      const cards = this.cur.display.dataCards || [];
      cards.splice(i, 1);
      this.dirty();
    },
    setWeather(v) { this.project.settings.weatherEntity = String(v || '').trim(); this.dirty(); },

    /* ------- 重置当前楼层 -------
     * 确认弹窗交互在 ResetModal；confirmResetFloor（真正清空 + 压栈）已拆到
     * composables/useFloors.js（文件头 import 处摊进 methods）。 */
    openResetFloor() { this.openFlyout('reset'); },

    /* ------- 展示大屏展示项配置 -------
     * 场景勾选 → components/pages/editor/DispCfgModal.vue；根组件只管开关。 */
    openDispCfg() { this.openFlyout('disp'); },
    /* ------- 左侧导航（统一状态机） -------
     * tool 是唯一激活源: select / pan / wall / door / window / furniture / device / measure / bg / backdrop
     * 家具、设备、贴图、背景是"浮层工具"，再次点击同一按钮 → 收起并回到选择；
     * measure 没有浮层，再点一次 = 退出并清空标线；
     * bg（贴图）态画布行为等同选择（Editor.isSelectTool 统一处理）；
     * 视图联动: 除背景（backdrop）外的所有工具强制 2D 编辑；背景反过来强制 3D（选完即所见）
     * keepView: 只收浮层/回到选择，不切换 2D/3D（浮层的 × 与 Esc 用） */
    setTool(t, keepView) {
      const togglable = ['furniture', 'device', 'measure', 'bg', 'backdrop'];
      const next = (t === this.tool && togglable.includes(t)) ? 'select' : t;
      this.tool = next;
      Editor.tool = next;
      Editor.wallStart = null;
      /* 切工具丢弃未落定的房间点（与 wallStart 同口径）：房间只有 Esc/双击/右键才落盘，
       * 半途切走就等于放弃这一笔，不能让残点留在画布上 */
      Editor.roomPts = null;
      /* 标线同理：它是「当前这一次量距」的临时标注，切到任何工具（含再点一次测量）
       * 都整批清空；清完补一次绘制，避免鼠标不在画布上时残影留在屏幕里 */
      if (Editor.measures.length || Editor.measureFrom) { Editor.clearMeasures(); Editor.render(); }
      /* 顶点拖拽同理：切工具的瞬间松手事件可能还没到（例如 Esc 直接摸掉工具），
       * 不清掉会在下一次 mousedown 前留下一个指向旧房间的拖拽态 */
      Editor.dragVert = null;
      Editor.hoverVert = -1;
      if (next !== 'furniture' && next !== 'device') Editor.ghost = null;
      this.setToolFlyouts(next);   // ui store Action：四个浮层互斥开关一次改完
      /* 进入测量立刻重绘：鼠标还没动时也要显示「单击确定起点」提示与十字光标 */
      if (next === 'measure') Editor.render();
      // 视图联动（两条互补规则）:
      //   · 背景（backdrop）→ 3D 展示：背景只在 3D 里看得见，选完即见即所得
      //   · 其余所有工具（选择/平移/墙体/门/窗/家具/设备/贴图）→ 2D 编辑
      // 例外: 再次点同一个浮层工具只是「收起浮层」（next 回到 select），或显式 keepView（× / Esc），
      //       此时不动视图，否则在 3D 里点背景收浮层会被拽回 2D
      const closingFlyout = next === 'select' && t !== 'select';
      if (!keepView && !closingFlyout) {
        if (next === 'backdrop') {
          if (this.mode === '2d') this.setMode('3d');
        } else if (this.mode === '3d') {
          this.setMode('2d');
        }
      }
      // 背景不是选择类工具（isSelectTool 不含 backdrop），选中对象时点背景面板不会自己变，
      // 这里显式清掉选中态 → 右侧统一切到「背景设置」面板（由 tool === 'backdrop' 驱动）
      if (next === 'backdrop' && this.selection) {
        Editor.select(null);
        Editor.render();
      }
    },
    /* 选中高亮 ghostFurn 由 FurnPanel 自持；这里只负责编辑器状态与提示 */
    /* 点家具库条目：两条数据路径共用 tool='furniture'（画布提示/矩形预览一致），
     * 只在落地那一步分流 ——
     *   · 目录静态家具（mid → GLB）  ghost.kind='furniture'  → floors.furniture
     *   · 插件动态家具（f.plugin）    ghost.kind='furn-plugin' → floors.devices {type:'furniture'}
     * 家具库卡片左上角的「插件」标记就是靠 f.plugin 区分的。 */
    pickFurniture(f) {
      Editor.ghost = { kind: f.plugin ? 'furn-plugin' : 'furniture', data: Object.assign({}, f) };
      /* 工具双真相同步点（审计 3.14）：store.tool（工具栏高亮）与 Editor.tool（引擎
       * 画布行为）必须一次写完 —— 此前只写引擎侧，左侧「家具」按钮会漏亮。
       * 不走 setTool()：那里的「再次点击同一浮层工具 → 收起」toggle 语义会把
       * 已激活工具翻回 select，与浮层内选型的意图相反。 */
      this.tool = 'furniture';
      Editor.tool = 'furniture';
      this.toast('在户型图上点击放置: ' + f.name);
    },

    /* ------- 背景（背景插件） -------
     * applyBg / bindBgSettings / setBgOpt / setBgField / setBackground 已拆到
     * composables/useBackground.js（文件头 import 处摊进 methods）。
     * 注入策略与 useStageBoot 的差异（审计 2.10 已知项）：编辑页走 toRaw 直接引用，
     * 展示页走深拷贝隔离 —— 本轮只搬运不改行为。 */
    pickEntity(e) {
      Editor.ghost = { kind: 'device', data: { entityId: e.eid, name: e.name, type: e.type } };
      /* 工具双真相同步点（审计 3.14，同 pickFurniture 口径）：store 与引擎一次写完 */
      this.tool = 'device';
      Editor.tool = 'device';
      this.closeFlyout('dev');
      this.toast('在户型图上点击放置: ' + e.name);
    },
    /* 房间属性与排序（setRoomProp / reorderRooms / _applyRoomOrder / selectRoom）
     * 已拆到 composables/useRooms.js（文件头 import 处摊进 methods）。 */
    delSelected() { Editor.deleteSelection(); },

    /* ------- 房间排序（RoomsPanel）与设备排序（DevOrderPanel） -------
     * reorderRooms / _applyRoomOrder / selectRoom → composables/useRooms.js；
     * reorderDevices / _applyDeviceOrder / toggleDeviceCardHide / showAllDeviceCards /
     * selectDevice / locateDevice → composables/useDeviceOrder.js
     * （两组均在文件头 import 处摊进 methods）。
     * 设备图标 typeIcon → components/pages/editor/DevPanel.vue */

    /* ------- 视图 ------- */
    setMode(m) {
      this.mode = m;
      this.$nextTick(() => {
        if (m === '3d') {
          // 关键: 容器从 v-show 隐藏变为可见后先 resize 再 build
          View3D.resize();
          View3D.rebuild(this.project, this.floorIdx);
          /* rebuild 会重建标签 DOM：一次拨完标签显隐 + onPick + 选中高亮 */
          this.applySceneMode();
        } else {
          Editor.resize();
          this.applySceneMode();                      // 2D 下不给 3D 标签、也不接管 canvas 点击
        }
      });
    },
    toggleLabels() {
      /* 标签开关骨架（翻转/持久化/重拨顺序单一出处，审计 2.17）：
       * 编辑页偏好键 showLabels（展示页独立用 panelShowLabels） */
      this.toggleLabelsCore(PREF_KEYS.showLabels,
        () => this.applySceneMode(),
        () => this.toast(this.showLabels
          ? '已显示设备标签：点标签执行，点设备查看卡片'
          : '已隐藏设备标签：点设备执行动作'));
    },
    /* 卡片预览浮层开关：翻转走 store 的 toggleCards（别名 toggleCardsState），
     * toast 留在这里 —— 与 toggleLabels 同款，纯 UI 反馈不进 store。
     * 只管浮层显隐，不再改变 3D 点击语义（那个统一由标签显隐决定）。 */
    toggleCards() {
      this.toggleCardsState();
      if (!this.showCards) applyPickHi(View3D, null, false);   // 收起浮层顺手收掉选中环
      this.toast(this.showCards ? '已显示卡片预览' : '已隐藏卡片预览');
    },

    /* ------- 3D 场景模式（与 PanelApp 共用 composables/useSceneMode.js 底座） -------
     * 3D 且显示标签：点设备模型只「选中 / 切换卡片」（Editor.select 同步右侧属性栏与
     *   卡片预览），执行动作只走设备标签（标签是 DOM，不冒泡到 canvas）；
     * 隐藏标签 / 2D 模式：没有可点的标签，点设备模型直接 toggleDevice 执行动作。
     * 标签显隐与 onPick 由 syncSceneMode 一次拨完，避免两个开关各写一半。 */
    applySceneMode() {
      const labels = this.mode === '3d' && this.showLabels;
      this.applySceneCore(labels, labels ? this.selection : null);
    },
    onPick3D(hit) {
      const s = selOfPick(hit);
      if (!s) { Editor.select(null); return; }   // 点空白 = 清选中（属性面板一起收起）
      Editor.select(s.kind, s.id);               // 走 Editor.select：2D 选中态与 store 同步更新
    },
    /* 旋转锚点重置回房屋中心（长按 3D 画面可自定义锚点；编辑页不持久化锚点） */
    resetAnchor() {
      View3D.resetAnchor();
      this.toast('锚点已重置回房屋中心');
    },
    openDisplay() { window.open('/index.html', '_blank'); },
    /* zoomStep / zoomFit / zoomCenter → components/pages/editor/CanvasStage.vue：
     * 缩放按钮就在画布覆盖层里，换算走 store Action setZoomFromPpm()，
     * 压视图撤销栈的 viewDirty() 由组件 emit('view-dirty') 回来。 */

    /* ------- 属性编辑 -------
     * setProp / 数值底座 / 设备·门窗·家具数值 / 标签抬升已拆到
     * composables/useNumEditing.js（文件头 import 处摊进 methods）。 */

    /* ------- 同类模型/造型切换 ------- */
    /* 「2D 重绘 + 存档 + 3D 重建」统一出口（属性/造型/数值修改共 10 余处手抄收敛于此）。
     * opts.redraw2d           是否重绘 2D（默认 true；纯 3D 属性可关）
     * opts.rebuild            是否重建 3D（默认 true；rebuild3D 内部只在 3D 模式生效）
     * opts.updateAll          附带推送插件状态（扩展实体绑定等字段变化）
     * opts.syncLabels         附带重算标签文案（绑定字段变化） */
    commit(opts) {
      const o = opts || {};
      if (o.redraw2d !== false) Editor.changed();
      this.dirty();
      if (o.rebuild !== false) this.rebuild3D();
      if (o.updateAll && window.PluginEngine) PluginEngine.updateAll();
      if (o.syncLabels && this.mode === '3d') View3D.syncLabels(this.project);
    },
    rebuild3D(opts) {
      if (this.mode !== '3d') return;
      /* 编辑过程中的重建默认保留用户视角：右键平移过 orbit 中心后，改数值 / 撤销
       * 不会再被拉回户型中心（View3D.build 的 keepView）。进 3D、切楼层这些
       * 「换场景」动作仍走 View3D.rebuild 的默认回中。 */
      View3D.rebuild(this.project, this.floorIdx, Object.assign({ keepView: true }, opts));
    },
    /* 家具: 切换为同类别的另一个模型（保留位置/旋转）。实例只存 mid，
     * 尺寸/名称/模型随目录形态解析，所以这里把旧数据抄在实例上的字段一并清掉 */
    swapFurnModel(f) {
      const it = this.selItem;
      if (!it || !f) return;
      it.mid = f.id;   // 形态标识（type/name/尺寸/颜色/模型等由目录解析）
      ['type', 'name', 'w', 'd', 'h', 'color', 'model'].forEach((k) => { if (k in it) delete it[k]; });
      this.commit();
      this.toast('已切换为: ' + f.name);
    },
    /* 点击控制开关（设备级覆盖插件默认） */
    setDevClick(v) {
      const it = this.selItem;
      if (!it) return;
      it.click = !!v;
      this.commit({ redraw2d: false });   // 标签可点击状态随重建刷新
      this.toast(it.click ? '点击控制已启用' : '点击控制已关闭');
    },
    /* 「点击动作」下拉（实例级覆盖，优先级最高）: 选择后整体替换插件 click / 内置默认；
     * 选回「默认」即清空回到插件/内置链路。选中动作时自动勾选启用（否则点了也不生效） */
    setDevClickSvc(key) {
      const it = this.selItem;
      if (!it) return;
      if (key) {
        it.clickSvc = key;
        if (it.click !== false) it.click = true;
        this.toast('点击动作已覆盖: ' + key);
      } else {
        delete it.clickSvc;
        this.toast('点击动作已恢复默认（插件 / 内置）');
      }
      this.commit({ redraw2d: false });
    },
    /* 切换样式: 只存 obj.style（形如 'plugin:style'）；设备首次切换带出该造型的默认离地高度。
     * 只改 style / z，不动实例上的 fields 绑定值 —— 同一插件多个样式共用绑定（与背景同口径）。 */
    setSelStyle(s) {
      const it = this.selItem;
      if (!it || !s || it.style === s.id) return;
      it.style = s.id;
      if (this.selection.kind === 'device' && it.z == null) it.z = s.z;
      this.commit();   // 2D 平面简笔立即重绘（changed 顺带触发自动保存）
      this.toast('样式已切换: ' + s.name);
    },
    /* 样式条目参数（如门的手向/开向）: 值按实例存 obj.styleOpts，整对象替换保证 Vue2 响应；
     * 120ms 防抖后 commit（2D 符号 + 3D 模型一起重画，滑杆拖动不会每次 input 都重建） */
    setSelOpt(key, val) {
      const it = this.selItem;
      if (!it) return;
      const cur = Object.assign({}, it.styleOpts);
      cur[key] = val;
      it.styleOpts = cur;
      clearTimeout(this._openOptTimer);
      this._openOptTimer = setTimeout(() => this.commit(), 120);
    },
    clearDevField(key) {
      const it = this.selItem;
      if (!it || !it[key]) return;
      this.setProp(key, '', 'str');
      this.toast('已解绑');
    },
    /* ------- 参考底图（2D 户型图） -------
     * applyBgImage / writeBg / syncBg / toggleBg / onBgScale / clearBg 已拆到
     * composables/useRefImage.js（文件头 import 处摊进 methods）。 */

    /* ------- 连接 -------
     * 表单字段、保存 / 测试请求、结果文案 → components/pages/editor/ConnModal.vue。
     * 打开弹窗时由组件自己从 HA 读 url / token，根组件只管开关。 */
    openConn() { this.openFlyout('conn'); },

    /* ------- 导入插件 -------
     * 拖拽 / 点选 zip → POST /api/plugins/import → 成功后刷新页面，
     * 以及安装密钥的读取 / 生成 / 复制，整条链路 → components/pages/editor/ImportModal.vue。
     * 根组件只保留顶栏按钮的 open 开关；打开时的字段重置由组件 watch open 完成。 */
    openImport() { this.openFlyout('import'); },

    /* ------- HA 事件 ------- */
    onHAChange() {
      this.bumpEntities();
      /* 静默重绘底座（useSceneMode.refresh3dQuiet）：引擎段若初始化失败，finally 里
       * 仍会发起 HA 连接（含演示模式的同步首帧推送），不能让渲染调用抛错打断回调。 */
      this.refresh3dQuiet(() => {
        if (this.mode === '3d') View3D.refresh();
        else Editor.render();
      });
    },

    /* ------- 提示 ------- */
    /* toast() 已下沉到 stores/ui.js，由 methods 顶部的 mapActions 生成同名方法；
     * engine/view3d.js 的 window.App.toast() 由 bridge.js 指向同一个 Action
     * （展示页入口会覆盖成 PanelApp.toastMsg，那里才有气泡 DOM）。 */

    /* bindKeys 已拆到 composables/useEditorKeys.js（文件头 import 处摊进 methods）。
     * 键位分层与 Esc / 弹窗 / 输入框守卫的优先级口径见该文件头注。 */

    /* 启动遮罩的移除 / 12s 兜底统一由 components/common/boot.js 提供 */
  },

  watch: {
    /* 选中项 → 3D 场景高亮：房间地面提亮 + 描边，设备/门窗脚下圆环。
     * 与大屏同一个入口（useSceneMode.pickHi），非 3D 模式一律清空（场景里不该留高亮）。 */
    selection(v) { this.pickHi(v, this.mode === '3d'); },
    /* 项目名称变化（手动改名 / 撤销重做恢复）→ 标签页标题同步 */
    'project.name'() { if (this.project) this.applyTitle(); },
    /* 设备面板的 4 个 watch（devFilter / devTabs / devOpen / devSearch）连同页签
     * 滚动状态与 computed 一起搬到 components/pages/editor/DevPanel.vue。 */
  },

  mounted() {
    // 12s 兜底：脚本异常导致 init() 未走到 bootDone() 时强制移除，避免卡在加载界面
    armBootFallback();
    this.init();
  },

  /* 卸载清理（审计 4-应用.4：此前无 beforeUnmount —— keydown/beforeunload 监听
   * 与 5 个定时器只有注册没有清理；PanelApp 有完整清理，单侧遗漏）。
   * MPA 页面级常驻时不触发，HMR / 组件复用 / 未来 SPA 化时避免叠加泄漏。 */
  beforeUnmount() {
    this.unbindKeys();
    if (this._onBeforeUnload) {
      window.removeEventListener('beforeunload', this._onBeforeUnload);
      this._onBeforeUnload = null;
    }
    /* 属性编辑 / 背景参数 / 层高 / 自动保存 / 造型参数防抖定时器 */
    ['_labelOffTimer', '_bgOptTimer', '_fhTimer', '_saveTimer', '_openOptTimer'].forEach((k) => {
      if (this[k]) { clearTimeout(this[k]); this[k] = null; }
    });
    /* 引擎级卸载出口（审计 3.7）：渲染 RAF / resize / HA change 等模块级监听统一收口 */
    disposeEngine();
  },
};
</script>

<style>
/* 启动遮罩的样式随 components/common/BootOverlay.vue 一起打包，本页只留专用样式 */
/* 编辑页版本号：固定在页面左下角（左侧工具栏底部），2D/3D 模式都常驻。
   只用定位修饰 .tb-ver-corner，基础胶囊样式仍在 style.css，大屏页标题旁的版本号不受影响。 */
.tb-ver-corner { position: fixed; left: 10px; bottom: 10px; z-index: 25; }
</style>
