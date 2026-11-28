<template>
  <div class="p-shell" :class="{ 'p-touch-js': jsGesture }" v-if="project">
    <stage-surface :floors="floors" :floor-idx="floorIdx" :floor-busy="floorBusy"
      :slow="isSlow" :stage-ready="stageReady" @select-floor="selectFloor" />

    <panel-header :name="project.name || '家'" :wide="wide" :in-app="inApp"
      :hud-temp="hudTemp" :hud-icon="hudIcon" :hud-subs="hudSubs" :hud-brief="hudBrief"
      :hud-cards="hudCards"
      :net-class="netClass" :status-text="statusText"
      :on-count="onCount" :device-total="deviceTotal"
      :auto-rotate="autoRotate" :show-labels="showLabels"
      @open-settings="openAppSettings" @toggle-rotate="toggleRotate"
      @toggle-labels="toggleLabels" @fullscreen="fullscreen" />

    <scene-strip v-if="displayItems.length" :items="displayItems" :scene-busy="sceneBusy"
      :scene-done="sceneDone" @run="runScene" />

    <room-tabs v-if="roomTabs.length" :rooms="roomTabs" :all-active="isAll"
      :active-id="activeId" @focus="focusRoom" />

    <card-pane :card-view="cardView" :card-key="cardKey" :scope-on="scopeOn"
      :scope-total="scopeTotal" :single="!!(cardView && cardView._single)" @act="onCardAct" />

    <div class="p-toast" v-if="toast">{{ toast }}</div>
    <!-- 断线重连中的轻提示：status 事件带 retrying 才显示，首屏「连接中…」不打扰 -->
    <div class="p-reconn" v-if="reconnecting"><i class="spin"></i>正在重新连接…</div>
  </div>

  <div class="p-empty" v-else>
    <div style="font-size:40px">🏠</div>
    <div>还没有户型数据</div>
    <div style="opacity:.7;font-size:13px">请先到编辑器绘制户型并保存</div>
    <a href="/">→ 打开编辑器</a>
  </div>
</template>

<script>
import StageSurface from './components/pages/panel/StageSurface.vue';
import PanelHeader from './components/pages/panel/PanelHeader.vue';
import SceneStrip from './components/pages/panel/SceneStrip.vue';
import RoomTabs from './components/pages/panel/RoomTabs.vue';
import CardPane from './components/pages/panel/CardPane.vue';
import { getCurrentInstance } from 'vue';
import { mapState } from 'pinia';
import { useHaStore } from './stores/ha';
import { useUiStore } from './stores/ui';
import { useCards } from './composables/useCards';
import { useHud } from './composables/useHud';
import { useDisplayDerived } from './composables/useDisplayDerived';
import { useSceneRunner } from './composables/useSceneRunner';
import { bootStageData, waitForPaint, waitForCardsReady, startStage3D } from './composables/useStageBoot';
import { selOfPick } from './model/pick';
import { PREF_KEYS, prefBool, prefSetBool, prefInt, prefSetInt } from './services/prefs';

/* 版面 / 取景 / 手势的全部常量集中在 model/stageLayout.js（JS 侧唯一出处）。
 * CSS 里的 1024 / 340 / .38 无法引用 JS，改动时须两边同步。 */
import { isWideViewport } from './model/stageLayout';
/* 阶段 0：纯计算搬到 model/ 下（零 Vue/DOM/THREE，可 Node 单测），本文件只留副作用壳。
 * 窄屏点按判定（tapGesture）：beforeUnmount 清理手势状态时还要 beginGesture()。 */
import { beginGesture } from './model/tapGesture';
/* 结构重构（2026-11-28 第二轮）：取景与手势两大体系拆到 composables/，以「方法组
 * 对象」形态导出，在此摊进 methods —— Vue 把每个 method 绑定到组件实例，`this`
 * 语义与原地内联完全一致，纯搬运零行为变化：
 *   useStageCamera   取景体系（可视区实测 → 视锥对中 → 迭代收敛 → 平滑逼近 → fitStage/fitRoom）
 *   usePanelGesture  窄屏手势体系（3D 带压缩 → 触摸分发 → 惯性 → 滚轮）
 * 事件绑定（mounted/beforeUnmount 的 passive 选项成对出现）与场景模式 / 视图开关
 * 等编排仍留在本组件。 */
import { stageCameraMethods } from './composables/useStageCamera';
import { panelGestureMethods } from './composables/usePanelGesture';
import { useSceneMode } from './composables/useSceneMode';
import { disposeEngine } from './engine';

