<template>
  <div class="p-shell" v-if="project">
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
import { bootStageData, waitForPaint, waitForCardsReady, startStage3D, DEFAULT_CAM } from './composables/useStageBoot';
import { selOfPick, applySceneMode as syncSceneMode, applyPickHi } from './model/pick';
import { PREF_KEYS, prefBool, prefSetBool, prefInt, prefSetInt } from './services/prefs';

/* 版面 / 取景 / 手势的全部常量集中在 model/stageLayout.js（JS 侧唯一出处）。
 * CSS 里的 1024 / 340 / .38 无法引用 JS，改动时须两边同步。 */
import {
  WIDE_BREAKPOINT, STAGE_BAND_INIT,
  FILL_STAGE_WIDE, FILL_STAGE_INIT, FILL_STAGE_GAIN,
  FILL_ROOM_WIDE, FILL_ROOM_GAIN, SMOOTH_K,
} from './model/stageLayout';
/* 阶段 0：纯计算搬到 model/ 下（零 Vue/DOM/THREE，可 Node 单测），本文件只留副作用壳 */
import {
  stageBounds, splitVerticalGesture, sampleMove, flingVelocity, nextFlingVelocity, flingFrameDt,
} from './model/panelGesture';
/* 窄屏点按判定：滚动是 JS 分发的，浏览器仍会合成 click。这里把「本次手势是否
   已经滚动」「惯性是否还在跑」写成唯一真相，v-tap 在抬手时读它决定要不要提交。 */
