<template>
  <!-- 启动遮罩（两页共用 components/common/BootOverlay.vue），由 boot.js 的 bootDone() 移除 -->
  <boot-overlay />

  <!-- 顶栏：批次 2 拆到 components/pages/editor/TopBar.vue；全局状态化后零 props，
       状态由组件自己从 store 直读，只剩动作 emits 回根组件编排。 -->
  <top-bar
    @open-display="openDisplay" @select-floor="selectFloor" @add-floor="addFloor"
    @undo="undo" @redo="redo" @set-mode="setMode"
    @toggle-labels="toggleLabels" @reset-anchor="resetAnchor"
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

    <!-- 右侧属性栏（2D/3D 预览均保留）：批次 3 三大分支拆到 components/pages/editor/。
         分支条件与 DOM #sidePanel 保持不变；组件通过 mapState 直读全局 store（Pinia），
         动作一律 emit 回根组件，由根组件完成 commit / 撤销栈 / 引擎刷新。 -->
    <aside id="sidePanel" v-if="cur">
      <!-- 分支一：左侧「背景」工具激活时的专用面板 -->
      <backdrop-panel v-if="tool === 'backdrop'"
        @set-wall-opacity="setWallOpacity" @set-bg-opt="setBgOpt" @set-bg-field="setBgField" />

      <!-- 分支二：未选中 / 选中墙体时的楼层与项目设置 -->
      <floor-settings v-else-if="!selection || selection.kind === 'wall'"
        @set-project-name="setProjectName" @set-floor-height="setFloorHeight"
        @add-floor="addFloor" @del-floor="delFloor" @set-weather="setWeather"
        @set-card="setCard" @add-card="addCard" @remove-card="removeCard"
        @open-disp-cfg="openDispCfg" />

      <!-- 分支三：选中对象的属性编辑（样式 / 参数 / 家具 / 3D 位置 / 绑定 / 点击控制） -->
      <selection-inspector v-else-if="selItem"
        @set-sel-style="setSelStyle" @set-sel-opt="setSelOpt" @swap-furn-model="swapFurnModel"
        @set-furn-num="setFurnNum" @wheel-furn="wheelFurn"
        @set-dev-num="setDevNum" @wheel-num="wheelNum"
        @set-dev-label-offset="setDevLabelOffset" @commit-dev-label-offset="commitDevLabelOffset"
        @wheel-dev-label-offset="wheelDevLabelOffset"
        @set-prop="setProp" @set-dev-click="setDevClick" @set-dev-click-svc="setDevClickSvc"
        @set-open-num="setOpenNum" @wheel-open="wheelOpen" @set-open-z="setOpenZ"
        @wheel-open-z="wheelOpenZ" @clear-dev-field="clearDevField"
        @del-selected="delSelected" @dirty="dirty()" />
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
 * App.vue — 编辑页根组件（由 public/js/app.js 的伪 Vue 组件迁移为 SFC）
 *
 * 迁移口径与 DisplayApp.vue 一致：
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
 * 批次 3（右侧属性栏三大分支）：BackdropPanel / FloorSettings / SelectionInspector
 * 拆到 components/pages/editor/，它们用 mapState 直读全局 store（含收敛后的共享 getters），
 * 独有派生数据在组件内算，动作 emit 回根组件；根组件只留分支条件与 #sidePanel 容器。
 *
 * 批次 4（画布区 / 引擎容器）：CanvasStage.vue 包住 #canvasWrap 与覆盖层，内部
 * Editor2D.vue（canvas#c2d）/ Viewer3D.vue（div#c3dWrap）是两个引擎容器。
 * 关键约束：Editor.init() / View3D.init() 在根组件 init() 里持有 DOM，容器必须
 * 常驻 —— 一律 v-show，绝不能改 v-if。三个组件零 props，状态与缩放动作走 Pinia，
 * 只有压视图撤销栈的 viewDirty() 用 emit 回根组件。
 *
 * 全局状态层（Pinia）：业务/编辑态在 stores/editor.js，浮层开关与 tooltip 在
 * stores/ui.js，二者都带 getters 与纯状态 Actions。根组件 data() 已清空，全靠
 * computed 的 mapWritableState / mapState 与 methods 的 mapActions 展开成同名属性，
 * 因此 58 处 this.project 与 85 个 methods 保持原样；engine 的 window.App 桥接由 bridge.js 承担。
 * 引擎对象仍走 window 桥接，不进 store（Proxy 会破坏 THREE.Object3D）。
 */