/*
 * PanelApp — 控制面板（本产品的主入口页，窄屏 / 宽屏自适应）
 *
 * 版面：一整页连续的 3D，内容浮在上面
 *   顶栏（房子名 / 亮灯统计 / 工具） → 3D 可视带 → 场景磁贴 → 全屋·房间 → 卡片
 *   窄屏单列（3D 只占顶部 --p-band 那条带）；宽屏 3D 铺满左侧、右侧 340 竖栏。
 * 融合：3D 画布铺满整页当背景（尺寸恒定）；白底只出现在内容侧，且朝 3D 方向用 mask 羽化，
 *   绝不整屏盖白纱（会把 3D 压得发灰）。见下方 .p-shell::after。
 * 上滑压缩：只是白纸羽化层及以下整体上移，「场景列表以上」那块露出的显示区域变矮；
 *   按上滑量算出剩余高度与中心，用代码把房子平移过去并重新取景，让它始终落在
 *   显示区正中间。取景以「完整可见」为硬约束（包围盒不得超出显示区，见 fitScale），
 *   在不出界的前提下把填充率从 0.88 渐进抬到 0.96，越压越贴边、房子尽量大。
 * 构图：取景按可视区算（宽屏扣掉右栏），用 camera.setViewOffset 平移视锥——
 *   不动 controls.target，旋转中心始终是房子中心 / 选中房间中心
 *   （本页已关掉长按设锚点，见 afterInit）。
 * 两页共用 engine/、stores/、composables/useCards、components/common/cards，
 * 启动序列共用 composables/useStageBoot.js。
 * 结构重构（2026-11-28 第二轮）：取景体系拆 composables/useStageCamera.js、
 * 手势体系拆 composables/usePanelGesture.js（方法组摊进 methods），本组件留
 * 启动编排 / 切层 / 场景模式 / 视图开关 / 卡片与 HA 事件等生命周期强耦合部分。
 */

/* 卡片选中态：本页卡片常驻，点空白回到全屋（不收起） */
const ALL = () => ({ kind: 'all' });

/* 切层遮罩自适应阈值（ms）：某层的上一次实测重建耗时超过它，下一次切这层才出遮罩。
   慢设备（手机切大层）实测普遍 1~3s 稳定命中；快设备（PC / 旗舰机切小层）几百 ms
   以内，遮罩一闪而过没有信息量，裸切观感更利落。 */
const ADAPT_MASK_MS = 400;

