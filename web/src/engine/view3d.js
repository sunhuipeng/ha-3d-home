
/*
 * view3d.js — Three.js 3D 展示
 * 墙体分段开洞 / 地板 / 家具 GLB 体块 / 门窗与设备（造型全由插件生成，这里只做变换与拾取）
 * 背景挂载 / 楼层切换 / 点击控制 / 实时标签
 */
import * as THREE from 'three';
import { Evaluator, Brush, ADDITION, SUBTRACTION } from 'three-bvh-csg';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HA } from '../services/ha.js';
import { furnSpec, deviceDefaultZ, devTypeOf, DEFAULT_FLOOR_H } from '../model/catalog.js';
import { PluginEngine, DEFAULT_OPENING_W } from './plugins.js';
import { applyLegacyRenderer } from './three-legacy.js';

/* 缺省机位（frame 未传 dir 时 / focusRoom 回退共用一份；页面的初始机位各自声明） */
const DEFAULT_CAM_DIR = [8, 9, 10];
const DEFAULT_CAM_DIST = Math.hypot(DEFAULT_CAM_DIR[0], DEFAULT_CAM_DIR[1], DEFAULT_CAM_DIR[2]);

/* 基础灯光原始强度：engine/lighting.js 的全局系数在这两个值之上相乘。
 * 别在这里直接改强度（会绕过夜间模式），也别再手动 ×π（three-legacy 已接管）。
 *
 * 白天 = 太阳光：平行光（SUN_COLOR 暖白）是主光，半球光只做天光填充。
 * 配比刻意让平行光占 57%（旧 32%），方向性才出得来 —— 朝光的面亮、背光的面暗，
 * 这就是「太阳」在 Lambert 材质上唯一的可见证据（房间地面是 MeshBasic，不吃光也不吃阴影，
 * 所以没有开 shadowMap：投影打不在地面上，只会白掉帧）。 */
const BASE_HEMI = 0.68;
const BASE_DIR = 0.90;
const SUN_COLOR = new THREE.Color('#fff1d6');
/* 月光色（engine/lighting.js 夜间档把基础灯往这三个冷色 lerp）：
 * 半球光天空 → 淡蓝、地面反射 → 深蓝灰、平行光（太阳位）→ 月白。
 * 只偏色温不动强度，所以夜间不会更黑，只是从「压暗的白天」变成「清冷的月夜」。 */
const MOON_SKY = new THREE.Color('#a9c4ff');
const MOON_GROUND = new THREE.Color('#2e3850');
const MOON_DIR = new THREE.Color('#bcd2ff');
/* 关灯房间的地面亮度下限（由 lighting.js 的日/夜预设覆盖，这里只是首帧兜底） */
const ROOM_MIN_DEFAULT = 0.82;
/* 门洞相对门框的放大余量（每边/顶部 4cm）：门框 GLB 内沿=门宽一半、上梁下沿=洞高，
 * 若洞口按标称尺寸抠，二者与洞壁/洞顶完全共面 → 半透明墙 depthWrite=false 与不透明
 * 门框深度竞争，旋转视角出现波纹。放大门洞让门套露在洞口边缘、盖住洞壁断面（真实
 * 门套的样子），共面自然消失。只放大门洞：窗框内沿本就探入洞内、不共面。
 * 上限约 0.07（门框立梃宽 0.078×L，L=0.9 时 0.07）——gap 再大立梃盖不住洞壁、四周露墙边。
 * 近共面处的残余深度竞争另由 _wallMat 的 polygonOffset 兜底。 */
const OPENING_GAP = 0.04;

/* 默认背景「纯色 + 网格」的网格线日/夜配色（由 lighting.js 切夜间时经 setGridNight 应用）。
 * GridHelper 的线色写在 geometry 顶点色里（中心/普通两种浅灰），material.color 作为统一
 * tint 乘上去 —— 白天 tint=白(×1) 完全保留原观感（亮色主题一行不改）；夜间压暗 tint
 * 并降 opacity，避免深色背景上白线过于扎眼。ColorManagement 已关（three-legacy），
 * 数值直接相乘，可预测。 */
const GRID_TINT_DAY = 0xffffff;
const GRID_TINT_NIGHT = 0x647086;      // 与顶点色相乘后落在暗蓝灰一档
const GRID_OPACITY_DAY = 0.7;
const GRID_OPACITY_NIGHT = 0.4;

/* 相机地面限位（所有展示页统一，单位都是 world unit）：
 * 地面基准面 = y 0 —— 默认网格地台在 -0.03、背景插件地面在 -0.05，房屋地板由 houseY 抬升，
 * 但「地面」本身始终在 0 附近（见 plugins.js 背景参数说明），与 houseY 正负无关。
 * 间隙 0.5（≈50cm）：镜头贴着 y=0 时网格线会从镜头下穿过，留一点余量观感才干净。
 * MAX_POLAR 保留原来的「允许略微仰视」（房屋悬空时能看到底面），只是不能再穿地。 */
const GROUND_CLEARANCE = 0.5;
const MAX_POLAR_ANGLE = Math.PI * 0.66;
const MIN_POLAR_EPS = 0.01;

