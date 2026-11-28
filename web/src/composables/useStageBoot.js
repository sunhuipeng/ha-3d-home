/**
 * 3D 舞台启动序列 —— 展示页 PanelApp 使用（原 PC 展板已下线）
 *
 * 2026-11-20 拆成三段，调用方按序 await：
 *   ① bootStageData  目录 → 项目 → 插件 → HA 提前连接（纯数据，无 View3D 调用）
 *   ② waitForPaint / waitForCardsReady   等「非 3D 区域」真实上屏：快设备双 rAF 一帧，
 *      慢设备等 HA 首帧数据到齐（信号驱动，替代固定毫秒数）
 *   ③ startStage3D   View3D.init → 限位 → rebuild/frame → 背景 → 光照 → startLoop
 *
 * 为什么拆：非 3D 区域（数据卡 / 天气 / 楼层按钮 / 卡片视图）只依赖 project +
 * HA store，与 View3D 无强依赖。慢设备（手机 / Windows WebView / 低端机）上
 * rebuild 是同步重活、占满主线程；若它还和 project 赋值在同一条 await 链里，
 * 浏览器来不及 paint，用户看到的就是「先黑一片、再一起蹦出来」。让 project
 * 先挂载并绘制一帧，再进 3D 重建，非 3D 区域就不被 3D 拖住。
 *
 * 相机地面限位是展示页的硬约束（PC 大屏 / 手机宽屏 / 手机窄屏都走这里）：
 * 相机机位永远不低于地面基准面，见 View3D.setGroundLimit。
 *
 * 页面特化的编排（大屏的相机记忆 / 旋转锚点 / 工具条，面板的选中默认值等）
 * 一律走 hooks，不塞进来 —— 这块一混，两页就会互相牵制。
 */

import { nextTick, toRaw, watch } from 'vue';
import { useCatalogStore } from '../stores/catalog';
import { useHaStore } from '../stores/ha';
import { initLighting } from '../engine/lighting.js';
import { neededPluginIds } from '../model/neededPlugins.js';

/* 默认机位：相对房屋中心的观察方向（大屏与面板同一构图） */
export const DEFAULT_CAM = { dir: [6, 12, 9], dist: Math.hypot(6, 12, 9) };

/**
 * 段 1/3 —— 数据准备（不含任何 View3D 调用）。
 * 目录先于项目加载：家具形态解析依赖目录数据。onProject 赋值后非 3D 区域即可挂载。
 * HA 连接刻意提前到 3D 之前：天气、数据卡、房间角标因此能尽早拿到真实值；
 * 对未 init 的 View3D 安全 —— refresh() 有 !root 守卫、resize() 有 !wrap 守卫、
 * onHAChange 里的 checkSceneWatchers 是纯状态机、initLighting 首帧读 store 全量快照。
 *
 * @param {object}   opt
 * @param {Function} opt.onProject    (project) 项目就绪：赋值 / 标题 / 楼层恢复
 * @param {Function} opt.afterPlugins () 插件加载完（如强制重算开关统计）
 * @param {Function} opt.onHaChange   () HA 状态推送回调（连接前注册）
 * @returns {Promise<object|null>} 项目对象
 */
export async function bootStageData({ onProject, afterPlugins, onHaChange } = {}) {
  /* 目录先于项目加载：家具形态解析依赖目录数据 */
  await useCatalogStore().loadCatalog();

  const project = (await fetchProject()) || buildDefaultProject();
  if (onProject) await onProject(project);

  /* 展示页按需加载: 项目已在内存里，用同一份插件清单算出必要 id 集合，
   * 只挂用到的 <script>（省首屏解析/下载）。回调形式让 loadAll 用自己 fetch 的
   * 同一份清单，不重复请求。编辑页 EditApp 仍走 loadAll() 全量（样式面板要列全部）。 */
  await PluginEngine.loadAll((list) => neededPluginIds(project, list));
  if (afterPlugins) await afterPlugins(project);

  /* HA：不再请求 /api/config（2026-11-19 起令牌由服务端代理代管，是否已配置
   * 由服务端用关闭码 4400 告知 → 演示模式）。这里只发起首次连接；断线退避重连 /
   * 回前台立即恢复 / ping 心跳都由 services/ha.js 自管（它自己注册了全局可见性
   * 与网络事件监听）。 */
  if (onHaChange && HA && HA.on) HA.on('change', onHaChange);
  if (HA && HA.connect) HA.connect();

  return project;
}

/**
 * 段 2/3 —— 快设备的让帧：nextTick 把 project 变更刷进 DOM → 双 rAF 调度一帧。
 * 快设备无重建瓶颈，一帧足够；慢设备不用这个，走 waitForCardsReady()（等 HA
 * 首帧数据到齐，避免固定毫秒数忽好忽坏）。
 */