export default {
  name: 'PanelApp',
  components: { StageSurface, PanelHeader, SceneStrip, RoomTabs, CardPane },

  setup() {
    const vm = getCurrentInstance().proxy;
    const cards = useCards({
      selection: () => vm.sel,
      floor: () => vm.cur,
    });
    /* 天气 + 实时数据卡：与大屏共用同一套派生（HA 天气实体 / 楼层 display.dataCards） */
    const hud = useHud(() => vm.project && vm.project.settings, () => vm.cur && vm.cur.display);
    /* 阶段 2：选中范围 / 统计 / 展示项 / 状态文案的派生与执行状态机，
       集中在 composables（vm.xxx 延迟取值，Options API 的 data/computed 照旧可读） */
    const derived = useDisplayDerived({
      floor: () => vm.cur,
      floors: () => vm.floors,
      selection: () => vm.sel,
      revision: () => vm.pluginRevision,
    });
    const sceneRunner = useSceneRunner({ toast: (msg) => vm.toastMsg(msg) });
    return { cardView: cards.view, runCard: cards.run, ...hud, ...derived, ...sceneRunner };
  },

  data() {
    return {
      project: null,
      floorIdx: 0,
      /* 插件就绪版本号：bootStageData.afterPlugins 递增一次，让派生层把默认 isOn 规则
         切成插件 isOn 后重算。HA 状态推送不再需要本地镜像 —— ha store.entityVersion
         由 bridge.js 统一递增，派生 composable 直接依赖它。 */
      pluginRevision: 0,
      /* 本机显示偏好统一走 services/prefs.js（键名在 PREF_KEYS，异常一律静默） */
      autoRotate: prefBool(PREF_KEYS.autoRotate, false),
      /* 标签显隐与编辑页分开存储（2026-11-20 拆分）：展示页用 panelShowLabels，
         从没写过（null）时回退旧共用键 ha3d.showLabels —— 老用户已设的偏好不丢；
         一旦在本页切过，两页各自独立、互不影响。 */
      showLabels: prefBool(PREF_KEYS.panelShowLabels, prefBool(PREF_KEYS.showLabels, true)),
      toast: '',
      sel: ALL(),
      floorBusy: false,      // 窄屏切层加载动画开关（宽屏恒 false；是否置位见 selectFloor 自适应）
      stageReady: false,     // 3D 首帧是否已上屏：慢设备用它撤掉 3D 占位动画（见 StageSurface）
      /* 每层上一次切层的实测重建耗时（ms，floorIdx → ms）。切层遮罩的自适应依据：
         超过 ADAPT_MASK_MS 的层下次出遮罩，否则裸切。换项目时清空（户型不同耗时不可比）。 */
      _rebuildMsByFloor: {},
    };
  },

  watch: {
    /* 选中项 → 3D 高亮（房间地面提色 / 设备圆环），让「卡片里是谁」在场景里也有锚点。
     * 入口统一走 useSceneMode.pickHi（与 EditApp 同底座）。 */
    sel(v) { this.pickHi(v, true); },
  },

  computed: {
    ...mapState(useHaStore, ['haStatus']),
    /* 版面模式统一从 ui store 取（原 data().wide 已删）：卡片控件的交互模式、
       窄屏手势白名单、本页 HUD 与取景共用同一份真相，跨断点不会出现
       「页面已放行手势但组件还在点选态」的错位。 */
    ...mapState(useUiStore, { wide: 'viewportWide', inApp: 'inApp', jsGesture: 'jsGesture' }),

    /* 回前台 / 断线后正在重连：以前页面完全没有反馈，只会显得「卡住几秒」。
     * 只认 status 事件里的 retrying 标志，首屏连接中不会弹这条。 */
    reconnecting() { return !!(this.haStatus.retrying && this.haStatus.status === 'connecting'); },

    cur() { return this.project ? this.project.floors[this.floorIdx] : null; },
    floors() { return (this.project && this.project.floors) || []; },

    /* 是否允许使用空壳原生桥：只看 AppShell 是否存在 —— 原生桥只在壳的 WebView 里
       注入，普通浏览器恒 undefined，不会误触发；URL 无需追加任何参数 */
    /* 慢设备：壳内 WebView（性能普遍弱）∥ 触屏设备（手机/平板浏览器）。
       pointer:coarse = 主输入是手指 —— 正好把「机器强但窗口窄」的 PC 排除在外。
       用于切层遮罩流程里「等遮罩上屏」的 50ms 缓冲只在慢设备上执行；
       相位让帧重建则所有窄屏都走（快机器上每帧才 ~16ms，成本可忽略还多一层保险）。 */
    isSlow() {
      return this.inApp
        || (typeof window !== 'undefined' && window.matchMedia
          && window.matchMedia('(pointer: coarse)').matches);
    },
    /* 阶段 2：roomTabs / activeId / isAll / onCount / deviceTotal / scopeDevices /
       scopeTotal / scopeOn / displayItems / statusText / netClass / cardKey 全部由
       useDisplayDerived() 提供，不再在本页各写一份 + void entVersion。
       统计双口径：顶栏 onCount/deviceTotal = 全家所有楼层；卡片头 scopeOn/scopeTotal
       = 当前楼层（再按全屋/房间收窄），两者用同一把 HA.deviceIsOn 尺子。 */
  },

  methods: {
    /* ------- 职责方法组（composables/ 拆分，见文件头 import 处说明） ------- */
    ...stageCameraMethods,    // 取景体系（_visibleH / stageMetrics / alignStageView / fitStage / fitRoom / 平滑逼近 …）
    ...panelGestureMethods,   // 手势体系（_stageEnsure / _setStageH / 触摸分发 / 惯性 / onStageWheel / syncStageBandForViewport）
    ...useSceneMode.methods,  // 场景模式装配共享底座（toggleLabelsCore / applySceneCore / pickHi / refresh3dQuiet）

    /* 启动三段（见 useStageBoot.js）：① 数据 + HA 提前连接 → ② 等非 3D 区域真实上屏
     * → ③ 才进 3D 重建。慢设备上第 ③ 段的同步 rebuild 不再拖住卡片/天气/楼层按钮。 */
    async init() {
      /* 段 1：目录 / 项目 / 插件 / HA。onProject 赋值后 v-if="project" 挂载整页，
         HA 连接也在这里发起 —— 非 3D 区域此时已能拿到真实数据。 */
      const project = await bootStageData({
        onProject: (p) => {
          this.project = p;
          this._rebuildMsByFloor = {};   // 换项目后各层耗时作废（户型不同不可比），回 isSlow 先验
          document.title = (p && p.name ? p.name : 'HA 3D Home') + ' · 控制面板';
          /* 楼层选择持久化：与大屏共用同一个偏好键，换页后停在同一层 */
          const saved = prefInt(PREF_KEYS.displayFloor, -1);
          if (saved >= 0 && saved < (p.floors || []).length) this.floorIdx = saved;
        },
        /* 插件就绪 → 开关判定从默认规则切到插件 isOn，递增一次版本号让派生层重算 */
        afterPlugins: () => { this.pluginRevision++; },
        onHaChange: () => this.onHAChange(),
      });

      /* 段 2：让非 3D 区域真实上屏后再进 3D —— 这是它不被 3D 重建阻塞的关键。
         慢设备等 HA 首帧数据到齐（waitForCardsReady）；快设备无重建瓶颈，
         只需 nextTick + 双 rAF（waitForPaint）即可。 */
      if (this.isSlow) await waitForCardsReady();
      else await waitForPaint();

      /* 段 3：3D 舞台重活。容器 #pstage 此刻已上屏，rebuild 再慢也不影响上面的卡片。 */
      await startStage3D({
        stageId: 'pstage',
        project,
        floorIndex: () => this.floorIdx,
        afterInit: () => {
          View3D.anchorEnabled = false;      // 本页不提供长按设锚点：旋转中心固定跟全屋 / 选中房间
          View3D.controls.autoRotateSpeed = 0.6;
          View3D.setAutoRotate(this.autoRotate);   // 意图写进引擎，飞行/取景恢复时不会把它按回去
          View3D.enableFloorCache();         // 懒加载层缓存：首切照常构建，之后切层换组秒切（编辑页不启用）
        },
        /* rebuild + frame + 背景 → 应用「窄屏纯展示 / 宽屏可点」模式、默认选中全屋 */
        afterRebuild: () => {
          this.sel = ALL();
          View3D.resize();      // 容器是整页（非网格行），首帧按实际尺寸算一次
          this.fitStage();      // 再按「可视带」重新构图（见 fitStage）
          this.applyStageMode();  // 标签显隐 ⇔ 点击语义；窄屏强制不显示标签（点设备执行）
        },
      });

      /* 3D 首帧要下一帧才画出来：再等一帧才撤占位，避免露一下空白画布。
         只对慢设备有意义（快设备压根没挂载占位），但置位本身幂等、无副作用。 */
      await new Promise((r) => requestAnimationFrame(r));
      this.stageReady = true;
    },

    /* ---------------- 交互 ---------------- */

    /* 窄屏左上角图标（仅 App 内有反应）：唤起空壳 App 的原生「服务器地址设置」页。
       无桥（普通浏览器）时静默忽略 —— 图标退化为纯装饰。 */
    openAppSettings() {
      try { if (window.AppShell) window.AppShell.openSettings(); } catch (_) { /* 忽略 */ }
    },

    onPick3D(hit) {
      /* 点空白回到全屋（本页卡片常驻，不像大屏那样收起） */
      this.sel = selOfPick(hit) || ALL();
    },

    async selectFloor(i) {
      /* 窄屏切层统一走相位让帧重建（rebuildAsync）；遮罩则按「自适应实测」决定：
         该层上一次重建耗时 > ADAPT_MASK_MS 才出遮罩（慢层给出转圈反馈 + 等上屏的
         双 rAF/50ms 都只在这一路），快层裸切 —— 旧画面冻结零点几秒后新楼层直接弹出，
         比一闪而过的遮罩更利落。没测过的层按 isSlow 先验（慢设备先给反馈、
         快设备先裸切），切一次就有实测值接管。防连点始终由 _flBusy 承担，不靠遮罩。
         宽屏机器快、直接同步走原路径，零开销。 */
      if (!this.wide) {
        if (this._flBusy) return;              // 防连点：上一次还没切完
        this._flBusy = true;
        const last = this._rebuildMsByFloor[i];
        const needMask = last == null ? this.isSlow : last > ADAPT_MASK_MS;
        try {
          if (needMask) {
            this.floorBusy = true;
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            /* 50ms 宏任务缓冲：让遮罩帧真正呈现、转圈先转起来再进重建（只有遮罩路需要） */
            await new Promise((r) => setTimeout(r, 50));
          }
          const t0 = performance.now();
          try {
            await this._applyFloorAsync(i);    // 相位化重建：每相位让一帧
          } finally {
            this._rebuildMsByFloor[i] = performance.now() - t0;   // 实测耗时供下次判定
          }
          if (needMask) {
            await new Promise((r) => requestAnimationFrame(r));   // 新楼层首帧渲完再撤遮罩
          }
        } finally {
          this.floorBusy = false;   // 遮罩路撤遮罩；裸切路本就没置位，写 false 幂等
          this._flBusy = false;
        }
      } else {
        this._applyFloor(i);
      }
    },

    /* selectFloor 的状态编排本体（同步/异步共用）：
       ① 记楼层 + 清旧选中 + 持久化 → ② 重建（sync 直跑 / async 相位让帧）→
       ③ resize + 重取景 + 高亮（async 路径放在重建后再让一帧执行，全程在遮罩之下）。 */
    _applyFloorState(i) {
      this.floorIdx = i;
      this.sel = ALL();                     // 切层后旧的选中项不属于当前层
      prefSetInt(PREF_KEYS.displayFloor, i);
    },
    async _applyFloorAsync(i) {
      this._applyFloorState(i);
      await View3D.rebuildAsync(this.project, i);
      await new Promise((r) => requestAnimationFrame(r));
      View3D.resize();
      this.fitStage();                      // 切层后重新按可视带构图（不用原始 frame）
      applyPickHi(View3D, this.sel, true);
    },

    _applyFloor(i) {
      this._applyFloorState(i);
      View3D.rebuild(this.project, i);
      View3D.resize();
      this.fitStage();                      // 切层后重新按可视带构图（不用原始 frame）
      applyPickHi(View3D, this.sel, true);
    },

    /* ------- 取景体系 -------
     * _visibleH / stageMetrics / alignStageView / fitDistance / fitScale / refocus /
     * _desireFit / _smoothStop / _smoothTick / _convergeFit / fitStage / probeBox / fitRoom
     * 已拆到 composables/useStageCamera.js（文件头 import 处摊进 methods）。
     * 纯计算前置在 model/panelCamera.js（可 Node 单测），副作用壳在 composable。 */

    /* 点房间 = 选中出卡 + 相机飞过去；全屋 = 所有房间卡 + 默认取景。
       不用引擎的 View3D.focusRoom：它按「整块画布」算视距和中心，而我们这里是整页画布 + 剩余可视区，
       直接复用会把房间放到卡片底下、尺寸也不对，所以这里按同一套包围盒逻辑自己算一次。 */
    focusRoom(id) {
      if (!id) {
        this.sel = ALL();
        this.fitStage(true);          // 房间 → 全屋 也要飞回去（不再硬切）
        return;
      }
      this.sel = { kind: 'room', id };
      this.fitRoom(id, true);
    },

    /* 临时相机试算 probeBox 与房间取景 fitRoom 也已拆到 composables/useStageCamera.js。 */

    async onCardAct(node, value) {
      try {
        const r = await this.runCard(node, value);
        if (!r && node.action) this.toastMsg('该动作没有可用的服务配置');
      } catch (e) {
        this.toastMsg('操作失败：' + (e && e.message ? e.message : e));
      }
    },

    onHAChange() {
      /* 实体版本由 bridge.js 统一写进 ha store，派生 computed 自动重算，本页不再自己 ++。
       * 静默重绘底座（useSceneMode.refresh3dQuiet，审计 2.17 补齐漂移的 try/catch）。 */
      this.checkSceneWatchers();
      this.refresh3dQuiet(() => View3D.refresh());
    },

    /* ---------------- 场景执行 ----------------
       执行 / 回执确认 / 冷却锁 / 超时轮询的状态机已抽到 model/sceneRunner.js +
       composables/useSceneRunner.js，与 PC 大屏共用同一份实现（setup 里注入 toast）。
       本页只需在 HA 推送时调 checkSceneWatchers()、卸载时 disposeScenes()。 */

    /* ---------------- 视图开关 ---------------- */

    toggleRotate() {
      /* 同一次点按可能被派发两次（窄屏 pointerup 已提交 + 某些手机浏览器/WebView
         仍补一个合成 click）。两次都执行 = 开完立刻关，提示恒为「已关闭」，
         用户看到的就是「点了没反应」。250ms 内的重复调用一律当作同一次点击。 */
      const now = Date.now();
      if (now - (this._rotAt || 0) < 250) return;
      this._rotAt = now;

      /* 以引擎里的意图为基准取反，而不是本地 this.autoRotate ——
         万一两者不同步，按本地值取反仍会出现「点了还是不转」。 */
      const on = !View3D.autoRotateOn;
      this.autoRotate = on;
      prefSetBool(PREF_KEYS.autoRotate, on);

      /* 用户此刻的意图优先级最高：还挂着的平滑取景 / 飞行动画必须立刻让位。
         它们每帧都会写 camera.position，如果不先停掉，开了自转也会被逐帧盖回去 ——
         这正是「点了没反应，切一次主题才好」的表现（主题切换触发的那次 resize 顺带
         把卡住的取景停掉了）。 */
      this._smoothStop(false);
      if (View3D.cancelFly) View3D.cancelFly();
      View3D.setAutoRotate(on);
      /* 回读引擎值：开关亮灭与引擎真实状态永远同源，提示也就不会骗人 */
      this.autoRotate = View3D.autoRotateOn;
      this.toastMsg(this.autoRotate ? '自动旋转已开启' : '自动旋转已关闭');
    },

    toggleLabels() {
      /* 标签开关骨架（翻转/持久化/重拨顺序单一出处，审计 2.17）：
       * 展示页独立键 panelShowLabels，与编辑页互不影响。 */
      this.toggleLabelsCore(PREF_KEYS.panelShowLabels,
        () => this.applyStageMode(),
        () => this.toastMsg(this.showLabels
          ? '已显示标签：点标签执行，点设备查看卡片'
          : '已隐藏标签：点设备执行动作'));
    },

    fullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    },

    toastMsg(text, ms) {
      this.toast = text;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.toast = ''; }, ms || 1600);
    },

    /* ------- 手势体系 -------
     * _stageEnsure / _setStageH / _bandRefocus / syncStageBandForViewport /
     * onStageTouchStart / _sampleMove / onStageTouchMove / _stageGesture /
     * onStageTouchEnd / onStageTouchCancel / _endStageGesture / _flingStop /
     * _startFling / _flingFinish / onStageWheel
     * 已拆到 composables/usePanelGesture.js（文件头 import 处摊进 methods）。
     * 事件绑定仍在 mounted/beforeUnmount（passive 选项成对出现）；
     * 纯计算前置在 model/panelGesture.js / model/tapGesture.js（可 Node 单测）。 */

    /* 3D 场景模式：标签显隐 ⇔ 点击语义（与 EditApp 共用 useSceneMode 底座）。
       唯一特例：index 窄屏强制隐藏标签（顶栏标签开关在窄屏也隐藏），于是自然落到
       「点设备 = 直接执行动作」；宽屏按本机 showLabels 偏好决定，关掉标签同样是执行。 */
    applyStageMode() {
      const narrow = !isWideViewport(window.innerWidth, window.innerHeight);
      const labels = !narrow && this.showLabels;
      this.applySceneCore(labels, labels ? this.sel : null);
      if (narrow) {
        /* 旋转照常保留：压缩手势只接管羽化层及其以下（见 onStageTouchStart 的分区判定）。
           显式置 true 也清掉旧版本可能残留在运行页面里的 enableRotate=false。 */
        if (View3D.controls) View3D.controls.enableRotate = true;
      }
    },

    /* 窗口尺寸变化：断点跨越时整体重取景一次（飞行动画）；同一断点内拖宽/拖窄
       走平滑逼近模式持续跟手（指数收敛、新目标不断覆盖，无跳变），松手后自然
       收敛到最后一次尺寸的目标 —— 不需要额外的「收尾重算」，也就没有收尾跳变。 */
    onViewportChange() {
      if (typeof View3D === 'undefined' || !View3D.resize) return;
      this._visH = null;                   // 窗口尺寸变了：缓存的显示区域高度作废
      View3D.resize();
      const narrow = !isWideViewport(window.innerWidth, window.innerHeight);
      this.syncStageBandForViewport();
      if (narrow !== this._narrow) {      // 窄/宽互换：按新可视区重新取景（带动画），并切展示/可点模式
        this._narrow = narrow;
        this.refocus(true);
        this.applyStageMode();
      } else if (!this._resizeRaf) {
        /* 同一断点内拖动：按帧节流，保留当前视角方向只改视距（不然每拖一下机位就被重置） */
        this._resizeRaf = requestAnimationFrame(() => {
          this._resizeRaf = 0;
          this.refocus(false, true, true);
        });
      }
    },
  },

  mounted() {
    /* 启动兜底：init 三段任一步抛错（目录/项目/插件/3D 初始化失败等）不再静默 ——
     * 立即 toast 可见提示；HA 配置失败已在 ha store 的 loadConfig 内部兜底。 */
    this.init().catch((e) => {
      console.error('[panel] 启动失败:', e);
      this.toastMsg('页面加载失败：' + ((e && e.message) || e));
    });
    window.addEventListener('resize', this.onViewportChange);
    /* 手势接在 document 上并显式 passive:false（条件式 preventDefault 必须可生效）；
       用 target.closest('.p-shell') 过滤，v-if="project" 的晚挂载也能接到。 */
    document.addEventListener('touchstart', this.onStageTouchStart, { passive: true });
    document.addEventListener('touchmove', this.onStageTouchMove, { passive: false });
    /* touchend 也要 non-passive：滚动过的手势要能 preventDefault 压住补发的 click
       （v-tap 之外的兜底，见 _endStageGesture）。 */
    document.addEventListener('touchend', this.onStageTouchEnd, { passive: false });
    document.addEventListener('touchcancel', this.onStageTouchCancel, { passive: true });
    document.addEventListener('wheel', this.onStageWheel, { passive: false });
    this.syncStageBandForViewport();
    /* 用户手动拖动/缩放 3D 时立刻停掉平滑逼近，把相机还给 OrbitControls */
    if (View3D.controls) {
      this._onUserOrbit = () => this._smoothStop(false);
      View3D.controls.addEventListener('start', this._onUserOrbit);
    }
  },

  beforeUnmount() {
    window.removeEventListener('resize', this.onViewportChange);
    document.removeEventListener('touchstart', this.onStageTouchStart);
    document.removeEventListener('touchmove', this.onStageTouchMove);
    document.removeEventListener('touchend', this.onStageTouchEnd);
    document.removeEventListener('touchcancel', this.onStageTouchCancel);
    document.removeEventListener('wheel', this.onStageWheel);
    if (View3D.controls && this._onUserOrbit) View3D.controls.removeEventListener('start', this._onUserOrbit);
    this._flingStop();               // 内部同时清掉 gestureState.flingRunning
    beginGesture();
    this._smoothStop(false);
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    if (this._bandRaf) cancelAnimationFrame(this._bandRaf);
    clearTimeout(this._toastTimer);
    this.disposeScenes();          // 场景回执轮询 / ✓ 反馈定时器由共用状态机统一清理
    /* 引擎级卸载出口（审计 3.7）：渲染 RAF / resize / HA change / debug 定时器等
     * 模块级监听此前只有注册没有移除，两页根组件卸载时统一收口 */
    disposeEngine();
  },
};
</script>