import {
  gestureState, beginGesture, markGestureMoved, setFlingRunning, tapExceedsMove,
} from './model/tapGesture';
import {
  stageMetricsOf, viewOffsetOf, fitScaleOf, fitDistanceOf, screenBoundsOf,
} from './model/panelCamera';

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
    /* 选中项 → 3D 高亮（房间地面提色 / 设备圆环），让「卡片里是谁」在场景里也有锚点 */
    sel(v) { applyPickHi(View3D, v, true); },
  },

  computed: {
    ...mapState(useHaStore, ['haStatus']),
    /* 版面模式统一从 ui store 取（原 data().wide 已删）：卡片控件的交互模式、
       窄屏手势白名单、本页 HUD 与取景共用同一份真相，跨断点不会出现
       「页面已放行手势但组件还在点选态」的错位。 */
    ...mapState(useUiStore, { wide: 'viewportWide' }),

    /* 回前台 / 断线后正在重连：以前页面完全没有反馈，只会显得「卡住几秒」。
     * 只认 status 事件里的 retrying 标志，首屏连接中不会弹这条。 */
    reconnecting() { return !!(this.haStatus.retrying && this.haStatus.status === 'connecting'); },

    cur() { return this.project ? this.project.floors[this.floorIdx] : null; },
    floors() { return (this.project && this.project.floors) || []; },

    /* 是否允许使用空壳原生桥：只看 AppShell 是否存在 —— 原生桥只在壳的 WebView 里
       注入，普通浏览器恒 undefined，不会误触发；URL 无需追加任何参数 */
    inApp() { return typeof window !== 'undefined' && !!window.AppShell; },

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
       useDisplayDerived() 提供，不再在本页各写一份 + void entVersion。 */
  },

  methods: {
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

    /* 窄屏「显示区域」= 展示项条（.p-scenes）以上的整块，DOM 实测而不是拿 --p-band 换算：
       顶栏是浮层、展示项行在白纸上，中间露出的那一段才是真正能看见 3D 的地方。
       压缩手势改 --p-band 后布局随之重排，这里缓存一次、由改高度的地方置空失效，
       避免取景迭代 / 平滑器每帧都去强制同步重排。展示项为空时退到 .p-rooms 顶边。 */
    _visibleH(H, wide) {
      if (wide) return H;
      if (this._visH != null) return this._visH;
      const shell = this._shell || document.querySelector('.p-shell');
      const anchor = shell && (shell.querySelector('.p-scenes') || shell.querySelector('.p-rooms'));
      let h = 0;
      if (anchor && shell) {
        h = Math.round(anchor.getBoundingClientRect().top - shell.getBoundingClientRect().top);
      }
      const band = this._stageFrac != null ? this._stageFrac : STAGE_BAND_INIT;
      this._visH = h > 40 ? h : Math.max(1, Math.round(H * band));
      return this._visH;
    },

    /* 3D 画布铺满整页、尺寸永远不变；「可视区」是白纸羽化层之上还露着的那一条带：
       宽屏 = 左列（右侧 340 竖栏占掉），窄屏 = 场景列表以上的整块显示区域。
       手指上滑时白纸及以下整体上移，显示区域随之变矮；这里按上滑量算出剩余高度，
       让 alignStageView 用 setViewOffset 把房子/房间平移到剩余可视区的正中间，
       再按剩余高度重新取景 —— 全程只动相机，不动画布、不 resize。 */
    stageMetrics() {
      const W = window.innerWidth || 1, H = window.innerHeight || 1;
      const wide = W >= WIDE_BREAKPOINT;
      /* 纯计算在 model/panelCamera.js；DOM 实测 / 缓存值从这里注入 */
      return stageMetricsOf({
        W, H,
        visibleH: this._visibleH(H, wide),
        stageFrac: this._stageFrac,
        stageMin: this._stageMin,
        defaultDist: DEFAULT_CAM.dist,
      });
    },

    /* 把「画面中心」挪到可视区中心：用相机的 view offset（只平移视锥），
       不动 camera.position / controls.target —— 旋转中心必须留在房子或房间的正中心，
       否则自转时房子会绕着旁边一个空点画圈。 */
    alignStageView() {
      const m = this.stageMetrics();
      const cam = View3D.camera;
      if (!cam) return;
      /* 第一项 = 把房子从「整页画布中心」平移到「剩余可视区中心」；_fitDy 是包围盒
         投影重心的透视修正，由平滑器逐帧逼近（见 model/panelCamera.js viewOffsetOf）。 */
      const { dx, dy } = viewOffsetOf(m, this._fitDy);
      if (!dx && !dy) {
        if (cam.clearViewOffset) cam.clearViewOffset();
        return;
      }
      cam.setViewOffset(m.W, m.H, -dx, -dy, m.W, m.H);
      cam.updateProjectionMatrix();
    },

    /* 把 box 完整塞进「可视区」所需的相机距离。
       按当前视角方向把 8 个角投影到屏幕基向量上算实际宽高（不用包围球 ——
       户型又扁又宽，包围球会把距离算大、房子显小），再按可视区的半角换算。
       fill = 目标占可视区的比例（0.9 ≈ 铺满九成，四分之三以上）。 */
    fitDistance(box, dir, fill, depthK) {
      const T = window.THREE, cam = View3D.camera, m = this.stageMetrics();
      if (!T || !cam || !box || box.isEmpty()) return m.dist;
      /* 按当前视角方向把 8 个角投影到屏幕基向量上算实际宽高（不用包围球 ——
         户型又扁又宽，包围球会把距离算大、房子显小），再交给纯函数换算成视距。 */
      const fwd = dir.clone().normalize().negate();   // dir 是「目标→相机」，视线取反
      const upW = Math.abs(fwd.y) > 0.98 ? new T.Vector3(0, 0, 1) : new T.Vector3(0, 1, 0);
      const right = new T.Vector3().crossVectors(fwd, upW).normalize();
      const up = new T.Vector3().crossVectors(right, fwd).normalize();
      const c = box.getCenter(new T.Vector3());
      const p = new T.Vector3();
      let hw = 0, hh = 0, hd = 0;
      for (let i = 0; i < 8; i++) {
        p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
        hw = Math.max(hw, Math.abs(p.dot(right)));
        hh = Math.max(hh, Math.abs(p.dot(up)));
        hd = Math.max(hd, Math.abs(p.dot(fwd)));
      }
      /* depthK 与半角换算都在 model/panelCamera.js fitDistanceOf（纯函数、可单测） */
      return fitDistanceOf({
        hw, hh, hd,
        fov: cam.fov, contentW: m.contentW, contentH: m.contentH, canvasH: m.H,
        fill, depthK,
      });
    },

    /* 完整显示优先：全屋 / 房间的包围盒必须整个落在显示区内，不能上下裁切。
       分别算「按宽度填满」「按高度填满」各自的缩放系数，取较大的那个（谁紧谁定大小），
       另一个方向自然留白 —— 这就是完整可见约束下能达到的最大尺寸。
       想再大只能抬高 fill：由 fitStage / fitRoom 按 squeeze 渐进把留白压到最少
       （初始 0.88 → 最矮 0.96），压得越矮房子越贴边但始终不出界。 */
    fitScale(probe, m, fill) {
      return fitScaleOf(probe, m, fill);
    },

    /* 默认取景：按「整栋房子的包围盒」塞满可视区，再把视锥对到可视区中心。
       animate = true 时用相机飞行过渡（房间 → 全屋 也要有动效，不能硬切）。
       keepDir = true 时保留用户当前视角方向，只改视距 —— 拖窗口改尺寸时用，
       否则每拖一像素就回到默认机位，用户的旋转会被吃掉。 */
    /* 按当前选中范围（全屋 / 某房间）重新取景：断点切换、切层回全屋、拖动改窗口都走这里，
       保证任何可视区变化后相机都重新「塞满」目标 */
    refocus(animate, keepDir, smooth) {
      const sel = this.sel;
      if (sel && sel.kind === 'room' && sel.id) this.fitRoom(sel.id, animate, smooth);
      else this.fitStage(animate, keepDir, smooth);
    },

    /* ---- 平滑取景（拖窗口跟手 / 收尾都走这里，指数逼近不跳变） ----
       fitStage / fitRoom 算出目标机位后不直接落相机，而是交给 _desireFit：
       每帧向目标指数逼近（拖动时新目标不断覆盖，画面始终连续），收敛后精确落位。
       期间关掉 damping / autoRotate（它们会和我们逐帧赋值打架），用户一上手就还原。 */
    _desireFit(pos, target, dy) {
      const cam = View3D.camera, ctl = View3D.controls;
      if (!cam || !ctl) return;
      if (View3D.cancelFly) View3D.cancelFly();          // 飞行动画让位给平滑逼近
      if (!this._camGoal) {                               // 首次进入：暂存并关掉交互态
        this._smoothDamping = ctl.enableDamping;
        View3D.holdAutoRotate(true);                      // 只是按住，不改意图（收尾按意图恢复）
        ctl.enableDamping = false;
      }
      this._camGoal = { pos: pos.clone(), target: target.clone(), dy: dy || 0 };
      this._smoothT0 = performance.now();                 // 收尾硬超时的起点（见 _smoothTick）
      if (!this._smoothRaf) this._smoothRaf = requestAnimationFrame(() => this._smoothTick());
    },

    _smoothStop(apply) {
      const ctl = View3D.controls;
      /* 收尾一律按「用户选择」而不是进入平滑前的快照：平滑期间用户完全可能点了
         旋转按钮，用快照会把这次选择按回 false（点了没反应）。
         hold 只在真结束一段平滑时放开，和 _desireFit 一一对应。 */
      View3D.holdAutoRotate(false);
      if (ctl && this._camGoal) {
        View3D.setAutoRotate(this.autoRotate);
        ctl.enableDamping = this._smoothDamping;
        if (apply) ctl.update();
      }
      this._camGoal = null;
      if (this._smoothRaf) { cancelAnimationFrame(this._smoothRaf); this._smoothRaf = 0; }
    },

    _smoothTick() {
      const g = this._camGoal;
      const cam = View3D.camera, ctl = View3D.controls;
      if (!g || !cam || !ctl) { this._smoothRaf = 0; return; }
      const k = SMOOTH_K;                                 // 每帧按常量比例逼近：跟手且连续
      cam.position.lerp(g.pos, k);
      ctl.target.lerp(g.target, k);
      this._fitDy = (this._fitDy || 0) + (g.dy - (this._fitDy || 0)) * k;
      this.alignStageView();
      /* 收敛判定 + 硬超时兜底：`g.dy` 会随可视区变化反复刷新，极端情况下（软键盘/
         浏览器工具栏收放抖动）收敛条件可能一直不满足，这个循环就会逐帧钉住
         camera.position —— 用户开了自转也看不出在转。超过 1.5s 直接落位收尾。 */
      const timedOut = performance.now() - (this._smoothT0 || 0) > 1500;
      if (timedOut
        || (cam.position.distanceToSquared(g.pos) < 4e-4
          && ctl.target.distanceToSquared(g.target) < 1e-4
          && Math.abs(g.dy - (this._fitDy || 0)) < 0.5)) {
        cam.position.copy(g.pos);                         // 收敛：精确落位
        ctl.target.copy(g.target);
        this._fitDy = Math.round(g.dy);
        this.alignStageView();
        this._smoothStop(true);
        return;
      }
      this._smoothRaf = requestAnimationFrame(() => this._smoothTick());
    },

    /* 取景收敛公共段（fitStage / fitRoom 共用）：
       起始视距由调用方解析式估初值，这里按「实测投影占比」迭代修正（透视近端放大，
       解析式在宽屏左列 / 窄屏上带两种可视区下误差不同，直接量投影最省事，收敛很快）；
       循环结束必须按最终 dist 重算一次 probe —— 否则竖直微调用的是上一轮过期数值
       （曾经踩过：房间整体偏下 80px）；最后按 smooth（平滑逼近）/ animate（flyTo）/ 瞬跳落位。 */
    _convergeFit(box, dir, target, dist, minDist, fill, animate, smooth) {
      const m = this.stageMetrics();
      let probe = null;
      for (let i = 0; i < 6; i++) {
        probe = this.probeBox(box, dir, target, dist);
        if (!probe) break;
        const r = this.fitScale(probe, m, fill);
        if (Math.abs(r - 1) < 0.03) break;
        dist = Math.max(minDist, dist * r);
      }
      probe = this.probeBox(box, dir, target, dist) || probe;
      /* 竖直微调：让实测的包围盒中心落在可视区中心（透视下近端下沉的那部分补回来） */
      const dy = probe ? -Math.round(probe.cy - m.H / 2) : 0;
      const pos = target.clone().addScaledVector(dir, dist);
      if (smooth) { this._desireFit(pos, target, dy); return; }   // 平滑逼近，不瞬跳
      this._fitDy = dy;
      if (animate && View3D.flyTo) View3D.flyTo(pos, target, 760);
      else View3D.frame({ pos: [pos.x, pos.y, pos.z], target: [target.x, target.y, target.z] });
      this.alignStageView();
    },

    fitStage(animate, keepDir, smooth) {
      const m = this.stageMetrics();
      const T = window.THREE;
      this._smoothStop(false);           // 新取景开始：停掉正在进行的平滑逼近，避免两套相机写入打架
      this._narrow = !m.wide;
      const cam = View3D.camera, ctl = View3D.controls;
      let dir;
      if (keepDir && cam && ctl) {
        dir = cam.position.clone().sub(ctl.target);
        if (dir.lengthSq() < 1e-6) dir.set(DEFAULT_CAM.dir[0], DEFAULT_CAM.dir[1], DEFAULT_CAM.dir[2]);
      } else {
        dir = new T.Vector3(DEFAULT_CAM.dir[0], DEFAULT_CAM.dir[1], DEFAULT_CAM.dir[2]);
      }
      dir.normalize();
      const box = (T && View3D.root) ? new T.Box3().setFromObject(View3D.root) : null;
      if (!box || box.isEmpty()) {
        View3D.frame({ dir: DEFAULT_CAM.dir, dist: m.dist });
        this.alignStageView();
        return;
      }
      const c = box.getCenter(new T.Vector3());
      const target = new T.Vector3(c.x, c.y + 0.5, c.z);
      let dist = this.fitDistance(box, dir, 0.95);
      /* 画布高度随压缩变化，解析式在这两种比例下误差不同；统一走 _convergeFit 实测迭代。
         fill 渐进抬高（窄屏压缩越狠填充越满）；最高 0.96 留 4% 安全边距，
         吸收透视近端放大与居中取整误差，绝不顶出边界。 */
      const fill = m.wide ? FILL_STAGE_WIDE : FILL_STAGE_INIT + FILL_STAGE_GAIN * m.squeeze;
      this._convergeFit(box, dir, target, dist, 1, fill, animate, smooth);
    },

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

    /* 临时相机试算：把包围盒 8 个角投影到画布，返回屏幕上的宽高与中心。
       为什么要试算：透视会让近端放大，解析公式在「宽屏左列」和「窄屏上带」两种
       可视区下误差比例不一样（同一套系数没法两边都对），直接量投影最省事。 */
    probeBox(box, dir, target, dist) {
      const T = window.THREE, cam = View3D.camera, m = this.stageMetrics();
      if (!T || !cam) return null;
      const c = cam.clone();
      if (c.clearViewOffset) c.clearViewOffset();     // 视锥偏移只改画面位置，不影响尺寸，先清掉
      c.position.copy(target).addScaledVector(dir, dist);
      c.up.set(0, 1, 0);
      c.lookAt(target);
      c.updateMatrixWorld(true);
      c.updateProjectionMatrix();
      const p = new T.Vector3();
      const points = [];
      for (let i = 0; i < 8; i++) {
        p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(c);
        points.push({ x: p.x, y: p.y });
      }
      return screenBoundsOf(points, m.W, m.H);
    },

    /* 房间取景：迭代把房间包围盒「投影占比」校到填充率（宽/高谁是限制项由 fitScale 判），
       并按实测中心做竖直微调。
       不用引擎的 View3D.focusRoom：它按整块画布算视距和中心，这里是整页画布 + 剩余可视区。 */
    fitRoom(id, animate, smooth) {
      const T = window.THREE;
      this._smoothStop(false);           // 新取景开始：停掉正在进行的平滑逼近
      const mesh = T && View3D.roomPickGroups
        ? View3D.roomPickGroups.find((x) => x.userData.room && x.userData.room.id === id)
        : null;
      const cam = View3D.camera, ctl = View3D.controls;
      if (!mesh || !cam || !ctl) { View3D.focusRoom(id); return; }   // 兜底：交给引擎

      const m = this.stageMetrics();
      const box = new T.Box3().setFromObject(mesh);
      /* 房间拾取体只是地板，墙是另外的网格：把墙高补进包围盒，
         否则按地板取景时四周墙面会被顶出画面（看着像镜头扎进房间里）。 */
      box.max.y = Math.max(box.max.y, box.min.y + (View3D.wallH || 2.8));
      const ctr = box.getCenter(new T.Vector3());
      /* 观察点 = 房间中心（旋转中心/自转锚点跟着它，不再用长按设的自定义锚点） */
      const target = new T.Vector3(ctr.x, ctr.y, ctr.z);
      const dir = cam.position.clone().sub(ctl.target);
      if (dir.lengthSq() < 1e-6) dir.set(DEFAULT_CAM.dir[0], DEFAULT_CAM.dir[1], DEFAULT_CAM.dir[2]);
      dir.normalize();
      if (dir.y < 0.45) { dir.y = 0.45; dir.normalize(); }           // 太贴水平会看不见房间内部

      /* 起始距离用解析式估个初值，收敛与竖直微调统一走 _convergeFit。
         depthK 用默认 0.6（房间是透视盒，深度补偿要足，见 panelCamera.js fitDistanceOf
         的注释）—— 初值只影响迭代轮数，probe 会双向修正到实测占比。 */
      const fill = m.wide ? FILL_ROOM_WIDE : FILL_ROOM_WIDE + FILL_ROOM_GAIN * m.squeeze;
      const dist = this.fitDistance(box, dir, 0.8, 0.6);
      this._convergeFit(box, dir, target, dist, 0.8, fill, animate, smooth);
    },

    async onCardAct(node, value) {
      try {
        const r = await this.runCard(node, value);
        if (!r && node.action) this.toastMsg('该动作没有可用的服务配置');
      } catch (e) {
        this.toastMsg('操作失败：' + (e && e.message ? e.message : e));
      }
    },

    onHAChange() {
      /* 实体版本由 bridge.js 统一写进 ha store，派生 computed 自动重算，本页不再自己 ++ */
      this.checkSceneWatchers();
      View3D.refresh();
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
      this.showLabels = !this.showLabels;
      /* 标签显隐 ⇔ 点击语义，必须一起切（见 model/pick.js 的 applySceneMode）。
         窄屏由 applyStageMode 强制不给标签，开关本身也在 CSS 里隐藏。 */
      this.applyStageMode();
      prefSetBool(PREF_KEYS.panelShowLabels, this.showLabels);   // 展示页独立键，与编辑页互不影响
      this.toastMsg(this.showLabels
        ? '已显示标签：点标签执行，点设备查看卡片'
        : '已隐藏标签：点设备执行动作');
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

    /* ---------------- 窄屏：3D 可视带可被上滑压缩 ----------------
       初始高度沿用 CSS 的 --p-band(.38)；手指上滑时按 1:1 跟随压缩，压到最小高度后
       剩余手势交给 .p-cards-body 原生滚动；下滑时反向：卡片先滚回顶部，再放开 3D 带。
       高度只改一个 CSS 变量：网格行、白纸羽化起点、楼层按钮、构图(stageMetrics)都读它。 */

    _stageEnsure() {
      const H = window.innerHeight || 1;
      const shell = document.querySelector('.p-shell');
      if (!shell) return false;
      this._shell = shell;
      this._cards = shell.querySelector('.p-cards-body') || null;
      const { max, min } = stageBounds(H);
      if (this._stageMax !== max || this._stageMin !== min) {
        const frac = this._stageFrac || STAGE_BAND_INIT;
        this._stageMax = max;
        this._stageMin = min;
        this._stageH = Math.max(min, Math.min(max, Math.round(H * frac)));
        this._stageFrac = this._stageH / H;   // 视口高度变了也保持 JS 与 CSS 同一个占比
      }
      return true;
    },

    /* 上滑只改 --p-band：白纸羽化层及以下整体上移，3D 画布尺寸不变、不 resize。
       _stageFrac 是上滑量换算出的「剩余可视高度占比」；stageMetrics 据此实测显示区域，
       用代码把房子平移过去并按新的宽高比重取景 —— 全程只动相机。 */
    _setStageH(px, quick) {
      const H = window.innerHeight || 1;
      const h = Math.max(this._stageMin, Math.min(this._stageMax, Math.round(px)));
      if (h === this._stageH) return false;
      this._stageH = h;
      this._stageFrac = h / H;
      if (this._shell) this._shell.style.setProperty('--p-band', String(this._stageFrac));
      this._visH = null;                   // 白纸/场景行位置变了：下一帧重新实测显示区域
      /* quick = 惯性阶段：每帧都 alignStageView + refocus 会在手机上掉帧，
         这里只改 CSS 变量，惯性收尾时由 _flingFinish() 统一补一次构图。 */
      if (quick) { this._bandDirty = true; return true; }
      this._bandRefocus();
      return true;
    },

    /* 重取景统一入口（_bandRaf 防抖：同帧多次改高度只算一次） */
    _bandRefocus() {
      this._bandDirty = false;
      if (this._bandRaf) return;
      this._bandRaf = requestAnimationFrame(() => {
        this._bandRaf = 0;
        this.alignStageView();            // 房子中心 1:1 跟手挪到新的显示区中心
        this.refocus(false, true, true);  // 平滑重取景：保留方向，按新宽高比调填充率
      });
    },

    /* 断点/视口变化：宽屏清掉内联变量（宽屏布局不用这条带）；窄屏按原比例重建上下限 */
    syncStageBandForViewport() {
      this._visH = null;                   // 断点/视口变化：显示区域 DOM 位置要重测
      if (this.wide) {
        this._flingStop();                   // 断点变了：JS 接管的手势/惯性都不再适用
        if (this._shell) this._shell.style.removeProperty('--p-band');
        return;
      }
      if (!this._stageEnsure()) return;
      const H = window.innerHeight || 1;
      /* 与 stageMetrics 共用同一个「剩余高度占比」，CSS 白纸位置与相机构图不会各算一套 */
      const frac = (this._stageH || this._stageMax) / H;
      this._stageFrac = frac;
      this._shell.style.setProperty('--p-band', String(frac));
    },

    onStageTouchStart(e) {
      /* 任何新的触摸（包括点按卡片控件）都先打断惯性 —— 原生列表也是「按住即停」 */
      this._flingStop();
      /* 新的一轮触摸：清掉上一次的「已滚动」标记。v-tap 的 pointerdown 早于
         touchstart，它快照的是惯性状态，两处时序互不干扰。 */
      beginGesture();
      if (this.wide || !e.touches || e.touches.length !== 1) return;
      const shell = (e.target instanceof Element) ? e.target.closest('.p-shell') : null;
      if (!shell) return;
      /* 卡片滑块（CardRange.vue 自绘 range）只放行「按在把手上」的触摸：命中半径读
         .dc-slider 的 data-hit，与组件同一个值。按在轨道其它位置不响应、也不改值，
         仍要交回页面手势滚卡片，所以不能整块放行；禁用态同样交回。 */
      const sl = (e.target instanceof Element) ? e.target.closest('.dc-slider') : null;
      if (sl && sl.getAttribute('aria-disabled') !== 'true') {
        const th = sl.querySelector('.dc-thumb');
        const r = th && th.getBoundingClientRect();
        const t0 = e.touches && e.touches[0];
        const hit = Number(sl.dataset.hit || 20);
        if (r && t0 && Math.abs(t0.clientX - (r.left + r.width / 2)) <= hit) {
          this._gesture = null;
          return;
        }
      }
      /* 卡片选项组（CardChoice.vue 窄屏滑动版）：组件只在「窄屏 + 可用」时给
         .dc-choice 挂 data-slide，命中即代表它已用 pointer 事件接管这一组；
         整块放行，否则横向 touchmove 会被判成场景横滚并 preventDefault，永远滑不动。
         禁用态 / 宽屏没有该属性，触摸照常交回页面手势滚卡片。 */
      if (e.target instanceof Element && e.target.closest('.dc-choice[data-slide]')) {
        this._gesture = null;
        return;
      }
      if (!this._stageEnsure()) return;
      const t = e.touches[0];
      /* 只接管「羽化渐变层及其以下」：羽化层起点 = 3D 带下沿往上 18px
         （与 CSS .p-shell::after 的 top 一致）。上面那块 3D 区完全不接管，
         手指照样交给 OrbitControls 旋转。 */
      this._gesture = null;
      if (t.clientY - shell.getBoundingClientRect().top < (this._stageH || this._stageMax) - 18) return;
      this._gesture = {
        x0: t.clientX, y0: t.clientY, lastX: t.clientX, lastY: t.clientY,
        mode: '',
        hScroll: e.target.closest('.p-scenes, .p-room-track') || null,
        /* 速度采样：每段位移 + 时间戳，只在抬手时用来算 fling 初速度 */
        samples: [], lastMoveT: 0,
      };
    },

    /* 记录一段位移采样，队列只留最近 FLING_WINDOW_MS（抬手前的减速/停顿能如实反映） */
    _sampleMove(g, move) {
      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
      g.lastMoveT = sampleMove(g.samples, move, now);
    },

    onStageTouchMove(e) {
      const g = this._gesture;
      if (!g || this.wide || !e.touches || e.touches.length !== 1) return;
      const t = e.touches[0];
      /* 与 v-tap 共用同一个 8px 阈值：累计位移越过阈值才把本次触摸写成「滚动」。
         不能用下面 g.mode 的 4/6px 方向判定 —— 那会让轻点时的手抖把按钮一起否决。 */
      if (tapExceedsMove(g.x0, g.y0, t.clientX, t.clientY)) markGestureMoved();
      if (!g.mode) {
        const dx = Math.abs(t.clientX - g.x0), dy = Math.abs(t.clientY - g.y0);
        if (dx > 6 && dx > dy) g.mode = 'h';
        else if (dy > 4) g.mode = 'v';
        else return;
        g.lastX = t.clientX; g.lastY = t.clientY;   // 判定完再计增量，第一下不会突然跳一截
      }
      if (g.mode === 'h') {                          // 横向：展示项 / 房间横滚仍归原生容器（手动分发）
        const dx = g.lastX - t.clientX;
        g.lastX = t.clientX; g.lastY = t.clientY;
        if (g.hScroll) g.hScroll.scrollLeft += dx;
        this._sampleMove(g, dx);
        if (e.cancelable) e.preventDefault();
        return;
      }
      const dy = g.lastY - t.clientY;                // >0 上滑
      g.lastX = t.clientX; g.lastY = t.clientY;
      if (dy) {
        this._stageGesture(dy);
        this._sampleMove(g, dy);
      }
      if (e.cancelable) e.preventDefault();          // touch-action:none 下只是保险，避免系统回弹
    },

    /* 纵向增量分发（同一手势内跨阶段连续）：
       上滑先压 3D 带，压到最小后把剩余位移喂给卡片滚动；下滑反向，卡片先回到顶再放开 3D 带。 */
    _stageGesture(dy, quick) {
      const body = this._cards;
      /* 纯拆分在 model/panelGesture.js（可单测）：算出目标 3D 带高度与 scrollTop，
         这里只负责把结果写回 CSS 变量 / 滚动容器 */
      const r = splitVerticalGesture(dy, {
        stageH: this._stageH, stageMin: this._stageMin, stageMax: this._stageMax,
        scrollTop: body ? body.scrollTop : 0, hasBody: !!body,
      });
      if (r.band !== this._stageH) this._setStageH(r.band, quick);
      if (body && r.scroll !== body.scrollTop) body.scrollTop = r.scroll;
    },

    /* 抬手：按最近一段手势的速度起一段惯性，补回被 touch-action:none 关掉的 momentum。
       touchcancel（来电 / 系统打断手势）不甩。 */
    onStageTouchEnd(e) { this._endStageGesture(true, e); },
    onStageTouchCancel(e) { this._endStageGesture(false, e); },

    _endStageGesture(allowFling, e) {
      const g = this._gesture;
      this._gesture = null;
      /* 过渡保险：确实滚动过的手势，在 touchend 压住浏览器补发的合成 click。
         v-tap 已在 pointerdown 从源头 preventDefault（根治），这里只兜住尚未迁移的
         裸 click 与各 WebView 的兼容性事件差异；正常轻点手势不受影响。
         mounted 里 touchend 必须是 passive:false，否则这里的 preventDefault 无效。 */
      if (e && e.type === 'touchend' && e.cancelable && gestureState.moved) {
        const t = e.target;
        if (t instanceof Element && t.closest('.p-shell')) e.preventDefault();
      }
      if (!allowFling || this.wide || !g || !g.mode) return;
      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
      /* 慢慢拖到位、停住再松手 → 不该再滑一段；采样窗口 / 限速 / 阈值都在纯函数里 */
      const v = flingVelocity(g.samples, now, g.lastMoveT);
      if (!v) return;
      this._startFling(g, v);
    },

    _flingStop() {
      if (this._flingRaf) { cancelAnimationFrame(this._flingRaf); this._flingRaf = 0; }
      setFlingRunning(false);
    },

    /* 惯性主体：每帧把「速度 × 帧时长」喂给同一套分发逻辑（3D 带 → 卡片），
       速度指数衰减；到顶/到底立刻停，不回弹。
       纵向走 _stageGesture(..., true)：惯性阶段不逐帧重取景，收尾补一次即可。 */
    _startFling(g, v0) {
      this._flingStop();
      const horizontal = g.mode === 'h';
      const el = horizontal ? g.hScroll : this._cards;
      if (!el) return;
      setFlingRunning(true);
      let v = v0, last = 0;
      const step = (now) => {
        /* 首帧按一整帧时长算，否则 last=0 会算出 dt≈1ms，位移太小被误判成「到边界」 */
        const dt = flingFrameDt(now, last);
        last = now;
        const before = horizontal ? el.scrollLeft : el.scrollTop;
        const h0 = this._stageH;
        const move = v * dt;
        if (horizontal) el.scrollLeft = before + move;
        else this._stageGesture(move, true);
        const moved = horizontal
          ? Math.abs(el.scrollLeft - before)
          : Math.abs((this._cards ? this._cards.scrollTop : 0) - before) + Math.abs(this._stageH - h0);
        if (moved < 0.2) { this._flingFinish(); return; }  // 到边界
        v = nextFlingVelocity(v, dt);
        if (Math.abs(v) < 0.02) { this._flingFinish(); return; }
        this._flingRaf = requestAnimationFrame(step);
      };
      this._flingRaf = requestAnimationFrame(step);
    },

    _flingFinish() {
      this._flingRaf = 0;
      setFlingRunning(false);
      /* 惯性期间若压过 / 放开过 3D 带：跟手阶段是逐帧构图，这里收尾补最后一次 */
      if (this._bandDirty) this._bandRefocus();
    },

    /* 桌面窄窗口调试用：滚轮与触摸同一套分发逻辑（wheel 不受 touch-action 管，仍需 preventDefault） */
    onStageWheel(e) {
      const shell = (e.target instanceof Element) ? e.target.closest('.p-shell') : null;
      if (this.wide || !shell) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;   // 横向滚轮放行给横滚容器
      if (!this._stageEnsure()) return;
      /* 与触摸同口径：3D 带内不接管，滚轮留给 OrbitControls 缩放 */
      if (e.clientY - shell.getBoundingClientRect().top < (this._stageH || this._stageMax) - 18) return;
      if (e.deltaY) this._stageGesture(e.deltaY);
      if (e.cancelable) e.preventDefault();
    },

    /* 3D 场景模式：标签显隐 ⇔ 点击语义（与 EditApp 共用 applySceneMode）。
       唯一特例：index 窄屏强制隐藏标签（顶栏标签开关在窄屏也隐藏），于是自然落到
       「点设备 = 直接执行动作」；宽屏按本机 showLabels 偏好决定，关掉标签同样是执行。 */
    applyStageMode() {
      const narrow = window.innerWidth < WIDE_BREAKPOINT;
      this._stageNarrow = narrow;
      const labels = !narrow && this.showLabels;
      syncSceneMode(View3D, labels, (hit) => this.onPick3D(hit));
      if (!labels) applyPickHi(View3D, null, false);   // 没有点选出卡，场景里不该留选中环
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
      const narrow = window.innerWidth < WIDE_BREAKPOINT;
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

/* ---------- 窄屏：内容区坐一张白纸，纸上沿向 3D 羽化 ---------- */
@media (max-width: 1023px) {
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
@media (min-width: 1024px) {
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