export function waitForPaint() {
  return nextTick().then(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

/* 段 2 信号版（慢设备）的两个参数：
 *   capMs    等 HA 首个快照的最长时间，超时强制放行 —— 兜底无 HA / 无实体 /
 *            demo 模式（演示快照走 3s 定时器，不能让它拖住 3D）。
 *   settleMs 数据到齐后再停留的毫秒数，让非 3D 区域 DOM 落定并提交一帧。 */
const DATA_WAIT_CAP_MS = 900;
const DATA_SETTLE_MS = 160;

/**
 * 段 2 信号版 —— 用「HA 首个快照到达」替代固定毫秒数作为放行 3D 的信号。
 *
 * 卡片从「正在同步设备…」翻成真实内容，唯一驱动就是 haStore.entityCount 从 0 变正
 * （bridge.js 在 HA 首个 full change 时调 applyChange）。watch 这个响应式值比盯 DOM
 * 节点稳：不受 :key 反复重建影响；immediate 首跑覆盖「信号早于本函数」的情况，
 * 手动预判 + watch 的两段式写法没有任何时序缝隙。
 *
 * 注意信号本身只能证明「数据到了」，证明不了「画完了」——watch 回调是微任务，
 * 仍在 paint 之前。所以数据到齐后照样走 nextTick + 双 rAF + 短停留，给浏览器
 * 真正提交这一帧的机会，再放行同步 rebuild。
 *
 * @param {number} capMs     等数据的最长毫秒（超时强制放行，避免无 HA / 无设备卡死）
 * @param {number} settleMs  数据到齐后、进 3D 前的短停留毫秒
 */
export function waitForCardsReady({ capMs = DATA_WAIT_CAP_MS, settleMs = DATA_SETTLE_MS } = {}) {
  return new Promise((resolve) => {
    const ha = useHaStore();
    let done = false;
    let stopWatch = null;
    let capTimer = null;

    const release = () => {
      if (done) return;
      done = true;
      if (stopWatch) stopWatch();
      if (capTimer) clearTimeout(capTimer);
      nextTick().then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
        .then(() => setTimeout(resolve, settleMs));
    };

    capTimer = setTimeout(release, capMs);
    /* immediate: 创建时先按当前值跑一遍回调 —— 「信号早于本函数执行（HA 首帧已在
       boot 段到达）」和「等后续变化」统一成一个入口，不靠 113 行式的手动预判，
       消除检查与 watch 之间任何时序疑虑。 */
    stopWatch = watch(() => ha.entityCount, (n) => { if (n > 0) release(); }, { immediate: true });
  });
}

/**
 * 段 3/3 —— 3D 舞台（重活）。必须在 waitForPaint() 之后调用：此刻 #pstage 容器
 * 已随 v-if="project" 挂载并上屏，3D 重建再慢也不会拖住非 3D 区域。
 *
 * 顺序上有两处不能动：
 *   1. bgOptions / bgFields 必须在 rebuild 之前注入（build 的构图指纹会读它）；
 *   2. 背景插件必须在 rebuild + frame 之后应用（applyBackground 会改 houseY 并平移 target），
 *      afterRebuild 里恢复锚点/机位也要排在它之后。
 *
 * @param {object}   opt
 * @param {string}   opt.stageId      3D 容器 id（DOM 里常驻、不能 v-if）
 * @param {object}   opt.project      段 1 返回的项目对象
 * @param {Function} opt.floorIndex   () => number，rebuild 用当前楼层索引
 * @param {boolean}  opt.background   是否应用项目设置里的背景插件（默认 true）
 * @param {Function} opt.afterInit    () View3D.init 之后、rebuild 之前（选择模式 / 自转开关）
 * @param {Function} opt.afterRebuild () rebuild + frame + 背景之后（相机记忆 / 锚点 / 标签）
 */
export async function startStage3D({
  stageId,
  project,
  floorIndex = () => 0,
  background = true,
  afterInit,
  afterRebuild,
} = {}) {
  View3D.init(stageId);
  /* 展示页硬性要求：相机不能转到地面以下。引擎默认已开，这里显式声明一次，
     保证将来有人改了引擎默认值、或新增展示页，两页的约束也不会被漏掉。 */
  View3D.setGroundLimit(true);
  View3D.setPick(null);           // 首帧无选中（引擎里可能残留上个会话的高亮）
  if (afterInit) await afterInit(project);

  if (project) {
    const settings = project.settings || {};
    /* toRaw 直接注入（审计 2.10：与编辑页 useBackground 同一策略 —— 此前两页
     * 一处深拷贝隔离、一处 toRaw 共享引用，各维护一套拷贝/失效逻辑；
     * 「reactive 不进引擎」的家规由 toRaw 剥代理保证，引擎读写同一 raw 目标） */
    PluginEngine.bgOptions = toRaw(settings.backgroundOptions) || {};
    PluginEngine.bgFields = toRaw(settings.backgroundFields) || {};
    View3D.rebuild(project, floorIndex());     // 楼层模型 + 标签 + 渲染（统一入口）
    View3D.frame(DEFAULT_CAM);

    const bgId = settings.background || '';
    if (background && bgId && PluginEngine.applyBackground(bgId, View3D) === true) View3D.syncBgKey();

    if (afterRebuild) await afterRebuild(project);

    /* 光照控制器：房间 mesh 已重建、插件实例已生成，此时接管才不会丢亮度。
     * 它自己注册 HA change（首次全量快照直接到位），两页共用同一份口径。 */
    initLighting(project, floorIndex);
  }

  View3D.startLoop();
}