<style scoped>
/* 整页是一块连续的面：3D 画布铺满全屏当背景（尺寸不变），内容浮在它上面。
   白底只出现在内容侧，并朝 3D 方向羽化 —— 不整屏盖白纱（会发灰）。
   各内容块的皮肤随组件走（components/pages/panel/*.vue）；这里只留版面骨架。 */
.p-shell {
  --p-band: .38;                       /* 窄屏 3D 预览窗口占屏高的比例（压缩手势由 JS 写内联值；画布尺寸不变） */
  position: relative; isolation: isolate;
  height: 100dvh; min-height: 0; overflow: hidden;
  display: grid; gap: 8px; padding: 10px;
  grid-template-columns: minmax(0, 1fr);
  /* 窄屏：顶栏浮在 3D 带上（不占行高），3D 带从页面顶端算起 ——
     这样 --p-band 才是「真正的可视带」，楼层按钮和场景行之间不会空出一段。 */
  grid-template-rows: minmax(0, calc(var(--p-band) * 100dvh)) auto auto minmax(0, 1fr);
  grid-template-areas: "stage" "scenes" "rooms" "cards";
  /* 画布是透明的，天空就是这层 CSS 兜底底色；夜间由 --sky 换成深色夜空。
     不删除它 —— 没有兜底会露出浏览器纯白，反而更亮。 */
  background: var(--sky);
  color: var(--ink);
}