import { getCurrentInstance } from 'vue';
import { mapState, mapWritableState, mapActions } from 'pinia';
import { APP_NAME, APP_VERSION } from './version';
import { useHud } from './composables/useHud';
import { useEditorStore } from './stores/editor';
import { useUiStore } from './stores/ui';
import { useCatalogStore } from './stores/catalog';
import BootOverlay from './components/common/BootOverlay.vue';
import { bootDone, armBootFallback } from './components/common/boot.js';
import EntityInput from './components/common/EntityInput.vue';
import OptionRow from './components/common/OptionRow.vue';
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
import CanvasStage from './components/pages/editor/CanvasStage.vue';

export default {
  name: 'App',
  components: {
    BootOverlay, TopBar, ToolRail, CanvasStage,
    BackdropPanel, FloorSettings, SelectionInspector,
    EntityInput, OptionRow,
    BgPanel, ResetModal, FurnPanel, BackdropPicker,
    DevPanel, ConnModal, ImportModal, DispCfgModal,
  },

  /* HUD 派生数据改由 composables/useHud.js 提供（computed ref 自动 unwrap，
   * 模板仍写 {{ hudTemp }}）。两个取值函数是延迟调用的，setup 执行时 data 还没
   * 初始化也没关系；求值时才读 vm.project / vm.cur，响应式依赖照常建立。 */
  setup() {
    const vm = getCurrentInstance().proxy;
    return useHud(
      () => vm.project && vm.project.settings,
      () => vm.cur && vm.cur.display
    );
  },

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
     * 只读态分两类：tooltip 三件套（ui）与 8 个共享 getters（editor）——
     * cur / bgStyle / selItem / kindName / connClass / connText / canUndo / canRedo
     * 原先散在根组件和三个属性栏组件里各算一份，现在统一收敛到 store。 */
    ...mapWritableState(useEditorStore, [
      'project', 'floorIdx', 'selection', 'tool', 'mode', 'showLabels',
      'entVersion', 'histVer', 'savedState', 'bgTick',
      'houseW', 'houseD', 'zoomPct', 'bgW', 'bgInfo',
    ]),
    ...mapWritableState(useUiStore, [
      'furnOpen', 'devOpen', 'connOpen', 'importOpen', 'dispOpen',
      'bgOpen', 'backdropOpen', 'resetOpen',
    ]),
    ...mapState(useUiStore, ['tooltipMsg', 'tooltipShow', 'tooltipStyle']),
    ...mapState(useEditorStore, [
      'cur', 'bgStyle', 'selItem', 'kindName',
      'connClass', 'connText', 'canUndo', 'canRedo',
    ]),
    /* 标签抬升高度的造型默认值（styles[].labelOffset，缺省 0.3m） */
    labelOffsetDefault() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it) return 0.3;
      if (k !== 'device' && k !== 'door' && k !== 'window') return 0.3;
      const type = k === 'device' ? devTypeOf(it) : k;
      return window.PluginEngine ? PluginEngine.labelOffset(type, it.style) : 0.3;
    },
    /* 面板显示值：实例覆盖 obj.labelOffset 优先，没设过就显示造型默认值 */
    labelOffsetVal() {
      const it = this.selItem;
      return it && it.labelOffset != null ? it.labelOffset : this.labelOffsetDefault;
    },

    /* 设备页签 → DevPanel.vue；家具页签 → FurnPanel.vue；连接弹窗文案 → ConnModal.vue；
     * 背景分组 → BackdropPicker.vue。
     * HUD 的 weatherState / hudTemp / hudSubs / hudCards 已由 setup() 里的
     * useHud() 提供（原 engine/hud.js + 两页各 4 个委托 computed 已删除）。 */
  },

  methods: {
    /* store Actions → 同名方法（mapActions 转发）。组件内部大量调用 this.toast()、
     * this.setZoomPct() 等，保持同名即可零改动；实现已下沉到 store。
     * engine 侧的 window.App.toast / setSelection / updateZoomLabel 不再指向本组件，
     * 而是由 bridge.js 在入口安装 Pinia 后直接调 store Action —— 引擎不依赖组件
     * 方法名，别名漏映射也不会再让 init() 崩。
     * 其余编排动作（commit / dirty / undo / setTool / setMode / applyBg …）仍在下面，
     * 它们要压撤销栈、$nextTick 后 resize 3D 容器、重放插件场景，不适合放进纯状态 store。 */
    ...mapActions(useUiStore, ['toast', 'openFlyout', 'closeFlyout', 'setToolFlyouts']),
    ...mapActions(useCatalogStore, ['loadCatalog']),
    ...mapActions(useEditorStore, [
      'bumpEntities', 'bumpHistory', 'bumpBg', 'setSelection',
      'setHaStatus', 'setHouseSize', 'markSaved', 'markUnsaved', 'setZoomPct',
      'setZoomFromPpm', 'applyHaConfig', 'setHaCfgError',
    ]),

    /* 设备页签的横向滚动 / 两端渐隐 / 列表复位 → components/pages/editor/DevPanel.vue */

    /* ------- 初始化 ------- */
    async init() {
      /* HA 配置读取独立放在最前面、自带兜底。以前它排在 init() 末尾，前面任何一步
       * 抛错都会让 HA.loadConfig() / HA.connect() 彻底不执行 —— 页面看起来正常，
       * 但状态永远停在「正在连接…」、连接弹窗地址与令牌空白（全局状态化迁移事故）。 */
      await this.loadHAConfig();

      try {
        /* 目录加载走 catalog store 的 Action：model 层写引擎要读的非响应式数据，
         * store 同步写响应式投影，家具列表/页签自动更新（不再需要 bumpEntities）。 */
        await this.loadCatalog();   // 目录先于项目加载（示例户型需要按形态 id 引用家具）
        await this.loadProject();
        await PluginEngine.loadAll();   // 加载 assets/plugins 有状态模型插件
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
        window.addEventListener('beforeunload', () => {
          if (this.savedState !== '已保存' && this.project && navigator.sendBeacon) {
            /* 与手动保存 / autoSave 走同一份 serializeProject 快照：原始 this.project
             * 可能带着过期的 anchors 等运行期字段，整份提交会干扰服务端 disk 优先的合并。 */
            navigator.sendBeacon('/api/project',
              new Blob([JSON.stringify(serializeProject(this.project))], { type: 'application/json' }));
          }
        });

        View3D.startLoop();
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

    /* 读服务端 data/config.json（经 /api/config）并写入全局 store，让顶栏与连接弹窗
     * 从第一帧就有权威配置；失败保留页面可用，同时给出明确错误而不是卡在 connecting。 */
    async loadHAConfig() {
      /* status 监听由 bridge.js 在 mount 前统一注册到 ha store，这里只负责
       * 拉配置并写入响应式镜像，让顶栏与连接弹窗第一帧就有权威配置。 */
      try {
        const c = await HA.loadConfig();
        this.applyHaConfig({ haUrl: c.haUrl, token: c.token, hasToken: c.hasToken });
      } catch (e) {
        this.setHaCfgError('读取失败: ' + (e.message || e));
        this.setHaStatus({ status: 'error', message: '读取连接配置失败' });
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

    async saveProject() {
      clearTimeout(this._saveTimer);
      const body = serializeProject(this.project);   // 自上而下重建，旧字段不入库
      if (!body) { this.toast('项目为空，无需保存'); return; }
      try {
        await fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        this.markSaved();
        this.toast('项目已保存');
      } catch (e) { this.toast('保存失败: ' + e.message); }
    },
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

    /* ------- 撤销 / 重做（快照式，见 js/recode.js） -------
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
        this.project = s.project;
        this.floorIdx = Math.min(Math.max(0, s.floorIdx), this.project.floors.length - 1);
        Editor.select(null);   // 选中对象可能已不在恢复后的数据里
        /* 楼层重指向但不重新 fit: 视图直接用快照里存的，撤销/重做时画面不跳 */
        this.setFloor(false);
        Editor.setView(s.view);   // 同步缩放标签（setView 内部回调 updateZoomLabel）
        this.applyBg();        // 背景插件地面（settings.background 属于快照）
        this.rebuild3D();      // 3D 模式下重建（2D 模式 no-op，进 3D 时 setMode 会再建）
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

    /* ------- 楼层 ------- */
    /* fit=false: 只重指向楼层 + 联动刷新，不用重新适配视野（撤销恢复走这条路，避免画面跳动） */
    setFloor(fit) {
      Editor.floor = this.cur;
      if (fit === false) Editor.render(); else Editor.fit();
      this.setZoomFromPpm(Editor.ppm);
      this.syncBg();
      this.updateHouseSize();
    },
    /* noView=true: 不记录切层这个「视图动作」（新建/删除楼层自己会压一条数据快照，
     * 再插一条视图快照会让撤销要按两次） */
    selectFloor(i, noView) {
      this.floorIdx = i;
      Editor.select(null);   // 切层清选中（App 与 Editor 两边由 select 内部同步）
      this.setFloor();
      if (!noView) this.viewDirty();   // 切层 = fit 重新取景，算一次视图变化（撤销能回到原来那层的取景）
      /* 切层必须让 3D 场景（含背景插件构图）一起换层：背景 group 是按当前楼层的
       * 房屋包围盒摆位的，只在 3D 模式 rebuild 会让「2D 下切层」时背景停留在上一层
       * 的落点，之后切回 3D 前房屋与平台就是错开的。切层是低频操作，隐藏容器里
       * 多建一次 3D 模型可以接受；进 3D 时 setMode 会再 resize + rebuild 一次。 */
      View3D.rebuild(this.project, i);
    },
    addFloor() {
      this.project.floors.push(newFloor((this.project.floors.length + 1) + '层'));
      this.selectFloor(this.project.floors.length - 1, true);
      this.dirty();
    },
    delFloor() {
      if (this.project.floors.length <= 1) return;
      this.project.floors.splice(this.floorIdx, 1);
      this.selectFloor(0, true);
      this.dirty();
    },
    setProjectName(v) { this.project.name = v.trim() || '我的家'; this.dirty(); },

    /* 墙面不透明度(%)：按楼层记忆，拖动实时刷新 3D */
    setWallOpacity(v) {
      const fl = this.cur;
      if (!fl) return;
      if (isNaN(v)) return;
      fl.wallOpacity = Math.min(100, Math.max(0, Math.round(v)));
      this.commit();
    },

    /* 层高(m)：实时预览。input（打字/点步进箭头）防抖 120ms 后重建 3D，change（失焦/回车）
     * 立即收口并钳制到 2~6。打字途中不钳制——0.5 会被 2~6 夹成 2 反写回输入框，打断输入。
     * 2D 平面不画层高，redraw2d 省掉；高度只影响 3D，由 commit 的 rebuild3D 刷新（wallH 在
     * View3D.build 里读 fl.height）。 */
    setFloorHeight(v, phase) {
      const fl = this.cur;
      if (!fl) return;
      const h = parseFloat(v);
      if (isNaN(h)) {
        if (phase === 'change') { fl.height = 2.8; this.commit({ redraw2d: false }); }   // 清空/乱输，失焦兜底回默认
        return;   // 输入中途（如「3.」）不更新，等下一个字符或失焦
      }
      clearTimeout(this._fhTimer);
      if (phase === 'change') {
        fl.height = Math.min(6, Math.max(2, h));
        this.commit({ redraw2d: false });
        return;
      }
      fl.height = h;
      this._fhTimer = setTimeout(() => this.commit({ redraw2d: false }), 120);
    },

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
     * 「输入确认」的校验随输入框一起收进 ResetModal（按钮 disabled + Enter 都要过 ok），
     * 这里只负责真正清空楼层、清选中、压栈与提示。 */
    openResetFloor() { this.openFlyout('reset'); },
    confirmResetFloor() {
      if (!this.cur) return;
      const fl = this.cur;
      fl.walls = []; fl.doors = []; fl.windows = []; fl.furniture = []; fl.devices = [];
      Editor.select(null);   // 清选中（App 与 Editor 两边同步）
      Editor.wallStart = null;
      Editor.ghost = null;
      this.closeFlyout('reset');
      this.commit();
      this.toast('已重置「' + fl.name + '」（自动保存）');
    },

    /* ------- 展示大屏展示项配置 -------
     * 场景勾选 / 快捷设备增删 / 搜索输入 → components/pages/editor/DispCfgModal.vue；根组件只管开关。 */
    openDispCfg() { this.openFlyout('disp'); },
    /* ------- 左侧导航（统一状态机） -------
     * tool 是唯一激活源: select / pan / wall / door / window / furniture / device / bg / backdrop
     * 家具、设备、贴图、背景是"浮层工具"，再次点击同一按钮 → 收起并回到选择；
     * bg（贴图）态画布行为等同选择（Editor.isSelectTool 统一处理）；
     * 视图联动: 除背景（backdrop）外的所有工具强制 2D 编辑；背景反过来强制 3D（选完即所见）
     * keepView: 只收浮层/回到选择，不切换 2D/3D（浮层的 × 与 Esc 用） */
    setTool(t, keepView) {
      const togglable = ['furniture', 'device', 'bg', 'backdrop'];
      const next = (t === this.tool && togglable.includes(t)) ? 'select' : t;
      this.tool = next;
      Editor.tool = next;
      Editor.wallStart = null;
      if (next !== 'furniture' && next !== 'device') Editor.ghost = null;
      this.setToolFlyouts(next);   // ui store Action：四个浮层互斥开关一次改完
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
    pickFurniture(f) {
      Editor.ghost = { kind: 'furniture', data: Object.assign({}, f) };
      Editor.tool = 'furniture';
      this.toast('在户型图上点击放置: ' + f.name);
    },

    /* ------- 背景（背景插件：统一返回 3D group，扁平或立体；静态或动态） ------- */
    applyBg() {
      if (!window.PluginEngine || !View3D.scene) return;
      this.bindBgSettings();
      /* 显式重放的三个前置动作（缺一个都会让背景与房屋错位）：
       * 1) init 时 View3D 还没 build 过，houseBounds() 返回 null，插件会按默认
       *    8×8 原点构图 —— 这里先把 project / house 对准当前楼层；
       * 2) 取消同层拖墙挂起的 160ms 重放，避免和本次显式重放并发双重建销 group；
       * 3) 成功后提交构图指纹，下一次 build 才不会误判「构图变了」再画一遍；
       *    失败不提交，留旧 key 让 build 自动重试。 */
      View3D.cancelBgReplay();
      View3D.ensureHouse(this.project, this.floorIdx);
      if (PluginEngine.applyBackground(this.bgStyle, View3D) === true) View3D.syncBgKey();
    },
    /* 把项目里的背景参数 / 实体绑定对象直接交给引擎（同一引用：面板改值 → 项目数据同步变 → 自动保存） */
    bindBgSettings() {
      if (!window.PluginEngine || !this.project) return;
      const s = this.project.settings || (this.project.settings = {});
      /* 老存档的实体绑定按样式存，这里就地合并成插件级一份（幂等），
       * 保证后续自动保存写进 data/project.json 的也是同一把 key。 */
      if (PluginEngine.migrateProjectBg) PluginEngine.migrateProjectBg(s);
      if (!s.backgroundOptions) s.backgroundOptions = {};
      if (!s.backgroundFields) s.backgroundFields = {};
      PluginEngine.bgOptions = s.backgroundOptions;
      PluginEngine.bgFields = s.backgroundFields;
      /* bgOptions / bgFields 是挂在引擎上的普通对象（非 Vue 响应式）。首次初始化时
       * 面板可能已经先算过一次空值并缓存，这里用 bgTick 让依赖它们的计算属性
       * （批次 3 后位于 components/pages/editor/BackdropPanel.vue，通过 mapState 读
       * 全局 store 的 bgTick）在引用接好之后重算一次，避免刷新后显示旧值。 */
      this.bumpBg();
    },
    /* 改背景参数: 只重绘地面（不重建户型），即时生效并自动保存。
     * 重绘做 90ms 防抖——自绘类背景（1024 贴图 + 撒点）不能让滑块的每个 input 都跑一遍 */
    setBgOpt(key, val) {
      if (!this.bgStyle || !window.PluginEngine) return;
      this.bindBgSettings();
      const store = PluginEngine.bgOptions;
      const cur = store[this.bgStyle] || (store[this.bgStyle] = {});
      cur[key] = val;
      this.bumpBg();
      clearTimeout(this._bgOptTimer);
      this._bgOptTimer = setTimeout(() => this.applyBg(), 90);
      this.dirty();
    },
    /* 改背景的实体绑定：绑定只影响数据，不重建几何，所以只推一次 onData。
     * 值存 settings.backgroundFields['<插件id>'][key] —— 该插件所有样式共用，
     * 切样式不会丢；换回未绑定时删掉该键。 */
    setBgField(key, val) {
      if (!this.bgStyle || !window.PluginEngine || !key) return;
      this.bindBgSettings();
      const store = PluginEngine.bgFields;
      const pk = PluginEngine.bgFieldKey(this.bgStyle);
      const cur = store[pk] || (store[pk] = {});
      const eid = String(val || '').trim();
      if (eid) cur[key] = eid; else delete cur[key];
      this.bumpBg();
      this.dirty();
      PluginEngine.notifyBackgroundData(true);
    },
    setBackground(b) {
      if (!this.project) return;
      if (!this.project.settings) this.project.settings = newSettings();
      this.project.settings.background = b ? b.id : '';
      this.applyBg();
      this.dirty();   // 自动保存到 data/project.json
      this.toast(b ? ('背景已切换: ' + b.name) : '已恢复默认背景（纯色 + 网格）');
    },
    pickEntity(e) {
      Editor.ghost = { kind: 'device', data: { entityId: e.eid, name: e.name, type: e.type } };
      Editor.tool = 'device';
      this.closeFlyout('dev');
      this.toast('在户型图上点击放置: ' + e.name);
    },
    delSelected() { Editor.deleteSelection(); },
    locateDevice(p) {
      if (p.fi !== this.floorIdx) this.selectFloor(p.fi);
      Editor.select(p.d.kindName || 'device', p.d.id);
      Editor.fit();
      this.setZoomFromPpm(Editor.ppm);
      this.viewDirty();   // 定位后取景变了，记一条视图快照（撤销能回到定位前）
    },
    /* 设备图标 typeIcon → components/pages/editor/DevPanel.vue */
    /* 家具图标: 直接引用 catalog.js 的全局 furnIcon（图标数据在 catalog.json 的 icon 字段） */
    furnIcon(f, scale) { return window.furnIcon(f, scale); },

    /* ------- 视图 ------- */
    setMode(m) {
      this.mode = m;
      this.$nextTick(() => {
        if (m === '3d') {
          // 关键: 容器从 v-show 隐藏变为可见后先 resize 再 build
          View3D.resize();
          View3D.rebuild(this.project, this.floorIdx);
          View3D.setLabelsVisible(this.showLabels);   // 恢复顶栏开关状态
        } else {
          Editor.resize();
        }
      });
    },
    toggleLabels() {
      this.showLabels = !this.showLabels;
      View3D.setLabelsVisible(this.showLabels);
      this.toast(this.showLabels ? '已显示设备标签' : '已隐藏设备标签');
    },
    /* 旋转锚点重置回房屋中心（长按 3D 画面可自定义锚点；编辑页不持久化锚点） */
    resetAnchor() {
      View3D.resetAnchor();
      this.toast('锚点已重置回房屋中心');
    },
    openDisplay() { window.open('/display.html', '_blank'); },
    /* zoomStep / zoomFit / zoomCenter → components/pages/editor/CanvasStage.vue：
     * 缩放按钮就在画布覆盖层里，换算走 store Action setZoomFromPpm()，
     * 压视图撤销栈的 viewDirty() 由组件 emit('view-dirty') 回来。 */

    /* ------- 属性编辑 ------- */
    /* setSelection 由 mapActions 转发到 store；engine 侧的 window.App.setSelection 由 bridge.js 提供。 */
    setProp(key, value, type) {
      const it = this.selItem;
      if (!it) return;
      let v = parseFloat(value);
      if (type === 'str') {
        const s = (value || '').trim();
        if (s) it[key] = s; else delete it[key];   // 清空 = 解绑，不留空串（插件侧统一按 falsy 判未绑定）
      }
      else { if (isNaN(v)) return; it[key] = type === 'deg' ? v * Math.PI / 180 : v; }
      this.commit({
        rebuild: type !== 'str',   // 数值修改实时刷新 3D 预览
        updateAll: true,           // 实体绑定等字段变化 → 插件即时响应
        syncLabels: true,          // 绑定字段变化 → 标签文案重算
      });
    },
    deg(rad) { return Math.round((rad || 0) * 180 / Math.PI); },

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
    rebuild3D() {
      if (this.mode !== '3d') return;
      View3D.rebuild(this.project, this.floorIdx);
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
    /* 扩展实体绑定的当前读数（面板里直接显示，确认绑对了没有）
     * 返回 { text, on } —— text 为空表示未绑定，'未找到' 表示实体不存在 */
    devFieldVal(key) {
      void this.entVersion;   // 依赖实体状态版本: HA 推送后自动重算
      const it = this.selItem;
      const eid = it && it[key];
      if (!eid) return '';
      const st = HA.getState(eid);
      if (!st) return '未找到';
      return st.state + HA.unitOf(st);
    },
    clearDevField(key) {
      const it = this.selItem;
      if (!it || !it[key]) return;
      this.setProp(key, '', 'str');
      this.toast('已解绑');
    },
    /* ------- 数值编辑（设备/门窗/家具共用底座） -------
     * applyNum: 解析 + 可选角度换算/夹取 + commit（原 setDevNum/setOpenNum/setFurnNum 三胞胎收敛于此）
     * wheelStep: 滚轮步进（deltaY 向上 = 增）后走 applyNum（原 wheelNum/wheelOpen/wheelFurn 收敛于此）
     * opts: { deg: 按°输入换算弧度, min/max: 夹取, int: 取整, redraw2d: 是否重绘 2D } */
    applyNum(key, value, opts) {
      const it = this.selItem;
      if (!it) return;
      const o = opts || {};
      const v = parseFloat(value);
      if (isNaN(v)) return;
      let n = o.deg ? v * Math.PI / 180 : v;
      if (o.int) n = Math.round(n);
      if (o.min != null) n = Math.max(o.min, n);
      if (o.max != null) n = Math.min(o.max, n);
      it[key] = n;
      this.commit({ redraw2d: o.redraw2d !== false });
    },
    wheelStep(key, e, step, opts) {
      const it = this.selItem;
      if (!it) return;
      const o = opts || {};
      const cur = o.deg ? this.deg(it[key]) : (parseFloat(it[key]) || 0);
      let v = cur + (e.deltaY < 0 ? step : -step);
      if (!o.deg) v = Math.round(v * 1000) / 1000;   // 浮点步进不留 0.30000000000000004 这类尾巴
      this.applyNum(key, String(v), o);
    },
    /* 设备数值: x/y/rot 重绘 2D（redraw2d=true），z 不重绘（贴地属性由 3D 决定） */
    setDevNum(key, value, redraw2d) {
      this.applyNum(key, value, { min: key === 'z' ? 0 : null, redraw2d: !!redraw2d });
    },
    wheelNum(key, e, step, redraw2d, min, max) {
      this.wheelStep(key, e, step, {
        redraw2d: !!redraw2d,
        min: min != null ? min : (key === 'z' ? 0 : null),
        max: max != null ? max : null,
      });
    },
    /* 标签抬升高度（m）: 实例覆盖造型声明值，只动 HTML 标签位置、不重建 3D ——
     * View3D.updateLabels 每帧读 obj.labelOffset，改完下一帧就到位。
     * 拖滑条时 200ms 防抖再 dirty（快照/自动保存），避免每一档都压一条撤销栈 */
    setDevLabelOffset(value) {
      const it = this.selItem;
      if (!it) return;
      if (String(value).trim() === '') return;                // 正在清空：等 @change 再决定
      const v = parseFloat(value);
      if (isNaN(v)) return;
      it.labelOffset = Math.round(Math.max(-1, Math.min(6, v)) * 100) / 100;
      clearTimeout(this._labelOffTimer);
      this._labelOffTimer = setTimeout(() => this.dirty(), 200);
    },
    /* 输入框失焦/回车：清空 = 删掉实例覆盖，回到造型声明的 labelOffset */
    commitDevLabelOffset(value) {
      if (String(value).trim() === '') this.clearDevLabelOffset();
      else this.setDevLabelOffset(value);
    },
    clearDevLabelOffset() {
      const it = this.selItem;
      if (!it || it.labelOffset == null) return;
      delete it.labelOffset;
      clearTimeout(this._labelOffTimer);
      this._labelOffTimer = setTimeout(() => this.dirty(), 200);
    },
    wheelDevLabelOffset(e, step) {
      const cur = parseFloat(this.labelOffsetVal) || 0;
      this.setDevLabelOffset(cur + (e.deltaY < 0 ? step : -step));
    },
    /* 门窗数值: 宽度（最小 0.05m）/角度，实时刷新 2D + 3D */
    setOpenNum(key, value, type) {
      this.applyNum(key, value, { deg: type === 'deg', min: type === 'deg' ? null : 0.05 });
    },
    /* 窗离地高度: 0 起步（门恒 0 不可调，面板不渲染输入框） */
    setOpenZ(value) { this.applyNum('z', value, { min: 0 }); },
    wheelOpenZ(e, step) { this.wheelStep('z', e, step, { min: 0 }); },
    wheelOpen(key, e, step, type) {
      this.wheelStep(key, e, step, { deg: type === 'deg', min: type === 'deg' ? null : 0.05 });
    },
    /* 家具数值: 旋转/位置/离地高度/整体比例（20–300 取整），实时刷新 2D + 3D */
    setFurnNum(key, value, type) {
      this.applyNum(key, value, {
        deg: type === 'deg',
        min: key === 'z' ? 0 : (key === 'pct' ? 20 : null),
        max: key === 'pct' ? 300 : null,
        int: key === 'pct',
      });
    },
    wheelFurn(key, e, step) {
      if (key === 'rot') return this.wheelStep(key, e, step, { deg: true });
      this.wheelStep(key, e, step, {
        min: key === 'z' ? 0 : (key === 'pct' ? 20 : null),
        max: key === 'pct' ? 300 : null,
        int: key === 'pct',
      });
    },
    /* 设备造型图标（由插件 styles[].icon 提供，缺省 ⚙️） */
    devStyleIcon(s) { return window.devStyleIcon(s); },

    /* ------- 参考底图（2D 户型图：全项目共用一张 —— 服务器端只存 data/refimg.* 一张图，
     *          画完户型图基本就弃用，没必要按楼层各存一份；经 /api/refimg 读取，
     *          src 带 ?t= 时间戳防缓存，重复上传不用刷新页面即可看到新图） ------- */
    /* 文件选择框与 /api/upload 上传请求 → components/pages/editor/BgPanel.vue；
     * 上传成功后 emit('uploaded', {url,name}) 回到下面的 applyBgImage。 */
    /* 加载贴图并写入项目（bgImage 挂在 project 上：全楼层共用一张）。
     * src 追加 ?t= 时间戳：同一会话里重复上传时 URL 变化，浏览器不命中旧缓存 */
    applyBgImage(src, name) {
      if (src.startsWith('/api/refimg')) {
        src = src + (src.includes('?') ? '&' : '?') + 't=' + Date.now();
      }
      const img = new Image();
      img.onload = () => {
        const meta = { src, name: name || '贴图', x: 0, y: 0, w: 10, opacity: 0.35, hidden: false };
        Editor.backgroundImage = Object.assign({ img }, meta);
        this.bgW = 10;
        this.bgInfo = { has: true, hidden: false };
        if (this.project) this.project.bgImage = meta;
        Editor.render();
        this.dirty();
      };
      img.onerror = () => this.toast('图片加载失败');
      img.src = src;
    },
    /* 把编辑器中的贴图状态写回项目并标记保存 */
    writeBg() {
      const bg = Editor.backgroundImage;
      if (!this.project || !bg || !bg.src) return;
      this.project.bgImage = {
        src: bg.src, name: bg.name || '贴图',
        x: bg.x, y: bg.y, w: bg.w,
        opacity: bg.opacity == null ? 0.35 : bg.opacity,
        hidden: !!bg.hidden,
      };
      this.dirty();
    },
    /* 楼层切换/载入时恢复贴图（项目级共用，切层不换图） */
    syncBg() {
      const b = this.project && this.project.bgImage;
      const cur = Editor.backgroundImage;
      if (!b || !b.src) {
        if (cur && cur.src) { Editor.backgroundImage = null; this.bgInfo = { has: false, hidden: false }; Editor.render(); }
        return;
      }
      if (cur && cur.src === b.src) {
        Object.assign(cur, { x: b.x, y: b.y, w: b.w, opacity: b.opacity, hidden: !!b.hidden });
        this.bgW = b.w || 10;
        this.bgInfo = { has: true, hidden: !!b.hidden };
        Editor.render();
        return;
      }
      const img = new Image();
      img.onload = () => {
        // 载入期间项目可能已被撤销/重做替换
        if (!this.project || !this.project.bgImage || this.project.bgImage.src !== b.src) return;
        Editor.backgroundImage = Object.assign({}, this.project.bgImage, { img });
        this.bgW = this.project.bgImage.w || 10;
        this.bgInfo = { has: true, hidden: !!this.project.bgImage.hidden };
        Editor.render();
      };
      img.src = b.src;
    },
    toggleBg() {
      const bg = Editor.backgroundImage;
      if (!bg || !bg.img) return;
      bg.hidden = !bg.hidden;
      this.bgInfo = { has: true, hidden: !!bg.hidden };
      this.writeBg();
      Editor.render();
    },
    onBgScale(e) {
      const bg = Editor.backgroundImage;
      if (!bg || !bg.img) return;
      const nw = parseFloat(e.target.value) || 10;
      // 缩放锚点 = 图片中心：调整左上角位置使中心保持不动
      const ratio = bg.img.height / bg.img.width;
      bg.x += (bg.w - nw) / 2;
      bg.y += (bg.w - nw) * ratio / 2;
      bg.w = nw;
      this.bgW = nw;
      this.writeBg();
      Editor.render();
    },
    clearBg() {
      Editor.backgroundImage = null;
      this.bgInfo = { has: false, hidden: false };
      // 保持贴图浮层打开，方便紧接着重新上传
      if (this.project && this.project.bgImage) { this.project.bgImage = null; this.dirty(); }
      Editor.render();
    },

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
      /* 引擎段若初始化失败，finally 里仍会发起 HA 连接（含演示模式的同步首帧推送），
       * 此时不能让渲染调用再抛错打断状态回调 —— 只更新数据，等切视图时再重绘。 */
      try {
        if (this.mode === '3d') View3D.refresh();
        else Editor.render();
      } catch (e) { /* 引擎尚未就绪 */ }
    },

    /* ------- 提示 ------- */
    /* toast() 已下沉到 stores/ui.js，由 methods 顶部的 mapActions 生成同名方法；
     * engine/view3d.js 的 window.App.toast() 由 bridge.js 指向同一个 Action
     * （大屏页入口会覆盖成 DisplayApp.toastMsg，那里才有气泡 DOM）。 */

    bindKeys() {
      window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        const map = { v: 'select', h: 'pan', w: 'wall', d: 'door', n: 'window', f: 'furniture', e: 'device', b: 'bg', g: 'backdrop' };
        const k = e.key.toLowerCase();
        /* 撤销/重做: Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z（或 Ctrl+Y）；输入框聚焦时 bindKeys 顶部已跳过 */
        const mod = e.ctrlKey || e.metaKey;
        if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
        if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
        if (map[k] && this.mode === '2d') this.setTool(map[k]);
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.mode === '2d') Editor.deleteSelection();
        /* Esc 统一收起: 取消绘制 + 收浮层 + 清选中 → 右侧无论从属性面板还是背景面板进来，
         * 都回到「楼层设置」；'none' 是故意不存在的工具值 —— 不点亮任何左侧按钮
         * （落到 editor 的 select default 分支，画布点击选中仍可用），也不默认切回「选择」 */
        if (e.key === 'Escape') { Editor.wallStart = null; Editor.ghost = null; Editor.select(null); Editor.render(); this.setTool('none', true); }
      });
    },

    /* 启动遮罩的移除 / 12s 兜底统一由 components/common/boot.js 提供 */
  },

  watch: {
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
};
</script>

<style>
/* 启动遮罩的样式随 components/common/BootOverlay.vue 一起打包，本页只留专用样式 */
/* 编辑页版本号：固定在页面左下角（左侧工具栏底部），2D/3D 模式都常驻。
   只用定位修饰 .tb-ver-corner，基础胶囊样式仍在 style.css，大屏页标题旁的版本号不受影响。 */
.tb-ver-corner { position: fixed; left: 10px; bottom: 10px; z-index: 25; }
</style>