export const View3D = {
  renderer: null, scene: null, camera: null, controls: null,
  root: null,              // 当前楼层根节点
  wrap: null,
  houseY: 0,               // 房屋地板相对背景基准面 y=0 的高度（米，可为负）；由背景样式参数 houseY 驱动
  pickGroups: [],          // 可点击模型根 Group（设备 + 门/窗；拾取时递归 raycast，命中后沿父链回溯）
  roomPickGroups: [],      // 房间地面 mesh（只在设置了 onPick 时参与拾取，见 pickRoom）
  onPick: null,            // 选中回调：显示标签时装载（点设备/房间出卡片）；隐藏标签时为 null（点设备直接 toggle）
  _pickHi: null,           // 当前选中高亮 { roomMesh, temp[] }（房间色由 updateRoomColor 统一合成）
  _pickKey: null,          // 'kind:id'，同一项不重复重建高亮
  labels: [],              // {el, d}：el = 标签 DOM，d = 设备数据
  labelsVisible: true,     // 标签显示开关：同时决定 3D 点击语义（三页统一，见 model/pick.js）
  currentFloorIdx: 0,
  raycaster: null,
  wallH: DEFAULT_FLOOR_H,

  /* 光照（engine/lighting.js 是唯一真相，这里只保存被引擎写进来的结果）：
   *  lightingGain  灯具池光倍率，plugins.js 的 lightKit.set() 每次 update 都会读
   *  _roomLit      lighting 是否已接管房间地面；false 时首帧保持原始亮度
   *  _roomBrightness / _roomMin  按房间亮度表，build() 重建 mesh 后靠它们重放 */
  lightingGain: 1,
  _roomLit: false,
  _roomBrightness: {},
  _roomMin: ROOM_MIN_DEFAULT,
  /* 默认网格线的夜间配色开关（engine/lighting.js 切主题时写，本模块只保存结果）。
   * 建网格前就可能先收到 setGridNight（lighting 晚于 init 时），所以存字段 + 建好再加。 */
  gridNight: false,

  /* 相机地面限位：默认开启（三页共用同一引擎实例，一处生效处处生效）。
   * groundY / groundClearance 允许页面或背景覆写，setGroundLimit(false) 可整体豁免。 */
  groundLimitEnabled: true,
  groundY: 0,
  groundClearance: GROUND_CLEARANCE,

  /* 背景重放状态（统一管理，避免 build / applyBg 各写一份导致状态漂移）
   * _bgKey 只在「重放成功」后提交；失败保留旧值，下一次 build 会自动重试。 */
  _bgKey: '',
  _bgFloorIdx: -1,
  _bgReplay: null,
  _bgRetry: null,      // 重放失败后的自动重试 timer（插件 loadAll 异步，别等用户再操作）
  _bgFail: 0,          // 连续失败次数，超过 3 次停手，避免坏插件刷屏

  webglOk: true,

  init(wrapId) {
    if (this._inited) return;   // 重入守卫：HMR / 二次 init 会叠加监听器并出现双 RAF 循环
    this._inited = true;
    this.wrap = document.getElementById(wrapId);
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (e) {
      // 无 WebGL 环境（如某些无头/虚拟机）: 3D 不可用但不影响 2D
      this.webglOk = false;
      this.wrap.style.background = '#eef1f4';
      this.wrap.innerHTML = '<div style="display:flex;height:100%;align-items:center;justify-content:center;color:#5a6678;font-size:14px;flex-direction:column;gap:10px"><div style="font-size:34px">🖥️</div>当前环境不支持 WebGL，无法显示 3D 视图<br><span style="opacity:.7;font-size:12px">请使用 Chrome / Edge / Safari 等现代浏览器打开</span></div>';
      return;
    }
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;   // 省内存省性能
    this.renderer.setClearColor(0x000000, 0);  // 透明画布: 天空交给页面底色，不画渐变
    this.wrap.appendChild(this.renderer.domElement);
    applyLegacyRenderer(this.renderer);   // 切回 r147 legacy 观感（色彩空间/编码/灯光），与 studio 同口径

    this.scene = new THREE.Scene();

    /* 默认地面: 浅灰网格（选中背景插件后由引擎 setBackdrop 挂载 3D 地面模型并隐藏网格） */

    /* 浅灰网格地台（2m 一格；位于户型地板之下，作背景衬托） */
    const grid = new THREE.GridHelper(120, 60, 0xd3dae4, 0xdfe5ec);
    grid.material.transparent = true;
    grid.material.opacity = 0.7;
    grid.position.y = -0.03;
    this.scene.add(grid);
    this.grid = grid;
    this.setGridNight(this.gridNight);   // 回放夜间配色（lighting 可能早于 init 写入）

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.set(9, 10, 11);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    /* 允许略微仰视（polar > 90°）：房屋悬空/建在山顶时，能看到房屋底面与底下的地形。
     * 上限会被 enforceGroundLimit() 按当前锚点高度逐帧收紧，保证仰视也不穿地。 */
    this.controls.maxPolarAngle = MAX_POLAR_ANGLE;
    /* 用户一按下就放弃正在进行的相机飞行（房间视角），操控永远优先 */
    this.controls.addEventListener('start', () => this.cancelFly());

    this.raycaster = new THREE.Raycaster();

    /* 长按重设旋转锚点：默认开启（大屏/编辑页），控制面板页会置 false */
    this.anchorEnabled = true;

    // 灯光（半球光 + 平行光；基础场景不逐灯加 PointLight，灯具自身的补光由插件 lightKit 负责）。
    // ⚠ 强度不再手动 ×π：legacy 灯光口径由 three-legacy.js 的 applyLegacyRenderer（_useLegacyLights=true）
    //    在 renderer 层统一接管，等效旧 vendor three（r147）观感；这里只写「原始强度」，避免二次放大过曝。
    // ⚠ 必须留对象引用：engine/lighting.js 的 setAmbient() 靠它们统一调全局亮度（夜间模式）。
    this.hemi = new THREE.HemisphereLight(0xdfeaff, 0x8a7a66, BASE_HEMI);
    /* 平行光 = 太阳：暖白色温 + 约 40° 仰角（旧的 54° 太顶，出不来方向感）。
     * 位置只是方向向量（目标恒为原点），由 +x/+z 侧斜射，和默认相机方位错开才看得见面明暗。 */
    this.dirLight = new THREE.DirectionalLight(SUN_COLOR.getHex(), BASE_DIR);
    this.dirLight.position.set(10, 11, 8);
    this.scene.add(this.hemi, this.dirLight);

    /* 灯具光源池：插件 lightKit 的 PointLight/SpotLight 从这里「借」，而不是每次 new。
     * Three.js 的着色器程序缓存按「材质 + 光源数量」为键 —— 切层销毁重建灯具时
     * 光源数量变化会触发全场景材质重新编译 GLSL（手机上表现为可感知的整帧冻结）。
     * 池里的灯常驻场景（借出时挂到灯具组、归还/回收时挂回 rig），场景光源总数恒定，
     * 程序缓存永远命中。池按需增长、永不缩小，因此数量只会单调升到历史最大值。 */
    this.lightRig = new THREE.Group();
    this.lightRig.name = 'lightRig';
    this.scene.add(this.lightRig);
    this._lightPool = { point: [], spot: [] };

    this.resize();
    window.addEventListener('resize', () => this.resize());

    // 点击设备
    const dom = this.renderer.domElement;
    dom.addEventListener('click', (e) => this.onClick(e));
    dom.addEventListener('mousemove', (e) => {
      /* 大屏里房间地面也可点，鼠标划过要一并给出手型光标 */
      const hit = this.pick(e) || (this.onPick ? this.pickRoom(e) : null);
      dom.style.cursor = hit ? 'pointer' : '';
    });

    // 长按左键重设旋转锚点（index/display 通用）:
    // 按住 ~500ms 不拖动 → 锚点设为所指地面点；拖拽旋转（按下即移动）/快速点按互不冲突。
    // 调用端可把 anchorEnabled 置 false 关掉整个长按能力（控制面板页：锚点固定跟选中项走）。
    let pressTimer = null, pressPos = null;
    const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } pressPos = null; };
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this._dragged = false;
      pressPos = { x: e.clientX, y: e.clientY };
      if (pressTimer) clearTimeout(pressTimer);
      if (this.anchorEnabled === false) return;      // 长按不再设锚点（但拖动/点按判定照旧）
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (!pressPos) return;
        if (this.setAnchor(this.groundPoint(pressPos.x, pressPos.y))) {
          this._anchorPicked = true;   // 松手时 onClick 据此跳过，防止长按后误触设备开关
        }
      }, 500);
    });
    dom.addEventListener('pointermove', (e) => {
      // 按下后拖动超过 8px = 在旋转视角，取消长按判定；同时记下来，避免松手时误当成点击
      if (pressPos && Math.hypot(e.clientX - pressPos.x, e.clientY - pressPos.y) > 8) {
        this._dragged = true;
        clearPress();
      }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => dom.addEventListener(t, clearPress));
  },

  resize() {
    if (!this.wrap || !this.webglOk) return;
    const w = this.wrap.clientWidth || 10, h = this.wrap.clientHeight || 10;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  },

  /* ---------------- 背景（抽象层：只管地面） ----------------
   * 场景天空不在这里处理：渲染器 alpha=true + 画布透明，露出页面自身底色；
   * 地面两种形态：默认网格地台（setGridVisible）或背景插件的 3D 模型（setBackdrop，扁平背景也是它）。 */

  setGridVisible(v) { if (this.grid) this.grid.visible = !!v; },

  /* 默认网格线的日/夜配色：由 engine/lighting.js 的 applyTheme 在切主题 / 首次加载 /
   * 跨页同步时调用。GridHelper 的颜色在顶点色里，材质 tint 默认为白（×1 = 原样）——
   * 白天只把 tint 复位成白、opacity 复位 0.7，亮色主题观感一字不改；夜间压暗 tint +
   * 降 opacity，线退成背景衬托。编辑页恒白天（lighting.js 的 S.editPage 保证不会传 true）。 */
  setGridNight(night) {
    this.gridNight = !!night;
    if (!this.grid || !this.grid.material) return;
    this.grid.material.color.setHex(this.gridNight ? GRID_TINT_NIGHT : GRID_TINT_DAY);
    this.grid.material.opacity = this.gridNight ? GRID_OPACITY_NIGHT : GRID_OPACITY_DAY;
    // color/opacity 是 uniform，无需 needsUpdate，下一帧 render 自动生效
  },

  /* 插件返回的背景 3D 模型（统一入口: 扁平背景 = 平面网格贴整图，立体背景 = 底图 + 体块）
   * 引擎不做任何 UV 假设，只负责挂载 + 释放。 */
  setBackdrop(obj) {
    if (!this.scene || !obj) return null;
    this.clearBackdrop();   // 换背景时先释放上一份（几何+贴图）
    this.backdrop = obj;
    this.scene.add(obj);
    this.setGridVisible(false);
    return { mesh: obj, material: null, texture: null, group: obj };
  },

  clearBackdrop() {
    if (!this.backdrop) return;
    this.scene.remove(this.backdrop);
    this.disposeGroup(this.backdrop);
    this.backdrop = null;
  },

  /* 背景构图输入指纹（几何键）。只有这些量全一致，旧的背景 group 才能继续复用：
   * 房屋包围盒 / 层高 / 背景样式 / 三个位置参数。
   * 位置参数读 bgOptions 里的「保存值」（不含 def 默认值），保证 key 稳定不抖动；
   * 把它们也纳入是为了让「显式重放失败」能靠下一次 build 自愈。
   * 刻意不含楼层号：背景插件画地形拿到的输入只有包围盒+样式+位置参数（不感知楼层），
   * 两层尺寸相同 → key 相同 → 切层零重放；尺寸不同才重画。 */
  bgKeyOf() {
    const h = this.house || (this.project ? this.computeHouse(this.project, this.currentFloorIdx) : null);
    const bo = (window.PluginEngine && PluginEngine.bgOptions
      && PluginEngine.bgOptions[this.bgId]) || {};
    return [h ? h.hash : '', h ? h.h : '',
      this.bgId || '', bo.offsetX || 0, bo.offsetZ || 0, bo.houseY || 0].join('|');
  },

  /* 编辑页 init 时 View3D 还没 build 过（project/house 都是空的），
   * 若直接 applyBackground，houseBounds() 返回 null → 背景按默认 8×8 原点构图，
   * 房屋与平台错位；2D 模式下改背景 / 调参数也会一直错，且 webglOk=false 时永不修正。
   * 所有「非 build 触发」的背景绘制入口先调它对准当前楼层。 */
  ensureHouse(project, floorIdx) {
    if (!project) return this.house;
    this.project = project;
    if (typeof floorIdx === 'number') this.currentFloorIdx = floorIdx;
    this.house = this.computeHouse(project, this.currentFloorIdx);
    return this.house;
  },

  /* 显式重放（或新的 build）接管时，取消挂起的防抖重放与自动重试：
   * 否则同层拖墙挂起的 160ms timer / 失败重试 timer 会在 applyBg() 之后又画一次，
   * 同一帧双重建销 group、重建 onData 订阅并闪帧。 */
  cancelBgReplay() {
    clearTimeout(this._bgReplay); this._bgReplay = null;
    clearTimeout(this._bgRetry); this._bgRetry = null;
    this._bgFail = 0;
  },

  /* 显式重放成功后提交指纹，避免下一次 build 误判「构图变了」再画一遍。
   * 失败时不要调用 —— 保留旧 key，让 build 有机会重试。 */
  syncBgKey() {
    this._bgKey = this.bgKeyOf();
    this._bgFloorIdx = this.currentFloorIdx;
  },

  /* ---------------- 构建 ---------------- */
  /* 从池里借一盏灯（kind: 'point' | 'spot'）。空闲灯直接复用；池空则新建常驻灯。
   * 借出方负责把灯挂到自己的节点树下并设置位置/强度；用完调 releaseLight 还回。 */
  acquireLight(kind) {
    const pool = (this._lightPool = this._lightPool || { point: [], spot: [] })[kind] || (this._lightPool[kind] = []);
    let l = pool.find((x) => !x.userData.inUse);
    if (!l) {
      l = kind === 'point' ? new THREE.PointLight(0xffffff, 0, 4.5) : new THREE.SpotLight(0xffffff, 0, 5.5, 1.0, 0.55, 1.1);
      l.userData.inUse = false;
      this.lightRig.add(l);
      pool.push(l);
    }
    l.userData.inUse = true;
    return l;
  },

  /* 归还灯：摘回 rig 下、强度清零（不 dispose —— 常驻池，切层还要复用） */
  releaseLight(kind, l) {
    if (!l || !this.lightRig) return;
    l.userData.inUse = false;
    l.intensity = 0;
    if (l.target && l.target.parent && l.target.parent !== this.lightRig) {
      this.lightRig.add(l.target);   // SpotLight 的 target 必须留在场景图内，随灯一起回池
    }
    this.lightRig.add(l);
  },

  /* 场景重建开场：池灯强制回池。重建会销毁灯具实例，借出灯若还挂在
   * 旧设备组下就会随场景一起消失（池漏水 + 光源数量抖动），这里统一收编兜底，
   * 插件 dispose 写不写 release 都不会漏。
   * keepRoots（懒加载层缓存用）：暂存层 root 的祖先链上的池灯跳过 —— 它们还
   * 挂在缓存场景的灯具下，收编会让缓存层的灯失效。 */
  reclaimPoolLights(keepRoots) {
    if (!this._lightPool || !this.lightRig) return;
    const kept = (keepRoots && keepRoots.length) ? keepRoots : null;
    const ownedByKept = (l) => {
      if (!kept) return false;
      for (let p = l.parent; p; p = p.parent) {
        if (kept.indexOf(p) !== -1) return true;
        if (p === this.lightRig) return false;   // 已在 rig 下 = 空闲灯，照常收编
      }
      return false;
    };
    for (const kind of ['point', 'spot']) {
      (this._lightPool[kind] || []).forEach((l) => {
        if (ownedByKept(l)) return;   // 暂存层的灯随缓存 root 挂起，保持 inUse
        l.userData.inUse = false;
        l.intensity = 0;
        this.lightRig.add(l);   // add 内部会先从旧父节点摘除，重复调用安全
      });
    }
  },

  /* 当前是否处于场景重建中（build 同步段）。期间 render() 静默跳过：
   * 插件构造 / 背景重放里的逐个 put → render 不再各自画一帧全场景，
   * 重建完成只渲染一次，也避免中间态光源数量触发多轮着色器编译。 */
  _building: false,

  /* ---------------- 懒加载层缓存（仅展示页启用，编辑页不启用） ----------------
   * 每层首次显示时照常相位化构建，建完整组缓存（root + 标签 DOM + 派生量 + 插件实例）；
   * 之后切回该层只做 detach/attach 换组，几十毫秒级秒切。缓存永不淘汰 —— 家庭户型
   * 就 2~3 层，内存可控；唯一失效入口 = project 引用变化（换项目/编辑页改完回来）。
   * 插件实例按 rec.floorIdx 区分：重建只注销当前层实例，暂存层实例由 HA 状态广播
   * 持续喂新，回场即最新（见 PluginEngine.reset(keepFloors) / tick(dt, curFloor)）。 */
  floorCache: false,
  _floorCache: null,     // Map<floorIdx, rec>（惰性建，避免模块级共享状态）
  _cacheProject: null,   // 缓存归属的 project 引用
  _activeRec: null,      // 当前挂载层的缓存记录
  _lastBuildHit: false,  // 本次 build 是否走了缓存换组（rebuild 据此跳过 syncLabels）

  enableFloorCache() {
    this.floorCache = true;
  },

  _cacheMap() {
    if (!this._floorCache) this._floorCache = new Map();
    return this._floorCache;
  },

  /* 整体失效：dispose 所有缓存层 + 注销全部插件实例。换 project 引用时唯一入口。 */
  _clearFloorCache() {
    if (this._floorCache) {
      if (window.PluginEngine) PluginEngine.reset();   // 先注销实例（可能持有纹理等资源）
      this._floorCache.forEach((rec) => {
        this.disposeGroup(rec.root);
        (rec.labels || []).forEach(({ el }) => el.remove());
      });
      this._floorCache.clear();
    }
    this._activeRec = null;
    this._cacheProject = null;
  },

  /* 把当前挂载层摘下挂起（不 dispose）：root 出场景、标签 DOM 摘进 fragment、
   * 派生量随 rec 保存。targetIdx === 当前层（同层重建）时不缓存 —— 直接销毁，
   * 交给 miss 路径重建后覆盖。 */
  _stashActive(targetIdx) {
    const rec = this._activeRec;
    if (!rec || !this.root) {
      if (this.root) { this.scene.remove(this.root); this.disposeGroup(this.root); }
      this.clearLabels();
      this._activeRec = null;
      return;
    }
    this.scene.remove(this.root);
    if (targetIdx != null && rec.floorIdx === targetIdx) {
      this.disposeGroup(this.root);
      this.labels.forEach(({ el }) => el.remove());
      this._cacheMap().delete(rec.floorIdx);
      this._activeRec = null;
      this.labels = [];
      this.pickGroups = [];
      this.roomPickGroups = [];
      this.itemGroups = new Map();
      this._pickHi = null;
      this._pickKey = null;
      return;
    }
    const frag = document.createDocumentFragment();
    this.labels.forEach(({ el }) => frag.appendChild(el));
    rec.labels = this.labels;
    rec.labelFrag = frag;
    rec.pickGroups = this.pickGroups;
    rec.roomPickGroups = this.roomPickGroups;
    rec.itemGroups = this.itemGroups;
    rec.center = this.center;
    rec.wallH = this.wallH;
    rec.wallOpacity = this._wallOpacity;
    rec.house = this.house;
    this.labels = [];
    this.pickGroups = [];
    this.roomPickGroups = [];
    this.itemGroups = new Map();
    this._pickHi = null;
    this._pickKey = null;
    this._cacheMap().set(rec.floorIdx, rec);
    this._activeRec = null;
  },

  /* 缓存命中：换组秒切（同步完成）。派生量/标签/选中态全部来自缓存记录；
   * 相机 target 平移到该层 center（与 build 收尾同一回中规则，构图不跳）；
   * 背景按几何键判定，没变就不重放。 */
  _swapToFloor(project, floorIdx) {
    const rec = this._cacheMap().get(floorIdx);
    if (!rec) return;
    this._stashActive(floorIdx);
    this.currentFloorIdx = floorIdx;
    this.project = project;
    this.root = rec.root;
    this.scene.add(this.root);
    if (rec.labelFrag) this.wrap.appendChild(rec.labelFrag);
    this.labels = rec.labels || [];
    this._labelWait = performance.now();   // 回场重跑标签的 HA 等待逻辑
    this.pickGroups = rec.pickGroups || [];
    this.roomPickGroups = rec.roomPickGroups || [];
    this.itemGroups = rec.itemGroups || new Map();
    this.wallH = rec.wallH || DEFAULT_FLOOR_H;
    this._wallOpacity = rec.wallOpacity != null ? rec.wallOpacity : 0.45;
    if (this._wallMat) this._wallMat.opacity = this._wallOpacity;
    this.house = rec.house || this.computeHouse(project, floorIdx);
    this.center = rec.center || this.center;
    this._activeRec = rec;
    if (this.controls && this.center) {
      const prevTarget = this.controls.target.clone();
      this.controls.target.copy(this.center);
      this.camera.position.add(this.center.clone().sub(prevTarget));
      this.controls.update();
    }
    const bgKey = this.bgKeyOf();
    const floorChanged = this._bgFloorIdx !== floorIdx;
    this._bgFloorIdx = floorIdx;
    if (bgKey !== this._bgKey) {
      this.cancelBgReplay();
      const replay = this._makeBgReplayer();
      /* 换组是低频操作，同 build 的切层路径：立即重放、放下一帧 */
      if (floorChanged) requestAnimationFrame(replay);
      else this._bgReplay = setTimeout(replay, 160);
    }
    this._lastBuildHit = true;
    this.render();
    if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('ha3d:rebuilt'));   // lighting 按当前层重放（很便宜）
    }
  },

  /* 相位化重建生成器：每个 yield 就是一个「可以让出一帧」的相位边界。
   * build() 同步驱动它（一口气跑完，行为与旧版完全一致，编辑页/撤销等所有旧路径零变化）；
   * buildAsync() 在相位边界让帧（窄屏切层：遮罩转圈全程不冻，大重建拆成多段短忙）。 */
  /* 背景重放闭包（build 收尾与缓存换组共用）：现算指纹防抖期间构图又变 /
     已被 applyBg 显式画好的重复绘制；失败安排有限次重试（3 次止）。 */
  _makeBgReplayer() {
    const replay = () => {
      if (!window.PluginEngine || !this.bgId || !PluginEngine.applyBackground) return;
      const key = this.bgKeyOf();
      if (key === this._bgKey) return;
      let done = false;
      try { done = PluginEngine.applyBackground(this.bgId, this) === true; }
      catch (e) { console.warn('[View3D] 背景重放异常:', e); }
      if (done) { this._bgKey = key; this._bgFail = 0; return; }
      /* 失败：保留旧指纹，并主动安排有限次重试。插件 loadAll 是异步的，
       * 只等「下一次 build」可能永远等不到 —— 背景会一直空白。 */
      this._bgFail = (this._bgFail || 0) + 1;
      if (this._bgFail <= 3) {
        clearTimeout(this._bgRetry);
        this._bgRetry = setTimeout(replay, 300);
      }
    };
    return replay;
  },

  *_buildPhases(project, floorIdx, opts) {
    if (!this.webglOk) return;
    /* keepView: 同一楼层内的「数据微调重建」（属性面板改数值、撤销…）保留用户当前
     * 环绕中心，不把 controls.target 拉回户型包围盒中心 —— 否则右键平移过视角后，
     * 一改参数画面就跳回房子中心。进 3D / 切楼层 / 显式取景仍走默认（回中）。 */
    const keepView = !!(opts && opts.keepView) && !!this.controls && !!this.camera;
    this.resize();   // 容器刚从隐藏变可见时必须重新计算尺寸，否则渲染不出来
    this._lastBuildHit = false;
    /* 懒加载层缓存（仅展示页启用）：换 project 引用即整体失效；
     * 目标层已建过且不是当前层 → 直接换组秒切，生成器到此结束
     * （rebuild/rebuildAsync 据此跳过 syncLabels，标签随缓存整树挂回）。 */
    if (this.floorCache) {
      if (this._cacheProject !== project) { this._clearFloorCache(); this._cacheProject = project; }
      const target = floorIdx || 0;
      if (target !== this.currentFloorIdx && this._cacheMap().has(target)) {
        this._swapToFloor(project, target);
        return;
      }
    }
    this._building = true;   // 重建期间吞掉 render()：插件 put 的逐次渲染与中间态光源编译全免
    this.currentFloorIdx = floorIdx || 0;
    this.project = project;   // houseBounds() 在场景未构建时也能现算
    this.clearAnchorFx();
    /* 懒加载缓存：当前层挂起（root/标签/派生量随 rec 保存，不销毁），只注销当前层的
     * 插件实例；暂存层实例与它们借走的池灯全部保留（HA 广播继续喂、回场即最新）。
     * 缓存关闭时维持原语义：全部注销 + 全量销毁。 */
    if (this.floorCache) {
      this._stashActive(floorIdx || 0);
      if (window.PluginEngine) PluginEngine.reset(new Set(this._cacheMap().keys()));
      this.reclaimPoolLights([...this._cacheMap().values()].map((r) => r.root));
    } else {
      if (window.PluginEngine) PluginEngine.reset();   // 注销上一轮插件实例
      this.reclaimPoolLights();   // 借出的池灯随旧实例一起失效，统一收编回 rig（光源总数保持恒定）
      if (this.root) { this.scene.remove(this.root); this.disposeGroup(this.root); }
    }
    this.pickGroups = [];
    this.roomPickGroups = [];
    /* id → { grp, body, type }：属性面板移动设备/家具时就地改变换，不必整树重建 */
    this.itemGroups = new Map();
    /* 高亮引用的 mesh 属于上一轮场景：重建前必须丢弃引用，
     * 否则 clearPickHi 会去改已经 dispose 的材质，颜色还原到空气里 */
    this._pickHi = null;
    this._pickKey = null;
    this.clearLabels();
    this.root = new THREE.Group();
    yield 'teardown';   // 相位边界：旧场景已拆完，新场景还没开始建

    const fl = project.floors[this.currentFloorIdx];
    if (!fl) { this._building = false; return; }
    this.wallH = fl.height || DEFAULT_FLOOR_H;
    // 墙面不透明度(%)：按楼层记忆，默认 45
    this._wallOpacity = (fl.wallOpacity != null ? fl.wallOpacity : 45) / 100;
    if (this._wallMat) this._wallMat.opacity = this._wallOpacity;

    this.buildFloor(fl);    // 把门窗归属到最近的墙，墙体真实掏洞
    const walls = fl.walls || [];   // 旧数据可能缺 walls 键（同文件其它处都用 || [] 防御）
    const wallOpenings = walls.map(() => []);
    (fl.windows || []).forEach((wd) => this.assignOpening(wd, 'window', fl, wallOpenings));
    (fl.doors || []).forEach((d) => this.assignOpening(d, 'door', fl, wallOpenings));
    const wallExts = this.computeWallExt(walls);
    /* 整层墙体一体绘制（分层 union，拐角不再双重绘制）；布尔失败时回退旧的逐墙 Shape 扣洞 */
    try {
      this.buildWalls(fl, wallOpenings, wallExts);
    } catch (err) {
      console.warn('[view3d] 整层墙体 union 失败，回退逐墙绘制', err);
      walls.forEach((w, i) => this.buildWall(w, wallOpenings[i], wallExts.get(w)));
    }
    yield 'walls';   // 相位边界：墙体（含掏洞）已建完
    // 门/窗 = type:'door'/'window' 的贴墙设备，与设备走同一条建造路径（模型/热区/标签/点击全套同构）
    if (window.PluginEngine) {
      (fl.windows || []).forEach((wd) => this.buildDevice(wd, 'window'));
      (fl.doors || []).forEach((d) => this.buildDevice(d, 'door'));
    }
    yield 'openings';   // 相位边界：门窗（贴墙设备）已建完
    (fl.furniture || []).forEach((f) => this.buildFurniture(f));
    yield 'furniture';   // 相位边界：家具已建完
    (fl.devices || []).forEach((d) => this.buildDevice(d));
    yield 'devices';   // 相位边界：设备已建完（通常是最大的一相位）

    /* 房屋整体基准高度：设备/家具/门窗都挂在 root 下，它们的高度仍然是「相对房屋」的，
     * 这里统一抬升整组即可，实例数据（d.z / obj.z / project.json）不写 H。 */
    this.root.position.y = this.houseY;
    this.scene.add(this.root);
    // 旋转/环绕锚点 = 户型包围盒中心（而不是固定原点，否则模型不在原点时会绕角落转）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    walls.forEach((w) => {
      minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
      minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
    });
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 8; maxY = 8; }
    /* 锚点 y 贴合房屋基准高度：H+1 保持原来「房屋中心上方 1m」的相对量。
     * 相机跟着 target 一起平移同样差值，重建（切层 / 拖墙 / 撤销）时构图不跳。
     * keepView 时不碰用户视角：target 保持右键平移后的值，只更新「回中」用的基准点。 */
    this.center = new THREE.Vector3((minX + maxX) / 2, this.houseY + 1, (minY + maxY) / 2);
    if (!keepView) {
      const prevTarget = this.controls.target.clone();
      this.controls.target.copy(this.center);
      this.camera.position.add(this.center.clone().sub(prevTarget));
      this.controls.update();
    }

    /* 当前楼层的房屋包围盒：背景插件按它决定在哪里画。
     * 按层取（楼层间户型尺寸可能不一样，背景构图跟着当前层走）。
     * 重放判定键 = 几何键（包围盒 | 层高 | 背景样式 | 位置参数，见 bgKeyOf），
     * 任一变化才重画背景：
     *   · 切层且两层尺寸不同：几何键变化 → 重放；
     *     两层尺寸相同 → 键相同 → 背景原样复用，切层零重放；
     *   · 拖墙 / 改尺寸 / 改层高：走 160ms 防抖，避免连续重建把带 3D 体块的插件跑爆；
     *   · 换背景 / 改位置参数：通常由 applyBg() 显式重放，纳入 key 是失败后的自愈兜底。
     * 插件不需要、也不应该自己通知重绘 —— 这是引擎的职责。 */
    this.house = this.computeHouse(project, this.currentFloorIdx);
    const bgKey = this.bgKeyOf();
    const floorChanged = this._bgFloorIdx !== this.currentFloorIdx;
    this._bgFloorIdx = this.currentFloorIdx;
    if (bgKey !== this._bgKey) {
      this.cancelBgReplay();
      const replay = this._makeBgReplayer();
      /* 切层是一次性低频操作：立即重放，别让 160ms 防抖窗口里还显示旧地形。
       * 但放到下一帧 —— 切层这一帧先画房屋本体，背景插件整组地形重建不再与
       * 房屋重建挤在同一帧里（两者叠加正是切层掉帧的大头）。 */
      /* 异步切层（buildAsync）：背景重放不在生成器内丢给 rAF，而是记下来由
       * buildAsync 收尾就地执行 —— 调用方的遮罩要等 rebuildAsync 返回才撤，
       * 重放的卡顿也被遮罩盖住。同步路径维持原行为。 */
      if (this._asyncBuild) this._bgReplayNow = replay;
      else if (floorChanged) requestAnimationFrame(replay);
      else this._bgReplay = setTimeout(replay, 160);
    }
    this._building = false;
    this.render();
    /* 楼层重建后房间 mesh 全是新的（亮度表按 roomId 重放过，但可能是上一层的数据）。
     * 通知 lighting.js 按当前楼层重算；不在引擎里直接 import lighting，避免循环依赖。 */
    if (typeof window !== 'undefined' && window.dispatchEvent && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('ha3d:rebuilt'));
    }
    /* 懒加载缓存：本层建完入库（labels 在 rebuild 的 syncLabels 之后回填）。 */
    if (this.floorCache) {
      this._cacheMap().set(this.currentFloorIdx, {
        floorIdx: this.currentFloorIdx,
        root: this.root,
        pickGroups: this.pickGroups,
        roomPickGroups: this.roomPickGroups,
        itemGroups: this.itemGroups,
        center: this.center,
        wallH: this.wallH,
        wallOpacity: this._wallOpacity,
        house: this.house,
        labels: null,
        labelFrag: null,
      });
      this._activeRec = this._cacheMap().get(this.currentFloorIdx);
    }
  },

  /* 异步重建进行中的标记 + 待就地执行的背景重放（见 _buildPhases 内注释） */
  _asyncBuild: false,
  _bgReplayNow: null,

  /* 同步驱动：相位边界直接跨过，一口气跑完全部相位。
   * 行为与旧的整段 build() 完全一致 —— 编辑页 / 撤销 / 属性面板等所有旧调用方零变化。 */
  build(project, floorIdx, opts) {
    const it = this._buildPhases(project, floorIdx, opts);
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
  },

  /* 窄屏切层的异步重建：每个相位之间让出一帧 —— 遮罩上的转圈（compositor 动画）
   * 全程不冻，大重建被拆成「拆场景 / 墙体 / 门窗 / 家具 / 设备 / 收尾」多段短忙，
   * 页面不再整块卡死几秒。收尾时就地执行背景插件地形重放（遮罩还罩着，卡顿被盖住）。 */
  async buildAsync(project, floorIdx, opts) {
    if (!this.webglOk) return;
    this._asyncBuild = true;
    try {
      const it = this._buildPhases(project, floorIdx, opts);
      let r = it.next();
      while (!r.done) {
        await new Promise((res) => requestAnimationFrame(res));   // 让出一帧
        r = it.next();
      }
    } finally {
      this._asyncBuild = false;
    }
    if (this._bgReplayNow) {
      const replay = this._bgReplayNow;
      this._bgReplayNow = null;
      await new Promise((res) => requestAnimationFrame(res));   // 房屋本体首帧先上屏
      replay();
    }
  },

  /* rebuild 的异步版：相位让帧重建 → 让一帧 → 重建标签 → 渲染。
   * 窄屏切层专用（syncLabels 全量重建标签 DOM 也是一块不小的同步活）；
   * 同步路径 rebuild() 保持原样。 */
  async rebuildAsync(project, floorIdx, opts) {
    await this.buildAsync(project, floorIdx, opts);
    /* 缓存换组命中：标签整树已随缓存挂回，跳过全量重建，只刷一次位置 */
    if (this._lastBuildHit) {
      this.updateLabels();
    } else {
      await new Promise((res) => requestAnimationFrame(res));
      this.syncLabels(project);
      if (this.floorCache && this._activeRec) this._activeRec.labels = this.labels;   // 标签入缓存
    }
    this.refresh();
  },

  /* 「重建楼层模型 + 重建标签 + 渲染」三连 —— 编辑页与大屏的统一重建入口。
   * build() 之后必须 syncLabels（标签 DOM 随场景重建）再 refresh（渲染一帧），
   * 这三步曾各自手抄 5 份，漏一步就出现「模型换了标签没换」的错位。
   * opts.keepView → 透传 build（编辑页属性微调保留用户视角，见 build 内注释）。 */
  rebuild(project, floorIdx, opts) {
    this.build(project, floorIdx, opts);
    /* 缓存换组命中：标签整树已随缓存挂回，跳过全量重建，只刷一次位置 */
    if (this._lastBuildHit) {
      this.updateLabels();
    } else {
      this.syncLabels(project);
      if (this.floorCache && this._activeRec) this._activeRec.labels = this.labels;   // 标签入缓存
    }
    this.refresh();
  },

  /* 就地变换：只改某个设备 / 家具实例的 group 变换，不重建场景、不动相机。
   * 供属性面板改 x/y/z/rot/pct 用 —— 这类修改之前走整树 rebuild（dispose 全屋材质、
   * PluginEngine.reset、标签 DOM 全删建），既卡顿又会因回中让视角跳。
   * 只处理「自由摆放」的实例：门窗跟着墙洞口走（assignOpening），移动可能换墙，
   * 必须走 rebuild；这里直接拒绝，由调用方回退。
   * 返回 true = 已就位（调用方无需再重建）。 */
  moveItem(d) {
    if (!this.webglOk || !this.root || !this.itemGroups || !d || !d.id) return false;
    const rec = this.itemGroups.get(d.id);
    if (!rec || rec.attached) return false;   // 未登记 / 门窗 → 交给全量重建
    if (rec.kind === 'furniture') {
      /* 家具的 rot 是弧度、z 是绝对离地高度，缩放挂在外层 group 上（见 buildFurniture） */
      rec.grp.position.set(d.x, d.z || 0, d.y);
      rec.grp.rotation.y = -(d.rot || 0);
      rec.grp.scale.setScalar((d.pct || 100) / 100);
    } else {
      /* 设备的 rot 是度、z 走统一 devY 规则，缩放/水平旋转作用在 body 子组上 */
      rec.grp.position.set(d.x, this.devY(d, rec.type), d.y);
      if (rec.body) {
        rec.body.scale.setScalar((d.pct || 100) / 100);
        rec.body.rotation.y = -((d.rot || 0) * Math.PI) / 180;
      }
    }
    /* 选中环按包围盒画的，跟着挪；setPick 对同一项有 _pickKey 短路，先清掉再重画 */
    const sel = this._sel;
    if (sel && sel.id === d.id) {
      this._pickKey = '';
      this.setPick(sel);
    }
    this.render();
    return true;
  },

  /* 房屋包围盒（背景插件构图的地基）。默认按 floorIdx 指定的楼层取（楼层间户型
   * 尺寸可能不一样，背景构图跟着当前层走）；该层没画墙时回退全屋并集，避免 0×0 构图。
   * floors = 全项目有墙的楼层数（插件参考信息，与取值范围无关）。 */
  computeHouse(project, floorIdx) {
    const all = ((project && project.floors) || []);
    let src = all;
    if (typeof floorIdx === 'number' && all[floorIdx] && ((all[floorIdx].walls) || []).length) {
      src = [all[floorIdx]];
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, floors = 0;
    all.forEach((fl) => { if (((fl && fl.walls) || []).length) floors++; });
    src.forEach((fl) => {
      const ws = (fl && fl.walls) || [];
      if (!ws.length) return;
      ws.forEach((w) => {
        minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
        minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
      });
    });
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 8; maxY = 8; }
    const r2 = (v) => Math.round(v * 100) / 100;
    /* 房屋实体高度（米）：3D 只画当前楼层，所以取该层的层高；没画墙时按缺省户型层高。
     * 只作为高度信息给背景插件（safe.houseH / safe.topY），不参与包围盒 hash。 */
    const flH = (typeof floorIdx === 'number' && all[floorIdx]) ? Number(all[floorIdx].height) : 0;
    const h = {
      minX: r2(minX), maxX: r2(maxX), minY: r2(minY), maxY: r2(maxY),
      w: r2(maxX - minX), d: r2(maxY - minY),
      cx: r2((minX + maxX) / 2), cy: r2((minY + maxY) / 2),
      h: flH > 0 ? r2(flH) : DEFAULT_FLOOR_H,
      floors,
    };
    h.hash = [h.minX, h.maxX, h.minY, h.maxY].join('|');
    return h;
  },

  /* 当前楼层的房屋包围盒（背景插件经 ctx.house 拿到；未构建时按当前项目现算） */
  houseBounds() {
    if (!this.house && this.project) this.house = this.computeHouse(this.project, this.currentFloorIdx);
    return this.house || null;
  },

  /* ---------------- 相机地面限位 ----------------
   * 需求：所有展示页（PC 大屏 / 手机宽屏 / 手机窄屏）相机机位都不能到地面以下。
   * 只写死 maxPolarAngle 不够：OrbitControls 的极角是相对 controls.target 的，而锚点
   * 可被长按、右键平移、取景记忆放到任意高度；锚点一低，整个球坐标会跟着沉到地下。
   * 两层约束：
   *   ① 逐帧按「target.y + r·cos(phi) ≥ 下限」动态收紧 maxPolarAngle，
   *      让 controls.update() 自己在转到地面前停住（保留仰视，只是不穿地）；
   *   ② 兜底整体抬升：pan / frame / flyTo / 记忆机位直接写进来的相机若已在地下，
   *      把 camera.position 与 controls.target 同时抬高同一差值 —— 球面偏移不变，
   *      朝向 / 俯仰 / 距离 / 锚点相对构图全部保留，下一帧也不会被拉回地下。 */
  setGroundLimit(on, opts) {
    this.groundLimitEnabled = on !== false;
    if (opts) {
      if (Number.isFinite(Number(opts.groundY))) this.groundY = Number(opts.groundY);
      if (Number.isFinite(Number(opts.clearance))) this.groundClearance = Math.max(0, Number(opts.clearance));
    }
    if (!this.controls) return;
    if (!this.groundLimitEnabled) { this.controls.maxPolarAngle = MAX_POLAR_ANGLE; return; }
    this.enforceGroundLimit();
  },

  /* 相机允许的最低高度：地面基准面 + 离地间隙 */
  groundLimitY() { return (Number(this.groundY) || 0) + (Number(this.groundClearance) || 0); },

  enforceGroundLimit() {
    if (!this.groundLimitEnabled || !this.controls || !this.camera) return;
    const minY = this.groundLimitY();
    const tgt = this.controls.target, cam = this.camera.position;
    const r = cam.distanceTo(tgt);
    if (r > 1e-4) {
      const cosMax = Math.max(-1, Math.min(1, (minY - tgt.y) / r));
      this.controls.maxPolarAngle = Math.max(MIN_POLAR_EPS, Math.min(MAX_POLAR_ANGLE, Math.acos(cosMax)));
    }
    const d = minY - cam.y;
    if (d > 0) { cam.y += d; tgt.y += d; }
  },

  /* 相机取景：默认定位到户型中心斜上方；
     角度/距离交给调用端（EditApp.vue / PanelApp.vue）自己控制，可选参数：
       pos:    [x,y,z] 相机绝对位置（优先于 dir/dist/zoom）
       dir:    [x,y,z] 相机相对目标点的方向（默认 [8,9,10]）
       dist:   相机距离（默认 √245 ≈ 15.65）
       zoom:   距离系数（dist 缺省时 dist = 默认距离 × zoom，<1 更近）
       target: [x,y,z] 观察目标点（默认户型中心） */
  frame(opts) {
    const o = opts || {};
    const v3 = (v, dft) => Array.isArray(v) ? new THREE.Vector3(v[0], v[1], v[2]) : (v || dft);
    const c = v3(o.target, this.center || new THREE.Vector3(0, 1, 0));
    if (o.pos) {
      this.camera.position.copy(v3(o.pos));
    } else {
      const dir = v3(o.dir, new THREE.Vector3(DEFAULT_CAM_DIR[0], DEFAULT_CAM_DIR[1], DEFAULT_CAM_DIR[2])).normalize();
      let dist = DEFAULT_CAM_DIST;
      if (o.dist != null) dist = o.dist;
      else if (o.zoom != null) dist *= o.zoom;
      this.camera.position.set(c.x + dir.x * dist, c.y + dir.y * dist, c.z + dir.z * dist);
    }
    this.controls.target.copy(c);
    this.enforceGroundLimit();       // 直接指定的机位/锚点也要立刻受地面约束
  },

  /* 房屋基准高度（由背景样式的 houseY 参数驱动；正=悬空/山上，负=低洼）。
   * 只挪 root 与相机/锚点，不动任何实例数据：设备、家具、门窗的高度仍相对房屋。
   * 相机与 controls.target 同步平移同样的差值，用户已调好的取景和自定义锚点都不受影响。 */
  setHouseY(y) {
    const H = Math.max(-10, Math.min(30, Number(y) || 0));
    const d = H - (this.houseY || 0);
    this.houseY = H;
    if (d === 0) return H;              // 重放背景但高度没变：不动相机
    if (this.root) this.root.position.y = H;
    if (this.center) this.center.y = H + 1;
    if (this.controls && this.camera) {
      this.camera.position.y += d;
      this.controls.target.y += d;
      this.controls.update();
      this.enforceGroundLimit();     // houseY 下沉（低洼背景）时别把相机一起带到地下
    }
    return H;
  },

  /* ---- 旋转锚点 ---- */

  /* 屏幕坐标(clientX/Y) → 锚点。优先用真实几何交点（山顶平台 / 坡面 / 房屋地板），
   * 让「长按选中的那个点」的高度就是锚点高度；没打中任何表面时回退到房屋基准面 y=houseY。
   * 不可见的拾取热球（material.visible=false）不算表面，避免锚点莫名落在半空的热球上。 */
  groundPoint(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets = [];
    if (this.backdrop) targets.push(this.backdrop);
    if (this.root) targets.push(this.root);
    const hits = targets.length ? this.raycaster.intersectObjects(targets, true) : [];
    const inOverlay = (o) => {
      for (let p = o; p; p = p.parent) if (p.name === 'onData-overlay') return true;
      return false;
    };
    const solid = hits.find((h) => h.object && h.object.material
      && h.object.material.visible !== false && !inOverlay(h.object));
    if (solid) return solid.point.clone();
    const p = new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(this.houseY || 0));
    return this.raycaster.ray.intersectPlane(plane, p) ? p : null;
  },

  /* 重设旋转锚点（自动旋转/轨道都绕它转）；锚点高度 = 选中表面的高度，带脉冲圆环反馈 */
  setAnchor(pos) {
    if (!pos) return false;
    const lim = (n) => Math.max(-200, Math.min(200, n));
    const limY = (n) => Math.max(-60, Math.min(80, n));
    this.controls.target.set(lim(pos.x), limY(pos.y == null ? this.houseY : pos.y), lim(pos.z));
    this.controls.update();
    this.enforceGroundLimit();       // 长按选到低洼/地下表面时锚点会被一起抬到地面以上
    this.anchorPulse(this.controls.target);
    return true;
  },

  /* 锚点重置回房屋中心（= 初始默认） */
  resetAnchor() {
    const c = this.center || new THREE.Vector3(0, 1, 0);
    this.controls.target.copy(c);
    this.controls.update();
    this.enforceGroundLimit();
    this.anchorPulse(c);
  },

  /* ---- 房间视角（大屏左下角的「全屋 / 房间」按钮）----
   * 平滑飞到某个房间：目标点取该房间地面 mesh 的世界包围盒中心（略抬离地面，
   * 斜俯视才有立体感），机位方向沿用当前水平朝向，距离按房间半径放大；
   * roomId 传空 = 回房屋中心的默认取景。
   * 飞行期间临时关掉自转：自转每帧重算相机位置会和插值打架。 */
  focusRoom(roomId, opts) {
    const o = opts || {};
    let target, dist;
    if (roomId) {
      const mesh = this.roomPickGroups.find((m) => m.userData.room && m.userData.room.id === roomId);
      if (!mesh) return false;
      const box = new THREE.Box3().setFromObject(mesh);
      const ctr = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const r = Math.max(1.2, Math.hypot(size.x, size.z) / 2);
      target = new THREE.Vector3(ctr.x, ctr.y + Math.max(0.8, size.y * 0.5 + 0.8), ctr.z);
      dist = Math.max(4.5, r * 3.4);
    } else {
      target = (this.center || new THREE.Vector3(0, 1, 0)).clone();
      dist = DEFAULT_CAM_DIST;
    }
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(DEFAULT_CAM_DIR[0], DEFAULT_CAM_DIR[1], DEFAULT_CAM_DIR[2]);
    dir.normalize();
    if (dir.y < 0.45) { dir.y = 0.45; dir.normalize(); }   // 太贴近水平会看不见房间内部
    this.flyTo(target.clone().addScaledVector(dir, dist), target, o.dur);
    return true;
  },

  /* ---- 自动旋转 ----
   * 「想不想转」的唯一真相在这里（页面 PanelApp 的 autoRotate 写进来）。
   * 为什么不让各处自己快照 controls.autoRotate：flyTo 飞行 / 平滑取景会临时把它关掉，
   * 恢复时如果用的是自己的快照，而用户恰好在这段时间里点了旋转按钮，恢复就会把用户的
   * 选择按回 false —— 表现就是「点了没反应，界面像卡住」。一律从意图恢复。 */
  autoRotateOn: false,

  /* 临时抑制（飞行 / 平滑取景期间）：不是改意图，只是让画面先别转。
     渲染循环每帧把 controls.autoRotate 校正成「意图 && !hold」——
     所以任何地方误写 controls.autoRotate 都撑不过一帧，自转不会再被静默关掉。 */
  _autoHold: false,

  setAutoRotate(on) {
    this.autoRotateOn = !!on;
    if (this.controls) this.controls.autoRotate = this.autoRotateOn && !this._autoHold;
  },

  holdAutoRotate(hold) {
    this._autoHold = !!hold;
    if (this.controls) this.controls.autoRotate = this.autoRotateOn && !this._autoHold;
  },

  /* 相机插值飞行。相机位置按「绕目标点的球坐标」插值，不是两点直线：
   * 直线 lerp 会让镜头从房屋正中穿过去（贴脸、穿墙），球面插值则始终保持环绕姿态，
   * 观感就是「绕着房子转过去 + 拉近」。飞行期间关掉 damping：阻尼会和逐帧赋值打架，
   * 表现出来就是起手一顿。用户一拖动就中断（controls 'start' → cancelFly）。 */
  flyTo(pos, target, dur) {
    if (!this.controls || !this.camera) return;
    const s0 = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const s1 = new THREE.Spherical().setFromVector3(pos.clone().sub(target));
    /* 水平角走最短路径（差 > 180° 时反向绕过去，否则镜头会甩一整圈） */
    let dth = s1.theta - s0.theta;
    if (dth > Math.PI) dth -= Math.PI * 2;
    if (dth < -Math.PI) dth += Math.PI * 2;
    this._fly = {
      t0: this.controls.target.clone(), t1: target.clone(),
      r0: s0.radius, r1: s1.radius,
      ph0: s0.phi, dph: s1.phi - s0.phi,
      th0: s0.theta, dth,
      t: 0, dur: Math.max(120, dur == null ? 760 : dur),
      auto: this.autoRotateOn,
      damping: this.controls.enableDamping,
    };
    this.holdAutoRotate(true);          // 飞行期间先别转（意图不变，见 _autoHold）
    this.controls.enableDamping = false;
  },
  cancelFly() {
    if (!this._fly) return;
    this.holdAutoRotate(false);         // 按意图恢复（用户可能在飞行中点了旋转）
    this.controls.enableDamping = this._fly.damping;
    this._fly = null;
  },
  tickFly(dt) {
    const f = this._fly;
    if (!f) return;
    f.t += dt * 1000;
    const k = Math.min(1, f.t / f.dur);
    /* easeInOutCubic：起步与收尾都慢，中段快，切换房间不会有生硬的「啪一下」 */
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    this.controls.target.lerpVectors(f.t0, f.t1, e);
    const r = f.r0 + (f.r1 - f.r0) * e;
    const ph = f.ph0 + f.dph * e;
    const th = f.th0 + f.dth * e;
    this.camera.position.setFromSphericalCoords(r, ph, th).add(this.controls.target);
    if (k >= 1) this.cancelFly();
  },

  /* 锚点脉冲圆环: 0.8s 从小扩散淡出（纯视觉反馈，不参与拾取） */
  anchorPulse(pos) {
    this.clearAnchorFx();
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.0, 40),
      new THREE.MeshBasicMaterial({ color: 0x2f7bff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, (pos.y || 0) + 0.04, pos.z);
    this.scene.add(mesh);
    this._anchorFx = { mesh, t: 0 };
  },
  clearAnchorFx() {
    if (!this._anchorFx) return;
    this.scene.remove(this._anchorFx.mesh);
    this._anchorFx.mesh.geometry.dispose();
    this._anchorFx.mesh.material.dispose();
    this._anchorFx = null;
  },
  tickAnchorFx(dt) {
    const f = this._anchorFx;
    if (!f) return;
    f.t += dt;
    const k = f.t / 0.8;
    if (k >= 1) return this.clearAnchorFx();
    const s = 0.25 + k * 2.0;
    f.mesh.scale.set(s, s, s);
    f.mesh.material.opacity = 0.85 * (1 - k);
  },

  buildFloor(fl) {
    // 房屋地板：严格贴合墙体包围盒（不向外扩），就是一个水平面（非下沉薄板）。
    // 给房屋内部一个落脚面；背景插件用的 houseBounds / safe 由 computeHouse() 提供，不受影响。
    // 房间分区面（floor.rooms）另画在它上面 5mm，见下方 buildRoomFloor —— 与 2D 的
    // 「房间在最底层、墙/门窗/家具/设备压在它上面」保持同一套层级。
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ((fl && fl.walls) || []).forEach((w) => {
      minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
      minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
    });
    /* 没墙但有房间（先划区域、后砌墙）时用房间顶点补包围盒，否则这一层会连地面都没有 */
    ((fl.rooms) || []).forEach((r) => {
      ((r && r.pts) || []).forEach(([x, y]) => {
        if (!isFinite(x) || !isFinite(y)) return;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      });
    });
    if (minX === Infinity) return;
    const w = maxX - minX, d = maxY - minY;
    const geo = new THREE.PlaneGeometry(w, d);
    const mat = new THREE.MeshLambertMaterial({ color: 0xb3a78e, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(geo, mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((minX + maxX) / 2, -0.02, (minY + maxY) / 2);
    this.root.add(floor);

    ((fl.rooms) || []).forEach((r) => this.buildRoomFloor(r));
  },

  /* 单个房间的地面分区：ShapeGeometry（three 自带 Earcut 三角化），双面。
   * 坐标：ShapeGeometry 生成在 XY 平面，绕 X 轴 -90° 后 shape 的 y 会落到世界 -z，
   * 所以建形状时先把 2D 的 y 取反 —— 旋转后正好回到 z = +y，与设备/家具的
   * `position.set(x, y, z=flatY)` 映射一致（2D 平面坐标就是 3D 的 XZ 平面）。
   * 高度抬到底地面之上 5mm（-0.02 → -0.015）：同 y 的两张面会 z-fighting 闪烁。
   *
   * 用 MeshBasicMaterial（不受光）而不是 Lambert：房间色是「分区标识」而不是材质，
   * 必须和 2D 色块所见即所得。Lambert 会被三盏灯反复叠加 —— 实测 #e11d48 渲染成
   * (242,175,194)，浅色（#dcecdc 这类）直接洗成接近白色，所以看起来「颜色不生效」。 */
  buildRoomFloor(r) {
    const pts = (r && r.pts) || [];
    if (pts.length < 3) return;
    const shape = new THREE.Shape();
    pts.forEach(([x, y], i) => (i ? shape.lineTo(x, -y) : shape.moveTo(x, -y)));
    shape.closePath();
    /* baseColor 是原始分区色，永不改写；实际显示色由 updateRoomColor() 统一合成。 */
    const baseColor = new THREE.Color(r.color || '#dbe7f3');
    const mat = new THREE.MeshBasicMaterial({
      color: baseColor.clone(),
      side: THREE.DoubleSide,
      /* 分区面永远压在同一层的底地面之上：抬 5mm 已经够，再加 polygonOffset 兜住
       * 相机拉远/斜视时的深度精度抖动，避免大面积闪烁 */
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.015;
    /* 房间地面是「点房间出卡片」的唯一命中面：家具不参与拾取，所以点柜子会穿透到这里；
     * 设备/门窗优先级更高（先 raycast pickGroups），不会被房间抢走。 */
    mesh.userData.room = r;
    /* 房间地面用 Basic 不受光，所以夜间 / 开灯的明暗只能由 lighting.js 直接乘颜色。
     * baseColor 保留原始分区色；亮度与选中高亮都在 updateRoomColor() 里合成，
     * 避免两个功能各自写 material.color、互相覆盖对方的结果。 */
    mesh.userData.baseColor = baseColor;
    mesh.userData.brightness = this._roomLit
      ? (this._roomBrightness[r.id] != null ? this._roomBrightness[r.id] : 0)
      : 1;                       // 首帧（lighting 未接管）保持原色
    mesh.userData.selected = false;
    this.roomPickGroups.push(mesh);
    this.root.add(mesh);
    this.updateRoomColor(mesh, this._roomMin);
  },

  /* ---------------- 光照 / 房间地面亮度（engine/lighting.js 驱动） ----------------
   * 房间色是「分区标识」，历史上刻意用 MeshBasicMaterial 保证与 2D 所见即所得
   * （改 Lambert 会被多灯叠加洗白）。所以明暗不靠打光，而是按房间直接乘颜色。
   * 受光的房屋/背景/GLB/设备不用管：setAmbient() 调两盏基础灯，它们自动跟随。 */
  setAmbient(k, moon) {
    const v = Number.isFinite(k) ? Math.max(0, Math.min(2, k)) : 1;
    const m = Number.isFinite(moon) ? Math.max(0, Math.min(1, moon)) : 0;
    if (this.hemi) {
      this.hemi.intensity = BASE_HEMI * v;
      /* 首次调用时记住白天原色，之后按 moon 系数向冷色 lerp（渐变期间每帧会调） */
      if (!this._baseLightColors) {
        this._baseLightColors = { sky: this.hemi.color.clone(), ground: this.hemi.groundColor.clone(), dir: this.dirLight.color.clone() };
      }
      const bc = this._baseLightColors;
      this.hemi.color.copy(bc.sky).lerp(MOON_SKY, m);
      this.hemi.groundColor.copy(bc.ground).lerp(MOON_GROUND, m);
    }
    if (this.dirLight) {
      this.dirLight.intensity = BASE_DIR * v;
      if (this._baseLightColors) this.dirLight.color.copy(this._baseLightColors.dir).lerp(MOON_DIR, m);
    }
  },

  updateRoomColor(mesh, min) {
    const ud = mesh && mesh.userData;
    if (!ud || !ud.baseColor || !mesh.material) return;
    const lo = Number.isFinite(min) ? min : ROOM_MIN_DEFAULT;
    const b = Math.max(0, Math.min(1, Number.isFinite(ud.brightness) ? ud.brightness : 1));
    /* 关灯 = 底色 × roomMin，开灯 = 底色原值；选中再向品牌蓝靠 35% */
    const c = ud.baseColor.clone().multiplyScalar(lo + (1 - lo) * b);
    if (ud.selected) c.lerp(new THREE.Color('#3b82f6'), 0.35);
    /* 只改 color（uniform），不要 needsUpdate=true：亮度渐变每帧都会走到这里，
     * 标记重编译会让全场景 GLSL 反复重建。 */
    mesh.material.color.copy(c);
  },

  setRoomBrightness(map, min) {
    this._roomLit = true;
    this._roomBrightness = map || {};
    this._roomMin = Number.isFinite(min) ? min : ROOM_MIN_DEFAULT;
    this.roomPickGroups.forEach((m) => {
      const id = m.userData.room && m.userData.room.id;
      m.userData.brightness = id && this._roomBrightness[id] != null ? this._roomBrightness[id] : 0;
      this.updateRoomColor(m, this._roomMin);
    });
  },

  assignOpening(o, kind, fl, wallOpenings) {
    // 找到门窗所在的墙（垂直距离最近且在墙段范围内）
    let best = -1, bestDist = Infinity, bestS = 0;
    ((fl && fl.walls) || []).forEach((w, i) => {
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-6) return;
      let s = ((o.x - w.x1) * dx + (o.y - w.y1) * dy) / len2;
      s = Math.max(0, Math.min(1, s));
      const px = w.x1 + dx * s, py = w.y1 + dy * s;
      const dist = Math.hypot(o.x - px, o.y - py);
      if (dist < bestDist) { bestDist = dist; best = i; bestS = s * Math.sqrt(len2); }
    });
    if (best >= 0 && bestDist < 0.5) wallOpenings[best].push({ o, kind, s: bestS });
  },

  /* 拐角延伸: 两面墙在同一点相交且不共线时，各自端头延伸半个墙厚，填平外角缺口 */
  computeWallExt(walls) {
    const ext = new Map();
    walls.forEach((w) => ext.set(w, [0, 0]));
    const key = (x, y) => Math.round(x * 50) + ',' + Math.round(y * 50);   // ~2cm 精度合并端点
    const at = new Map();
    walls.forEach((w) => {
      [[w.x1, w.y1, 0], [w.x2, w.y2, 1]].forEach(([x, y, e]) => {
        const k = key(x, y);
        if (!at.has(k)) at.set(k, []);
        at.get(k).push({ w, e });
      });
    });
    at.forEach((list) => {
      if (list.length < 2) return;
      for (const a of list) {
        for (const b of list) {
          if (a === b) continue;
          const la = Math.hypot(a.w.x2 - a.w.x1, a.w.y2 - a.w.y1);
          const lb = Math.hypot(b.w.x2 - b.w.x1, b.w.y2 - b.w.y1);
          if (la < 1e-6 || lb < 1e-6) continue;
          // 各墙在交点处“指向外侧”的单位方向
          const ax = (a.e === 0 ? a.w.x1 - a.w.x2 : a.w.x2 - a.w.x1) / la;
          const ay = (a.e === 0 ? a.w.y1 - a.w.y2 : a.w.y2 - a.w.y1) / la;
          const bx = (b.e === 0 ? b.w.x1 - b.w.x2 : b.w.x2 - b.w.x1) / lb;
          const by = (b.e === 0 ? b.w.y1 - b.w.y2 : b.w.y2 - b.w.y1) / lb;
          const cross = ax * by - ay * bx;
          if (Math.abs(cross) > 0.05) { ext.get(a.w)[a.e] = 1; ext.get(b.w)[b.e] = 1; }
        }
      }
    });
    return ext;
  },

  buildWall(w, openings, ext) {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.02) return;
    const t = w.t || 0.24;
    const e0 = ext ? ext[0] * t / 2 : 0, e1 = ext ? ext[1] * t / 2 : 0;
    const H = this.wallH;
    const ux = dx / len, uy = dy / len;
    const DOOR_H = 2.05, WIN_SILL = 0.9, WIN_TOP = 2.1;

    /* 整面墙扣洞（不再按洞口分段拼盒子）。
     * 老做法把墙切成 [墙垛][窗台/门楣][墙垛] 多段、每段还画前后两层面：
     * 段间接壤边 + 半透明双层叠加，洞口旁就会出现一道深色「隔断面」。
     * 现在用 THREE.Shape 画完整墙轮廓，把每个洞口做成 hole / 轮廓凹口，
     * 一次三角化成单个连续面（DoubleSide）；没有内部接壤边，也就没有断面。 */
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    const ops = (openings || []).map((op) => {
      const isDoor = op.kind === 'door';
      /* 门洞放大 OPENING_GAP（与 buildWalls 主路径一致）：门框保持标准尺寸、边缘露在洞口 */
      const L = (op.o.w || DEFAULT_OPENING_W[op.kind]) + (isDoor ? 2 * OPENING_GAP : 0);
      const s0 = cl(op.s - L / 2, 0, len), s1 = cl(op.s + L / 2, 0, len);
      let y0, y1;
      if (isDoor) { y0 = 0; y1 = DOOR_H + OPENING_GAP; }
      else {
        const wz = (op.o && op.o.z) || 0;   // 窗洞随实例离地高度整体上移
        y0 = WIN_SILL + wz; y1 = WIN_TOP + wz;
      }
      return { s0, s1, y0: cl(y0, 0, H), y1: cl(y1, 0, H) };
    }).filter((o) => o.s1 - o.s0 > 0.015 && o.y1 - o.y0 > 0.015)
      .sort((a, b) => a.s0 - b.s0);
    // 相邻的洞挨太近（s 区间重叠）会让轮廓凹口自交 → 合并成一个（取并集）
    const merged = [];
    for (const o of ops) {
      const last = merged[merged.length - 1];
      if (last && o.s0 < last.s1 - 1e-4) {
        last.s1 = Math.max(last.s1, o.s1);
        last.y0 = Math.min(last.y0, o.y0);
        last.y1 = Math.max(last.y1, o.y1);
      } else merged.push({ ...o });
    }

    // 外轮廓：沿底边/顶边走，遇到「贴住该边」的洞就绕成凹口；其余洞做内部 hole
    const shape = new THREE.Shape();
    const A = -e0, B = len + e1;    // 墙两端向外伸半个墙厚，与拐角相邻墙拼合
    const buildShape = (holes) => {
      const s = new THREE.Shape();
      s.moveTo(A, 0);
      for (const o of holes) if (o.y0 <= 1e-4 && o.y1 < H - 1e-4) {
        s.lineTo(o.s0, 0); s.lineTo(o.s0, o.y1);
        s.lineTo(o.s1, o.y1); s.lineTo(o.s1, 0);
      }
      s.lineTo(B, 0); s.lineTo(B, H);
      for (const o of holes.slice().reverse()) if (o.y1 >= H - 1e-4 && o.y0 > 1e-4) {
        s.lineTo(o.s1, H); s.lineTo(o.s1, o.y0);
        s.lineTo(o.s0, o.y0); s.lineTo(o.s0, H);
      }
      s.lineTo(A, H); s.closePath();
      for (const o of holes) if (o.y0 > 1e-4 && o.y1 < H - 1e-4) {
        const h = new THREE.Path();
        h.moveTo(o.s0, o.y0); h.lineTo(o.s0, o.y1);
        h.lineTo(o.s1, o.y1); h.lineTo(o.s1, o.y0);
        h.closePath();
        s.holes.push(h);
      }
      return s;
    };
    /* 整面带洞轮廓 → 有厚度的封闭实体：ExtrudeGeometry 沿 z 挤出 t，再平移让厚度
     * 居中在墙线上（与旧 Box 一致）。墙两端 e0/e1 延伸、洞口凹口/hole 全在这一个 shape 里，
     * 没有内部接壤边；封闭实体用 FrontSide，背向面被剔除，斜视角下只有一层 —— 既有厚度，
     * 又不会像旧分段盒子那样在洞口边叠出深色断面。 */
    const makeGeo = (sh) => {
      const g = new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 1 });
      g.translate(0, 0, -t / 2);
      return g;
    };
    let geo = makeGeo(buildShape(merged));
    // 极端情况（洞贯穿整墙 / 轮廓自交）earcut 会产出 NaN：回退成无洞整墙，保证墙至少还在
    let bad = false;
    {
      const pa = geo.getAttribute('position');
      for (let i = 0; i < pa.count; i++) {
        if (!Number.isFinite(pa.getX(i)) || !Number.isFinite(pa.getY(i)) || !Number.isFinite(pa.getZ(i))) { bad = true; break; }
      }
    }
    if (bad) {
      geo.dispose();
      geo = makeGeo(buildShape([]));
    }
    // 半透明墙体: 透明物体在所有不透明物体之后渲染，家具/设备/门窗不会被墙面挡住；
    // depthWrite=false 避免多面墙相互遮挡产生排序闪烁。封闭实体默认 FrontSide（背向面
    // 剔除），只渲染朝相机的一层，不会像旧的前后两片那样叠加变深。
    if (!this._wallMat) {
      this._wallMat = new THREE.MeshLambertMaterial({
        color: 0xf2f2f0,
        transparent: true,
        opacity: this._wallOpacity != null ? this._wallOpacity : 0.45,
        depthWrite: false,
      });
    }

    const m = new THREE.Mesh(geo, this._wallMat);
    // 局部坐标：x 沿墙方向从墙起点算起，y 为绝对高度；旋转后与整墙摆位一致
    m.position.set(w.x1, 0, w.y1);
    m.rotation.y = -Math.atan2(dy, dx);
    this.root.add(m);
  },

  /* 整层墙体一体绘制（真 3D 布尔，three-bvh-csg）：
   * 1. 每堵墙中心线 + 厚度 → 全高 Box（端头按 ext 延伸半个墙厚），逐个 ADDITION union
   *    成一个连续实体 —— 拐角重叠被布尔合并，不会双重绘制出深色块；
   * 2. 每个门/窗洞 → 略穿透墙厚的盒子逐个 SUBTRACTION 抠出 —— 门上有过梁、窗下有窗台，
   *    高度语义完整保留；整层只有一个 mesh、一次拉起全高，没有任何层间/墙间接缝；
   * 3. 布尔任何环节抛错时由调用方回退到 buildWall 逐墙 Shape 扣洞路径。 */
  buildWalls(fl, wallOpenings, wallExts) {
    const H = this.wallH;
    const DOOR_H = 2.05, WIN_SILL = 0.9, WIN_TOP = 2.1;
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    const boxBrush = (w, h, d, x, y, z, rotY) => {
      const b = new Brush(new THREE.BoxGeometry(w, h, d));
      b.position.set(x, y, z);
      if (rotY) b.rotation.y = rotY;
      b.updateMatrixWorld();
      return b;
    };

    /* 每堵墙 → 全高实体盒；洞口 → 穿透墙厚的盒子（世界坐标，y 为绝对高度） */
    const wallBoxes = [], holeBoxes = [];
    ((fl && fl.walls) || []).forEach((w, i) => {
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      const len = Math.hypot(dx, dy);
      if (len < 0.02) return;
      const t = w.t || 0.24;
      const ext = wallExts && wallExts.get(w);
      const e0 = ext ? ext[0] * t / 2 : 0, e1 = ext ? ext[1] * t / 2 : 0;
      const ux = dx / len, uy = dy / len;
      const rotY = -Math.atan2(dy, dx);
      // 墙体盒：s 从 -e0 到 len+e1（拐角端各伸半个墙厚），中心对应 s=(len+e1-e0)/2
      wallBoxes.push(boxBrush(len + e0 + e1, H, t,
        w.x1 + ux * (len + e1 - e0) / 2, H / 2, w.y1 + uy * (len + e1 - e0) / 2, rotY));
      for (const op of wallOpenings[i] || []) {
        const isDoor = op.kind === 'door';
        /* 门洞比门框标称尺寸略大（OPENING_GAP）：门框保持标准尺寸、边缘露在洞口，
         * 内沿与洞壁错开消除共面波纹；窗洞不放大（窗框内沿本就探入洞内）。 */
        const L = (op.o.w || DEFAULT_OPENING_W[op.kind]) + (isDoor ? 2 * OPENING_GAP : 0);
        const s0 = cl(op.s - L / 2, 0, len), s1 = cl(op.s + L / 2, 0, len);
        if (s1 - s0 < 0.015) continue;
        let y0, y1;
        if (isDoor) { y0 = 0; y1 = DOOR_H + OPENING_GAP; }   // 门恒落地，洞顶抬高一点避开门框上梁共面
        else {
          const wz = (op.o && op.o.z) || 0;                // 窗洞随实例离地高度整体上移
          y0 = WIN_SILL + wz; y1 = WIN_TOP + wz;
        }
        y0 = cl(y0, 0, H); y1 = cl(y1, 0, H);
        if (y1 - y0 < 0.015) continue;
        const th = t + 0.04;   // 盒子略穿透墙厚，保证抠穿
        const sm = (s0 + s1) / 2;
        holeBoxes.push(boxBrush(s1 - s0, y1 - y0, th,
          w.x1 + ux * sm, (y0 + y1) / 2, w.y1 + uy * sm, rotY));
      }
    });
    if (!wallBoxes.length) return;

    // 半透明墙体: 透明物体在所有不透明物体之后渲染，家具/设备/门窗不会被墙面挡住；
    // depthWrite=false 避免透明面相互遮挡产生排序闪烁。布尔结果是封闭实体 FrontSide，
    // 只渲染朝相机的一层。与 buildWall 共用同一份材质（透明度跟随楼层设置）。
    if (!this._wallMat) {
      this._wallMat = new THREE.MeshLambertMaterial({
        color: 0xf2f2f0,
        transparent: true,
        opacity: this._wallOpacity != null ? this._wallOpacity : 0.45,
        depthWrite: false,
      });
    }

    const ev = new Evaluator();
    ev.useGroups = false;                 // 单材质输出，直接配 _wallMat
    ev.attributes = ['position', 'normal'];
    let result = wallBoxes[0];
    for (let i = 1; i < wallBoxes.length; i++) {
      const next = ev.evaluate(result, wallBoxes[i], ADDITION);
      if (result !== wallBoxes[0]) result.geometry.dispose();   // 中间结果即时释放
      result = next;
    }
    for (const hb of holeBoxes) {
      const next = ev.evaluate(result, hb, SUBTRACTION);
      if (result !== wallBoxes[0]) result.geometry.dispose();
      result = next;
    }
    // NaN 兜底：布尔万一产出坏几何，抛给调用方回退逐墙路径
    const pa = result.geometry.getAttribute('position');
    for (let i = 0; i < pa.count; i++) {
      if (!Number.isFinite(pa.getX(i)) || !Number.isFinite(pa.getY(i)) || !Number.isFinite(pa.getZ(i))) {
        result.geometry.dispose();
        throw new Error('wall CSG produced NaN');
      }
    }
    this.root.add(new THREE.Mesh(result.geometry, this._wallMat));
  },

  /* 门/窗不再有本文件内的绘制实现：rebuild() 把它们当 type:'door'/'window' 的设备走 buildDevice()，
   * 造型、GLB、开合动画、无插件时的占位全部在插件引擎侧（见 plugins.js） */

  buildFurniture(f) {
    const grp = new THREE.Group();
    // 形态解析: mid → 目录形态定义（assets 动态目录；尺寸/模型/颜色由 furnSpec 统一解析）
    const S = furnSpec(f);
    if (S.model && GLTFLoader) {
      this.loadModel(S.model).then((proto) => {
        if (!proto) { this.buildFallbackFurniture(f, grp); this.render(); return; }  // 模型缺失 → 内置体块兜底
        const inst = proto.clone(true);
        /* 归一化：让模型包围盒**精确填满** 2D 占位框 w×d。
         * x / z 各自独立换算比例（非等比）：模型长宽比与目录声明不一致时（如 bed.glb 实际
         * 1.478×1.952，目录写 1.8×2）会被横向拉伸，换来的是 2D 与 3D 的占位完全一致 ——
         * 家具相邻关系（床头柜紧贴床沿等）在两边看到的是同一套几何。
         * y 不参与贴合：取 x/z 中较紧的比例，避免非等比把家具拉高（与旧的等比行为一致）。 */
        const box = new THREE.Box3().setFromObject(inst);
        const size = box.getSize(new THREE.Vector3());
        const defScale = S.scale || 1;
        const sx = (S.w / (size.x || 1)) * defScale;
        const sz = (S.d / (size.z || 1)) * defScale;
        const sy = Math.min(sx, sz);
        inst.scale.set(inst.scale.x * sx, inst.scale.y * sy, inst.scale.z * sz);
        /* ⚠ GLB 原点不保证在包围盒中心（实测 bed.glb 偏 x -0.27m、nightstand.glb 偏 -0.12/+0.10m）。
           2D 是按 w×d「居中」画在 (x,y) 上的，这里必须把包围盒中心对到 group 原点：
           只校正 y（贴地）而放任 x/z 用 GLB 原点，模型会整体偏到占位框一侧，
           与相邻家具之间凭空出现空隙 —— 表现为「2D 紧贴、3D 有缝」。 */
        const c = box.getCenter(new THREE.Vector3());
        inst.position.set(-c.x * sx, -box.min.y * sy, -c.z * sz);
        grp.add(inst);
        this.render();
      });
    } else {
      this.buildFallbackFurniture(f, grp);
    }
    grp.position.set(f.x, f.z || 0, f.y);
    grp.rotation.y = -(f.rot || 0);
    grp.scale.setScalar((f.pct || 100) / 100);   // 整体比例(%)：GLB 与体块兜底统一缩放
    /* 同设备：登记句柄，属性面板改 x/y/rot/pct 走 moveItem 就地变换（拖动不卡、视角不跳） */
    if (this.itemGroups) this.itemGroups.set(f.id, { kind: 'furniture', type: 'furniture', grp, body: null });
    this.root.add(grp);
  },

  _gltfCache: {},
  _gltfProto: {},   // url → 已解析的 GLB 原型场景（_gltfCache 的同步可用版，供 disposeGroup 排除共享资源）
  loadModel(url) {
    if (this._gltfCache[url]) return this._gltfCache[url];
    this._gltfCache[url] = new Promise((resolve) => {
      new GLTFLoader().load(url, (gltf) => { this._gltfProto[url] = gltf.scene; this._sharedRes = null; resolve(gltf.scene); }, undefined, () => resolve(null));
    });
    return this._gltfCache[url];
  },

  /* 兜底绘制: 模型缺失/加载失败时按家具占位尺寸画一个盒子 */
  buildFallbackFurniture(f, grp) {
    const S = furnSpec(f);
    this.addBox(grp, S.w, S.h, S.d, 0, S.h / 2, 0, S.color);
    this.render();
  },

  addBox(grp, w, h, d, x, y, z, color) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: new THREE.Color(color) }));
    mesh.position.set(x, y, z);
    grp.add(mesh);
    return mesh;
  },

  /* 锚点离地高度（统一）:
   *   d.z 优先（面板「离地高度」实例值）
   *   门/窗/家具（非 HA 实体的贴地/独立类型）→ 插件 def.z 声明（门窗通常 z:0 贴地），未声明回退 0
   *   设备 → 目录造型 z（deviceDefaultZ），缺省 1.2m */
  devY(d, type) {
    if (d.z != null) return d.z;
    if (type === 'door' || type === 'window' || type === 'furniture') {
      const def = (window.PluginEngine && PluginEngine.defFor) ? PluginEngine.defFor(type, d.style) : null;
      return def && def.z != null ? def.z : 0;
    }
    return deviceDefaultZ(d, type);
  },

  /* 模型建造（设备与门/窗统一）: 插件造型完全由插件负责，本函数只做与造型无关的事:
   * 通用变换（锚点/比例/水平旋转）与拾取热区。type 缺省取 d.type（门/窗由调用方显式传入）。
   * 锚点高度规则见 devY；rot 全链统一存「度」（含门/窗，编辑器沿墙吸附时已转度）。 */
  buildDevice(d, type) {
    type = type || devTypeOf(d);
    const grp = new THREE.Group();
    const body = new THREE.Group();   // 造型节点（比例/水平旋转作用于此，不影响热区）
    grp.add(body);

    if (window.PluginEngine) PluginEngine.spawnDevice(d, type, this, body);

    // 通用变换: 离地高度 / 整体比例(%) / 水平旋转（全链统一 °，与 2D/面板同一单位）
    body.scale.setScalar((d.pct || 100) / 100);
    body.rotation.y = -((d.rot || 0) * Math.PI) / 180;

    grp.position.set(d.x, this.devY(d, type), d.y);
    grp.userData.device = d;
    grp.userData.devType = type;
    // 锚点热球: 保底热区（模型很小 / 插件缺失时也有得点）。
    // 完整模型拾取在 pick() —— 对整个设备组递归 raycast，点灯罩/灯杆/门板同样能开关
    // 球心高度按插件 def.hitY 声明（窗 1.4 / 门 1.1，设备 0 = 锚点处）
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = (window.PluginEngine && PluginEngine.hitY) ? PluginEngine.hitY(type, d.style) : 0;
    hit.userData.deviceRef = grp;
    grp.add(hit);
    this.pickGroups.push(grp);
    /* 登记句柄供 moveItem 就地改变换：门窗挂 attached，移动必须走全量重建
     * （assignOpening 决定墙洞口，挪位置可能换墙） */
    if (this.itemGroups) {
      this.itemGroups.set(d.id, {
        kind: 'device', type, grp, body,
        attached: type === 'door' || type === 'window',
      });
    }
    this.root.add(grp);
  },


  /* ---------------- 实时状态刷新 ----------------
   * 有状态模型（灯光发光、叶片开合、屏幕读数…）全部由插件在 HA 'change' 时拿 update() 自行处理，
   * 这里只做一次渲染同步 —— 旧的内置 bulbMat/点光源补丁已随 fallback 一起移除 */
  refresh() {
    if (!this.root) return;
    this.render();
  },

  /* ---------------- HTML 标签（实时数据显示） ----------------
   * syncLabels 时把每设备重算不变的量缓存进标签记录（DOM 子节点引用、类型、
   * labelOffset、click 规格）—— updateLabels 每帧跑，这些查询链不在帧循环里重复做 */
  syncLabels(project) {
    if (!this.webglOk) return;
    const wrap = this.wrap;
    this.clearLabels();
    if (!this.root) return;
    const fl = project.floors[this.currentFloorIdx];
    if (!fl) return;
    /* 设备与门/窗同一套标签管线：type 就是插件 type（HA 域或 door/window），
     * 判定/文案/点击全走同一套插件契约 */
    const addLabel = (d, type) => {
      /* 标签显隐由插件注册时的 labels 参数决定（设备缺省开、门/窗缺省关，插件可显式开启） */
      if (window.PluginEngine && !PluginEngine.wantsLabel(type, d.style)) return;
      const el = document.createElement('div');
      el.className = 'dev3d-label';
      // 可点击控制: 由插件 click 规格（或内置默认）决定，实例可在属性面板勾选/取消
      if (this.clickSpecOf(d, type)) el.classList.add('clickable');
      el.innerHTML = '<span class="ln"></span><br><span class="lv"></span>';
      /* 标签点击 = 就地执行插件的 click（开关设备），三页一致。
       * 与 canvas 点击分开：显示标签时 canvas 只「选中出卡」，标签是唯一执行入口；
       * 隐藏标签时标签 DOM 整体 display:none，canvas 才接管执行（标签不冒泡到 canvas）。 */
      el.addEventListener('click', () => this.toggleDevice(d, type));
      wrap.appendChild(el);
      this.labels.push({
        el, d, type,
        wall: type === 'door' || type === 'window',
        ln: el.querySelector('.ln'),
        lv: el.querySelector('.lv'),
        off: window.PluginEngine ? PluginEngine.labelOffset(type, d.style) : 0.3,
      });
    };
    (fl.devices || []).forEach((d) => addLabel(d, devTypeOf(d)));
    (fl.doors || []).forEach((o) => addLabel(o, 'door'));
    (fl.windows || []).forEach((o) => addLabel(o, 'window'));
    this._labelWait = performance.now();   // 本轮标签等待 HA 的起点（超 3s 降级显示，见 updateLabels）
    this.updateLabels();
  },

  updateLabels() {
    /* 标签显示条件:
     *   - 编辑页顶栏关标签 → 全隐藏
     *   - HA 状态还没到（首帧）→ 先隐藏，最多等 3s（等不到就降级显示「无数据」，
     *     不会因为 HA 连不上而永远不显示标签） */
    const waiting = !HA.loaded() && (performance.now() - (this._labelWait || 0) < 3000);
    if (this.labelsVisible === false || waiting) {
      this.labels.forEach(({ el }) => { el.style.display = 'none'; });
      return;
    }
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    const v = this._labelV || (this._labelV = new THREE.Vector3());   // 每帧复用，避免逐标签 new
    this.labels.forEach((L) => {
      const { el, d } = L;
      /* 标签锚点: 设备 = 锚点上方；门/窗 = 贴墙模型中部（插件 def.labelBaseY 声明，
       * door 1.05 / window 1.45；未声明回退 devY）。抬升量：实例覆盖（属性面板「标签高度」）
       * > 造型声明的 labelOffset > 插件 def.labelOffset > 引擎缺省 0.3；实例值每帧现读 */
      const off = d.labelOffset != null ? d.labelOffset : L.off;
      const base = (window.PluginEngine && PluginEngine.labelBaseY)
        ? PluginEngine.labelBaseY(L.type, d.style) : null;
      const anchorY = base != null ? base : this.devY(d, L.type);
      /* 标签是 DOM、不在 root 子树里，手工拼世界坐标时要补上房屋基准高度 H，
       * 否则房屋抬到山顶后标签会留在山脚。设备/家具本身由 root 整体抬升，不用单独加。 */
      v.set(d.x, (this.houseY || 0) + anchorY + off, d.y).project(this.camera);
      if (v.z > 1) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.left = ((v.x + 1) / 2 * w) + 'px';
      el.style.top = ((-v.y + 1) / 2 * h) + 'px';
      const st = HA.getState(d.entityId);
      /* 有状态才用 HA 的 friendly_name；拿不到时门/窗显示类型名，设备不闪现内部 id */
      L.ln.textContent = st ? HA.friendly(d.entityId)
        : (d.name || (L.wall ? (L.type === 'door' ? '门' : '窗') : ''));
      const lv = L.lv;
      if (!st) { lv.textContent = '无数据'; el.classList.remove('on'); return; }
      const unit = st.attributes ? st.attributes.unit_of_measurement || '' : '';
      /* 状态文案优先由插件声明（PluginEngine.labelOf → 插件 stateText(state, obj, get)），
       * obj 里带着扩展实体绑定字段，插件可把功率/温湿度/曲目等一并拼进文案。
       * 未声明时回退通用规则: on/off → 已开启/已关闭，其余 state + 单位 */
      const pluginTxt = window.PluginEngine ? PluginEngine.labelOf(L.type, st, d, null, d.style) : null;
      if (pluginTxt) {
        lv.textContent = pluginTxt;
      } else {
        /* 底座统一问引擎 baseStateText（on/open/off/closed → 中文），认不出的状态原样 + 单位 */
        const base = PluginEngine.baseStateText(st);
        lv.textContent = base !== st.state ? base : (st.state + (unit ? ' ' + unit : ''));
      }
      /* 高亮判定走统一入口（插件顶层 isOn → 默认规则），与 2D / 统计同口径。
       * 传完整实例：复合 isOn 要读 fields 绑定（powerEntity 等），只给
       * {entityId,type,style} 会把这类设备恒判成「关」、标签永不高亮。 */
      el.classList.toggle('on', HA.deviceIsOn(Object.assign({}, d, { type: L.type })));
    });
  },

  clearLabels() {
    this.labels.forEach(({ el }) => el.remove());
    this.labels = [];
  },

  /* ---------------- 交互 ----------------
   * 拾取 = 对所有可点击模型根 Group（设备 + 门/窗）递归 raycast（点模型任意部位都算：
   * 灯罩/灯杆/底盘/门板…），命中 mesh 沿父链回溯找带 userData.device 的设备组；
   * 类型在 userData.devType（门/窗实例数据没有 type 字段，建造时写入）。
   * 不再只依赖锚点热球 —— 球只有 0.32m 半径，高设备（落地灯灯罩 1.5m+）点上去毫无反应 */
  pick(e) {
    this.raycaster.setFromCamera(this.ndcOf(e), this.camera);
    const hits = this.raycaster.intersectObjects(this.pickGroups, true);
    for (let i = 0; i < hits.length; i++) {
      let o = hits[i].object;
      while (o) {
        if (o.userData && o.userData.device) return o;
        o = o.parent;
      }
    }
    return null;
  },

  ndcOf(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
  },

  /* 房间地面拾取：设备/门窗都没命中时才走这里（见 onClick）。
   * 只有显示标签（onPick 已装载）时才调用 —— 隐藏标签时点设备直接执行，不需要选房间。 */
  pickRoom(e) {
    if (!this.roomPickGroups.length) return null;
    this.raycaster.setFromCamera(this.ndcOf(e), this.camera);
    const hits = this.raycaster.intersectObjects(this.roomPickGroups, false);
    for (let i = 0; i < hits.length; i++) {
      const o = hits[i].object;
      if (o.userData && o.userData.room) return o;
    }
    return null;
  },

  /* ---------------- 选中高亮（仅大屏） ----------------
   * 3D 场景没有 DOM 焦点，卡片又贴在右侧面板上：不高亮的话点完根本不知道选中了谁。
   * 房间 = 地面提色 + 蓝色描边；设备/门窗 = 地面蓝色圆环（不碰插件模型本身，
   * 免得和插件自己的发光/状态材质打架）。只保留一份高亮，切换时先清旧再建新。 */
  clearPickHi() {
    const hi = this._pickHi;
    if (!hi) return;
    /* 房间地面是场景里长期存在的 mesh：只清高亮标志，颜色交回 updateRoomColor 合成。
     * 不能直接 copy 旧颜色 —— 那会把 lighting 写进来的夜间亮度一起抹掉。 */
    if (hi.roomMesh) {
      hi.roomMesh.userData.selected = false;
      this.updateRoomColor(hi.roomMesh, this._roomMin);
    }
    (hi.temp || []).forEach((o) => {
      if (o.parent) o.parent.remove(o);
      this.disposeGroup(o);   // 描边/圆环是每次选中新建的，随清随建
    });
    this._pickHi = null;
    this._pickKey = null;
  },

  /* sel: { kind:'room'|'device'|'door'|'window', id } | null（与展示页选中项同结构） */
  setPick(sel) {
    /* 记住当前选中项：moveItem 挪完要按新包围盒重画高亮环 */
    this._sel = sel || null;
    if (!this.webglOk || !this.root) return;
    const key = sel && sel.id ? sel.kind + ':' + sel.id : '';
    if (key === this._pickKey) return;   // 同一项重复设置（含 null）不重建几何
    this.clearPickHi();
    if (!key) return;
    this._pickKey = key;
    const hi = { temp: [] };

    if (sel.kind === 'room') {
      const mesh = this.roomPickGroups.find((m) => m.userData.room && m.userData.room.id === sel.id);
      if (!mesh) return;
      const room = mesh.userData.room;
      hi.roomMesh = mesh;
      /* 提亮 = 底色向品牌蓝靠 35%（在 updateRoomColor 里做）：既保留房间自己的颜色，
       * 又不会覆盖 lighting 写进来的亮度。 */
      mesh.userData.selected = true;
      this.updateRoomColor(mesh, this._roomMin);
      const pts = (room.pts || []);
      if (pts.length >= 3) {
        /* 描边坐标与地面同源：形状里写的是 (x, -y)，绕 X 轴 -90° 后落到世界 (x, 0, y) */
        const vs = pts.map(([x, y]) => new THREE.Vector3(x, -0.004, y));
        const line = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(vs),
          new THREE.LineBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.95 })
        );
        hi.temp.push(line);
        this.root.add(line);
      }
    } else {
      const grp = this.pickGroups.find((g) => g.userData.device && g.userData.device.id === sel.id);
      if (!grp) return;
      /* 圆环按包围盒定尺寸：落地灯细高、空调扁宽都能贴住，不用每类插件再声明占地 */
      const box = new THREE.Box3().setFromObject(grp);
      if (!isFinite(box.min.x)) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const r = Math.max(0.16, Math.max(size.x, size.z) / 2 + 0.12);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(0.1, r - 0.05), r, 48),
        new THREE.MeshBasicMaterial({ color: 0x3b82f6, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(center.x, box.min.y + 0.015, center.z);
      hi.temp.push(ring);
      this.root.add(ring);
    }
    this._pickHi = hi;
  },

  onClick(e) {
    if (this._anchorPicked) { this._anchorPicked = false; return; }   // 长按设锚点后的松手不算点击，避免误触开关
    if (this._dragged) { this._dragged = false; return; }             // 拖动旋转视角后的松手也不算点击
    const grp = this.pick(e);
    /* 显示标签（onPick 已装载）：点击 = 选中出卡（设备优先 → 房间；都没有 = 空白 →
     * 清空选中）。执行动作只走设备标签与卡片控件，canvas 不再「点一下就 toggle」。 */
    if (this.onPick) {
      if (grp) { this.onPick({ kind: 'device', item: grp.userData.device, devType: grp.userData.devType }); return; }
      const rm = this.pickRoom(e);
      this.onPick(rm ? { kind: 'room', item: rm.userData.room } : null);
      return;
    }
    /* 不显示标签（onPick 为 null）：没有可点的标签，点设备模型直接执行动作 */
    if (!grp) return;
    this.toggleDevice(grp.userData.device, grp.userData.devType);
  },

  /* 点击控制规格（门禁）: 实例级「能不能点」的唯一实现在 PluginEngine.instanceClickSpec
   * （d.click 强制开关 / clickSvc 覆盖 / 插件 defaultOn 的叠加规则都收在那里），
   * 这里只做薄转发 —— SelectionInspector 的「启用点击」勾选框也走同一方法。
   * 「发不发服务」与「能不能点」分离：没绑实体的实例也可能可点，toggleDevice 末尾统一拦截。
   * typeOrKind: HA 实体类型或贴墙类型 door/window（门/窗实例数据里没有 type 字段，由调用方传入）
   */
  clickSpecOf(d, typeOrKind) {
    return PluginEngine.instanceClickSpec(d, typeOrKind);
  },

  /* 点击 → 发服务（设备与门/窗统一入口，type = HA 域或贴墙类型 door/window）。
   * 唯一实现在 services/ha.js 的 HA.toggle：实例级门控（click / clickSvc / defaultOn）、
   * clickSvc 覆盖解析、自定义函数 api{call,get,toast} 都在那里。
   * 保留同名方法做转发 —— 3D 标签点击、canvas 点击、大屏标签都调它，调用点不用动。 */
  toggleDevice(d, typeOrKind) {
    HA.toggle(d, typeOrKind);
  },

  /* 设备标签显示开关（三页顶栏 / 工具条均可切换；点击语义由 model/pick.js 同步拨动） */
  setLabelsVisible(v) {
    this.labelsVisible = !!v;
    this.updateLabels();
  },

  render() {
    if (this._building) return;   // 场景重建期间跳过：插件 put 的中间渲染一律吞掉，建完统一画一次
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  },

  startLoop() {
    if (!this.webglOk) return;
    if (this._loopRunning) return;   // 重入守卫：重复调用会让多个 rAF 循环叠加（双倍渲染 + dt 抖动）
    this._loopRunning = true;
    let last = performance.now();
    const loop = () => {
      this._loopRaf = requestAnimationFrame(loop);
      if (this.wrap.classList.contains('hidden')) { last = performance.now(); return; }
      const dt = Math.min(0.1, (performance.now() - last) / 1000);
      last = performance.now();
      this.tickAnchorFx(dt);
      this.tickFly(dt);            // 相机飞行（房间视角）要在 controls.update 之前写位置
      /* 自转意图每帧校正：单点真相是 autoRotateOn，只有飞行 / 平滑取景能临时按住。
         不这么写的话，任何一处遗留的 controls.autoRotate = false 都能把自转永久关掉，
         而 UI 上的开关还是亮的 —— 就是「点了没反应，切一次主题才好」那种怪象。 */
      if (this.controls) this.controls.autoRotate = this.autoRotateOn && !this._autoHold;
      this.controls.update();
      this.enforceGroundLimit();   // 每帧兜底：拖拽 / 平移 / 飞行 / 自转都不许沉到地面以下
      if (window.PluginEngine) PluginEngine.tick(dt, this.currentFloorIdx);   // 逐帧动画（暂存层实例跳过，见 plugins.js tick）
      /* 走 render() 而不是直接 renderer.render：_building 期间（buildAsync 相位让帧）
         不能把半成品场景画出去，守卫只在 render() 里有 —— 之前这里绕过了它。 */
      this.render();
      if (this.labels.length) this.updateLabels();
    };
    loop();
  },

  disposeGroup(g) {
    /* GLB 缓存原型（_gltfProto）被 clone(true) 出的实例共享 geometry/material：
     * 一并 dispose 会让下一次渲染重新上传顶点缓冲 + 重编译材质
     * （切层/撤销频繁时表现为可感知卡顿与内存抖动）。
     * 先收集原型持有的资源，实例侧只释放自己独享的。
     * 共享集合随 _gltfProto 缓存（loadModel 成功时置空失效），不必每次重建重算。 */
    if (!this._sharedRes) {
      const shared = new Set();
      const protos = this._gltfProto || {};
      for (const url in protos) {
        protos[url].traverse((o) => {
          if (o.geometry) shared.add(o.geometry);
          if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => shared.add(m));
        });
      }
      this._sharedRes = shared;
    }
    const shared = this._sharedRes;
    g.traverse((o) => {
      if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          if (m === this._wallMat) return;   // 引擎持有的复用材质不回收（否则每次重建都重编译墙面着色器）
          if (!shared.has(m)) m.dispose();
        });
      }
    });
  },
};