/* ---------- 提示 / 空态 ---------- */
.p-toast {
  position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
  padding: 8px 16px; border-radius: 999px; font-size: 12px; color: #fff;
  background: rgba(31, 39, 51, .9); box-shadow: 0 4px 14px rgba(20, 30, 50, .22); z-index: 60;
}
/* 重连轻提示：跟顶栏同一条安全区基线，往下 58px 避开 40px 的房子图标；
   纯展示不拦点击（pointer-events:none），连上后 status 变 connected 自动消失。 */
.p-reconn {
  position: fixed; left: 50%; transform: translateX(-50%);
  top: calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 58px);
  z-index: 55; display: flex; align-items: center; gap: 8px;
  padding: 6px 14px; border-radius: 999px; font-size: 12px; color: var(--ink);
  background: var(--paper);
  box-shadow: 0 4px 16px rgba(20, 30, 50, .16);
  pointer-events: none;
}
.p-reconn .spin { width: 12px; height: 12px; border-width: 2px; }
.p-empty {
  height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; color: var(--ink2); font-size: 14px;
}
.p-empty a { color: var(--blue); font-size: 13px; }

/* JS 接管手势时（窄屏 + app 宽屏 TV 模式）关掉浏览器原生触摸滚动，
   否则 WebView 原生与 JS 分发抢手势，卡片滑不动。PC 浏览器宽屏无此 class，
   原生触摸照常；鼠标滚轮由 onStageWheel 无条件接管，不受 touch-action 影响。 */
.p-shell.p-touch-js { touch-action: none; }

/* ---------- 窄屏：内容区坐一张白纸，纸上沿向 3D 羽化 ---------- */
/* 窄屏 = 宽屏判据的逻辑非，必须与上面的宽屏 media query 严格互斥，否则
   768~1023 的横屏窗口会两套同时命中：窄屏 ::after 的 left:0/right:0 会漏进宽屏，
   把右侧羽化面板拉成左侧一整块黑纱。三行逗号 = OR：
   W<768；或 W<1024 且 H<450；或 W<1024 且宽高比<1.3（13/10）。 */
@media (max-width: 767px), (max-width: 1023px) and (max-height: 449px), (max-width: 1023px) and (max-aspect-ratio: 1299/1000) {
  /* 纵向手势由 JS 完整接管（压缩 3D 带 → 卡片内滚），否则浏览器原生滚动会在
     「压到最小高度后继续滚卡片」这一步抢走手势；横向滚动也在 JS 里手动分发。 */
  .p-shell { touch-action: none; }
  /* 白纸从 3D 带下沿往上一点点开始，用 mask 把「白色 + 背景模糊」一起向上渐隐：
     羽化带正好落在「楼层 / 场景 / 全屋·房间」这几行上，边界是化开的，不是切开的。 */
  .p-shell::after {
    content: ''; position: absolute; z-index: 0; pointer-events: none;
    left: 0; right: 0; bottom: 0; top: calc(var(--p-band) * 100dvh - 18px);
    background: var(--paper);
    backdrop-filter: blur(16px) saturate(1.04); -webkit-backdrop-filter: blur(16px) saturate(1.04);
    -webkit-mask-image: linear-gradient(180deg, transparent 0, rgba(0, 0, 0, .55) 46px, #000 100px);
    mask-image: linear-gradient(180deg, transparent 0, rgba(0, 0, 0, .55) 46px, #000 100px);
  }
}

/* ---------- 宽屏：3D 铺满 / 右竖栏玻璃面板（上右下贴边，不留页边距） ---------- */
@media (min-width: 1024px), (min-width: 768px) and (min-height: 450px) and (min-aspect-ratio: 13/10) {
  .p-shell {
    gap: 14px; padding: 0;
    grid-template-columns: minmax(0, 1fr) 340px;
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas: "head scenes" "stage rooms" "stage cards";
  }
  /* 右栏的薄白底：右侧/上/下都是实的贴边，只有左侧羽化融进 3D（不是一块硬边白板，
     也不是盖满全屏的白纱）。用 mask 把「白色 + 背景模糊」一起羽化，边界才真的是渐隐。 */
  .p-shell::after {
    content: ''; position: absolute; z-index: 0; pointer-events: none;
    top: 0; right: 0; bottom: 0; width: 480px;              /* 340 竖栏 + 140 羽化带 */
    border-radius: 18px 0 0 18px;                           /* 贴边的一侧不做圆角 */
    background: var(--paper-wide);
    backdrop-filter: blur(18px) saturate(1.06); -webkit-backdrop-filter: blur(18px) saturate(1.06);
    -webkit-mask-image: linear-gradient(90deg, transparent 0, rgba(0, 0, 0, .3) 12%, #000 28%);
    mask-image: linear-gradient(90deg, transparent 0, rgba(0, 0, 0, .3) 12%, #000 28%);
  }
}
</style>

<style>
/* 转圈是 StageSurface（切层遮罩）与 SceneStrip（场景执行中）共用的小工具类：
   放在非 scoped 块里一次定义，用 .p-shell 限定作用域，不污染编辑页。 */
.p-shell .spin {
  display: inline-block; width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid rgba(31, 39, 51, .18); border-top-color: var(--on-ink);
  animation: pspin .8s linear infinite;
}
.p-shell .p-floor-load .spin { width: 26px; height: 26px; border-width: 3px; }
@keyframes pspin { to { transform: rotate(360deg); } }
</style>
