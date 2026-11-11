
/*
 * view3d.js — Three.js 3D 展示
 * 墙体分段开洞 / 地板 / 家具 GLB 体块 / 门窗与设备（造型全由插件生成，这里只做变换与拾取）
 * 背景挂载 / 楼层切换 / 点击控制 / 实时标签
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HA } from '../services/ha.js';
import { furnSpec } from '../model/catalog.js';
import { PluginEngine } from './plugins.js';
import { applyLegacyRenderer } from './three-legacy.js';

export const View3D = {
  renderer: null, scene: null, camera: null, controls: null,
  root: null,              // 当前楼层根节点
  wrap: null,
  houseY: 0,               // 房屋地板相对背景基准面 y=0 的高度（米，可为负）；由背景样式参数 houseY 驱动
  pickGroups: [],          // 可点击模型根 Group（设备 + 门/窗；拾取时递归 raycast，命中后沿父链回溯）
  labels: [],              // {el, d}：el = 标签 DOM，d = 设备数据
  labelsVisible: true,     // 标签显示开关（编辑页顶栏可切换）
  currentFloorIdx: 0,
  raycaster: null,
  wallH: 2.8,

  /* 背景重放状态（统一管理，避免 build / applyBg 各写一份导致状态漂移）
   * _bgKey 只在「重放成功」后提交；失败保留旧值，下一次 build 会自动重试。 */
  _bgKey: '',
  _bgFloorIdx: -1,
  _bgReplay: null,
  _bgRetry: null,      // 重放失败后的自动重试 timer（插件 loadAll 异步，别等用户再操作）
  _bgFail: 0,          // 连续失败次数，超过 3 次停手，避免坏插件刷屏

  webglOk: true,

  init(wrapId) {
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

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    this.camera.position.set(9, 10, 11);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    /* 允许略微仰视（polar > 90°）：房屋悬空/建在山顶时，能看到房屋底面与底下的地形 */
    this.controls.maxPolarAngle = Math.PI * 0.66;

    this.raycaster = new THREE.Raycaster();

    // 灯光（半球光 + 平行光；基础场景不逐灯加 PointLight，灯具自身的补光由插件 lightKit 负责）。
    // ⚠ 强度不再手动 ×π：legacy 灯光口径由 three-legacy.js 的 applyLegacyRenderer（_useLegacyLights=true）
    //    在 renderer 层统一接管，等效旧 vendor three（r147）观感；这里只写「原始强度」，避免二次放大过曝。
    this.scene.add(new THREE.HemisphereLight(0xdfeaff, 0x8a7a66, 1.05));
    const dir = new THREE.DirectionalLight(0xffffff, 0.5);
    dir.position.set(8, 14, 6);
    this.scene.add(dir);

    this.resize();
    window.addEventListener('resize', () => this.resize());

    // 点击设备
    const dom = this.renderer.domElement;
    dom.addEventListener('click', (e) => this.onClick(e));
    dom.addEventListener('mousemove', (e) => {
      const hit = this.pick(e);
      dom.style.cursor = hit ? 'pointer' : '';
    });

    // 长按左键重设旋转锚点（index/display 通用）:
    // 按住 ~500ms 不拖动 → 锚点设为所指地面点；拖拽旋转（按下即移动）/快速点按互不冲突。
    // 是否持久化由调用端决定: 显示页设 View3D.onAnchor = 回调，编辑页不设（不持久化）。
    let pressTimer = null, pressPos = null;
    const clearPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } pressPos = null; };
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pressPos = { x: e.clientX, y: e.clientY };
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        pressTimer = null;
        if (!pressPos) return;
        if (this.setAnchor(this.groundPoint(pressPos.x, pressPos.y))) {
          this._anchorPicked = true;   // 松手时 onClick 据此跳过，防止长按后误触设备开关
          if (typeof this.onAnchor === 'function') this.onAnchor();
        }
      }, 500);
    });
    dom.addEventListener('pointermove', (e) => {
      // 按下后拖动超过 8px = 在旋转视角，取消长按判定
      if (pressPos && Math.hypot(e.clientX - pressPos.x, e.clientY - pressPos.y) > 8) clearPress();
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

  /* 背景构图输入指纹。只有这些量全一致，旧的背景 group 才能继续复用：
   * 楼层 / 房屋包围盒 / 层高 / 背景样式 / 三个位置参数。
   * 位置参数读 bgOptions 里的「保存值」（不含 def 默认值），保证 key 稳定不抖动；
   * 把它们也纳入是为了让「显式重放失败」能靠下一次 build 自愈。 */
  bgKeyOf() {
    const h = this.house || (this.project ? this.computeHouse(this.project, this.currentFloorIdx) : null);
    const bo = (window.PluginEngine && PluginEngine.bgOptions
      && PluginEngine.bgOptions[this.bgId]) || {};
    return [this.currentFloorIdx, h ? h.hash : '', h ? h.h : '',
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
  build(project, floorIdx) {
    if (!this.webglOk) return;
    this.resize();   // 容器刚从隐藏变可见时必须重新计算尺寸，否则渲染不出来
    this.currentFloorIdx = floorIdx || 0;
    this.project = project;   // houseBounds() 在场景未构建时也能现算
    this.clearAnchorFx();
    if (window.PluginEngine) PluginEngine.reset();   // 注销上一轮插件实例
    if (this.root) { this.scene.remove(this.root); this.disposeGroup(this.root); }
    this.pickGroups = [];
    this.clearLabels();
    this.root = new THREE.Group();

    const fl = project.floors[this.currentFloorIdx];
    if (!fl) return;
    this.wallH = fl.height || 2.8;
    // 墙面不透明度(%)：按楼层记忆，默认 45
    this._wallOpacity = (fl.wallOpacity != null ? fl.wallOpacity : 45) / 100;
    if (this._wallMat) this._wallMat.opacity = this._wallOpacity;

    this.buildFloor(fl);
    // 把门窗归属到最近的墙，墙体真实掏洞
    const wallOpenings = fl.walls.map(() => []);
    (fl.windows || []).forEach((wd) => this.assignOpening(wd, 'window', fl, wallOpenings));
    (fl.doors || []).forEach((d) => this.assignOpening(d, 'door', fl, wallOpenings));
    const wallExts = this.computeWallExt(fl.walls);
    fl.walls.forEach((w, i) => this.buildWall(w, wallOpenings[i], wallExts.get(w)));
    // 门/窗 = type:'door'/'window' 的贴墙设备，与设备走同一条建造路径（模型/热区/标签/点击全套同构）
    if (window.PluginEngine) {
      (fl.windows || []).forEach((wd) => this.buildDevice(wd, 'window'));
      (fl.doors || []).forEach((d) => this.buildDevice(d, 'door'));
    }
    (fl.furniture || []).forEach((f) => this.buildFurniture(f));
    (fl.devices || []).forEach((d) => this.buildDevice(d));

    /* 房屋整体基准高度：设备/家具/门窗都挂在 root 下，它们的高度仍然是「相对房屋」的，
     * 这里统一抬升整组即可，实例数据（d.z / obj.z / project.json）不写 H。 */
    this.root.position.y = this.houseY;
    this.scene.add(this.root);
    // 旋转/环绕锚点 = 户型包围盒中心（而不是固定原点，否则模型不在原点时会绕角落转）
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    fl.walls.forEach((w) => {
      minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
      minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
    });
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 8; maxY = 8; }
    /* 锚点 y 贴合房屋基准高度：H+1 保持原来「房屋中心上方 1m」的相对量。
     * 相机跟着 target 一起平移同样差值，重建（切层 / 拖墙 / 撤销）时构图不跳。 */
    this.center = new THREE.Vector3((minX + maxX) / 2, this.houseY + 1, (minY + maxY) / 2);
    const prevTarget = this.controls.target.clone();
    this.controls.target.copy(this.center);
    this.camera.position.add(this.center.clone().sub(prevTarget));
    this.controls.update();

    /* 当前楼层的房屋包围盒：背景插件按它决定在哪里画。
     * 按层取（楼层间户型尺寸可能不一样，背景构图跟着当前层走）。
     * 重放判定键 = 楼层号 | 包围盒 | 层高 | 背景样式 | 位置参数（见 bgKeyOf），
     * 任一变化都要重画背景：
     *   · 切层：哪怕两层户型完全一样也必须重放（背景按「当前层」构图），
     *     否则背景停在上一层的落点，房屋就会画到平台外面；
     *   · 拖墙 / 改尺寸 / 改层高：走 160ms 防抖，避免连续重建把带 3D 体块的插件跑爆；
     *   · 换背景 / 改位置参数：通常由 applyBg() 显式重放，纳入 key 是失败后的自愈兜底。
     * 插件不需要、也不应该自己通知重绘 —— 这是引擎的职责。 */
    this.house = this.computeHouse(project, this.currentFloorIdx);
    const bgKey = this.bgKeyOf();
    const floorChanged = this._bgFloorIdx !== this.currentFloorIdx;
    this._bgFloorIdx = this.currentFloorIdx;
    if (bgKey !== this._bgKey) {
      this.cancelBgReplay();
      const replay = () => {
        if (!window.PluginEngine || !this.bgId || !PluginEngine.applyBackground) return;
        /* 每次执行现算指纹：等待 160ms 防抖 / 300ms 重试期间构图可能又变了，
         * 也可能已被 applyBg() 显式画好（此时直接收手，不重复绘制）。 */
        const key = this.bgKeyOf();
        if (key === this._bgKey) return;
        let done = false;
        try { done = PluginEngine.applyBackground(this.bgId, this) === true; }
        catch (e) { console.warn('[View3D] 背景重放异常:', e); }
        if (done) { this._bgKey = key; this._bgFail = 0; return; }
        /* 失败：保留旧指纹，并主动安排有限次重试。插件 loadAll 是异步的，
         * 只等「下一次 build」可能永远等不到 —— 背景会一直空白。
         * 3 次都失败就停手，避免坏插件每帧刷错误。 */
        this._bgFail = (this._bgFail || 0) + 1;
        if (this._bgFail <= 3) {
          clearTimeout(this._bgRetry);
          this._bgRetry = setTimeout(replay, 300);
        }
      };
      /* 切层是一次性低频操作：立即重放，别让 160ms 防抖窗口里还显示旧地形。
       * 同一层内改墙 / 改层高 / 改参数仍防抖。 */
      if (floorChanged) replay();
      else this._bgReplay = setTimeout(replay, 160);
    }
    this.render();
  },

  /* 「重建楼层模型 + 重建标签 + 渲染」三连 —— 编辑页与大屏的统一重建入口。
   * build() 之后必须 syncLabels（标签 DOM 随场景重建）再 refresh（渲染一帧），
   * 这三步曾各自手抄 5 份，漏一步就出现「模型换了标签没换」的错位。 */
  rebuild(project, floorIdx) {
    this.build(project, floorIdx);
    this.syncLabels(project);
    this.refresh();
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
      h: flH > 0 ? r2(flH) : 2.8,
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

  /* 相机取景：默认定位到户型中心斜上方；
     角度/距离交给调用端（app.js / display.js）自己控制，可选参数：
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
      const dir = v3(o.dir, new THREE.Vector3(8, 9, 10)).normalize();
      let dist = Math.sqrt(8 * 8 + 9 * 9 + 10 * 10);
      if (o.dist != null) dist = o.dist;
      else if (o.zoom != null) dist *= o.zoom;
      this.camera.position.set(c.x + dir.x * dist, c.y + dir.y * dist, c.z + dir.z * dist);
    }
    this.controls.target.copy(c);
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
    this.anchorPulse(this.controls.target);
    return true;
  },

  /* 锚点重置回房屋中心（= 初始默认）；onAnchor 已设置时通知调用端（大屏据此持久化） */
  resetAnchor() {
    const c = this.center || new THREE.Vector3(0, 1, 0);
    this.controls.target.copy(c);
    this.controls.update();
    this.anchorPulse(c);
    if (typeof this.onAnchor === 'function') this.onAnchor();
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
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    fl.walls.forEach((w) => {
      minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
      minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
    });
    if (minX === Infinity) return;
    const w = maxX - minX, d = maxY - minY;
    const geo = new THREE.PlaneGeometry(w, d);
    const mat = new THREE.MeshLambertMaterial({ color: 0xb3a78e, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(geo, mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((minX + maxX) / 2, -0.02, (minY + maxY) / 2);
    this.root.add(floor);
  },

  assignOpening(o, kind, fl, wallOpenings) {
    // 找到门窗所在的墙（垂直距离最近且在墙段范围内）
    let best = -1, bestDist = Infinity, bestS = 0;
    fl.walls.forEach((w, i) => {
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
    const ux = dx / len, uy = dy / len;
    const segs = [];
    const addSeg = (s0, s1, y0, y1) => {
      if (s1 - s0 > 0.015 && y1 - y0 > 0.015) segs.push({ s0, s1, y0, y1 });
    };
    const DOOR_H = 2.05, WIN_SILL = 0.9, WIN_TOP = 2.1;
    let cur = 0;
    const ops = (openings || []).slice().sort((a, b) => a.s - b.s);
    for (const op of ops) {
      const L = op.o.w || (op.kind === 'door' ? 0.9 : 1.2);
      const s0 = Math.max(0, op.s - L / 2), s1 = Math.min(len, op.s + L / 2);
      if (s1 - s0 < 0.05) continue;
      addSeg(cur, s0, 0, this.wallH);
      if (op.kind === 'door') {
        addSeg(s0, s1, DOOR_H, this.wallH);           // 门楣（门恒落地，洞高不随 z 变）
      } else {
        /* 窗洞随实例的离地高度（obj.z）整体上移：模型自带 0.9m 窗台，z 是整体抬升，
         * 所以洞口下沿 = 0.9 + z、上沿 = 2.1 + z（钳到墙高，抬太高时不画负高度段） */
        const wz = (op.o && op.o.z) || 0;
        const sill = Math.min(this.wallH, WIN_SILL + wz);
        const top = Math.min(this.wallH, WIN_TOP + wz);
        addSeg(s0, s1, 0, sill);                      // 窗台
        addSeg(s0, s1, top, this.wallH);              // 窗楣
      }
      cur = s1;
    }
    addSeg(cur, len, 0, this.wallH);
    // 半透明墙体: 透明物体在所有不透明物体之后渲染，家具/设备/门窗不会被墙面挡住；
    // depthWrite=false 避免多面墙相互遮挡产生排序闪烁
    if (!this._wallMat) {
      this._wallMat = new THREE.MeshLambertMaterial({
        color: 0xf2f2f0,
        transparent: true,
        opacity: this._wallOpacity != null ? this._wallOpacity : 0.45,
        depthWrite: false,
      });
    }
    segs.forEach((sg) => {
      // 端头延伸: 墙两端（拐角处）向外伸出半个墙厚，与相邻墙拼合填平接缝
      const a = sg.s0 === 0 ? -e0 : sg.s0;
      const b = sg.s1 === len ? len + e1 : sg.s1;
      const geo = new THREE.BoxGeometry(b - a, sg.y1 - sg.y0, t);
      const m = new THREE.Mesh(geo, this._wallMat);
      m.position.set(w.x1 + ux * (a + b) / 2, (sg.y0 + sg.y1) / 2, w.y1 + uy * (a + b) / 2);
      m.rotation.y = -Math.atan2(dy, dx);
      this.root.add(m);
    });
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
        // 归一化: 以家具包围盒拟合 w/d
        const box = new THREE.Box3().setFromObject(inst);
        const size = box.getSize(new THREE.Vector3());
        const s = Math.min(S.w / (size.x || 1), S.d / (size.z || 1));
        const defScale = S.scale;
        inst.scale.multiplyScalar(defScale * s);
        inst.position.y = -box.min.y * defScale * s;
        grp.add(inst);
        this.render();
      });
    } else {
      this.buildFallbackFurniture(f, grp);
    }
    grp.position.set(f.x, f.z || 0, f.y);
    grp.rotation.y = -(f.rot || 0);
    grp.scale.setScalar((f.pct || 100) / 100);   // 整体比例(%)：GLB 与体块兜底统一缩放
    this.root.add(grp);
  },

  _gltfCache: {},
  loadModel(url) {
    if (this._gltfCache[url]) return this._gltfCache[url];
    this._gltfCache[url] = new Promise((resolve) => {
      new GLTFLoader().load(url, (gltf) => resolve(gltf.scene), undefined, () => resolve(null));
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
   *   门/窗（贴墙类型）→ 插件 def.z 声明（door/window 都声明 z:0 贴地），未声明回退 0
   *   设备 → 目录造型 z（deviceDefaultZ），缺省 1.2m */
  devY(d, type) {
    if (d.z != null) return d.z;
    if (type === 'door' || type === 'window') {
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
        /* on/off 之外认得 open/closed（门/窗磁贴的常用值），其余原样 + 单位 */
        const base = { on: '已开启', open: '已打开', off: '已关闭', closed: '已关闭' }[st.state];
        lv.textContent = base || (st.state + (unit ? ' ' + unit : ''));
      }
      /* 高亮判定走统一入口（插件顶层 isOn → 默认规则），与 2D / 统计同口径 */
      el.classList.toggle('on', HA.deviceIsOn({ entityId: d.entityId, type: L.type, style: d.style }));
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
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
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

  onClick(e) {
    if (this._anchorPicked) { this._anchorPicked = false; return; }   // 长按设锚点后的松手不算点击，避免误触开关
    const grp = this.pick(e);
    if (!grp) return;
    this.toggleDevice(grp.userData.device, grp.userData.devType);
  },

  /* 点击控制规格（门禁）: 插件注册的 click 优先，其次内置默认；实例 d.click 可强制开关。
   * 门/窗已并入设备（kind:'device'），这里不再按类型分支，设备与门窗同一套规则:
   *   d.click === false → 强制不可点
   *   d.click === true  → 即使插件 defaultOn=false 也可点
   *   未设置 → 跟随插件 defaultOn（缺省 true；插件没声明 click 就没有 spec，不可点）
   * 实例 d.clickSvc（属性面板「点击动作」下拉）→ 勾选状态下视为明确要可点，
   * 插件没声明 click / 内置没默认也不再拦（发什么服务由 toggleDevice 按全局动作表解析）。
   * 「发不发服务」与「能不能点」分离：没绑实体的实例也可能可点，toggleDevice 末尾统一拦截。
   * typeOrKind: HA 实体类型或贴墙类型 door/window（门/窗实例数据里没有 type 字段，由调用方传入）
   */
  clickSpecOf(d, typeOrKind) {
    const type = typeOrKind || devTypeOf(d);
    if (d.click === false) return null;
    const spec = (window.PluginEngine && PluginEngine.clickSpec) ? PluginEngine.clickSpec(type, d.style) : null;
    if (d.clickSvc) return d.click === true ? (spec || {}) : null;
    if (!spec) return null;
    if (d.click === true) return spec;
    return spec.defaultOn === false ? null : spec;
  },

  /* 点击发服务的域: 绑定实体前缀（cover.garage → cover）。门/窗与设备同样是实体绑定，
   * 无需按类型分支；没绑实体返回 null，toggleDevice 末尾统一拦截不发 */
  clickDomainOf(d) {
    const ent = String(d.entityId || '');
    return ent.includes('.') ? ent.split('.')[0] : null;
  },

  /* 点击 → 发服务（设备与门/窗统一入口，type = HA 域或贴墙类型 door/window）。
   * 当前是否开着决定发 on 还是 off：直接用 HA.deviceIsOn（= 插件顶层 isOn → HA.isOn 默认规则），
   * 和 2D 底色 / 3D 高亮 / 统计完全同一个结论，不会再出现「界面显示关着、点击却发关闭」的错向。
   * 发什么服务: 实例 d.clickSvc（属性面板下拉）优先级最高，整体替换插件 click / 内置默认；
   * 未选择时用插件 click / 内置默认，域按 spec.domain（贴墙类型引擎不回退域）否则实体前缀。
   * on/off 也可以是插件声明的自定义函数（fn(d, api)），此时跳过域/实体校验，由函数自由执行。 */
  toggleDevice(d, typeOrKind) {
    const type = typeOrKind || devTypeOf(d);
    const spec = this.clickSpecOf(d, type);
    if (!spec) return;
    const domain0 = spec.domain || this.clickDomainOf(d);
    let on = spec.on || 'toggle';
    let off = spec.off || 'toggle';
    let label = spec.label;
    let feedback = spec.feedback === true;
    let domain = domain0;
    if (d.clickSvc) {   // 实例级覆盖（优先级最高，全局拉平表按 on 服务名解析）
      const pair = (window.PluginEngine && PluginEngine.clickSvcPair)
        ? PluginEngine.clickSvcPair(d.clickSvc) : null;
      if (pair) {
        on = pair.on; off = pair.off; label = pair.label; feedback = pair.feedback === true;
        domain = this.clickDomainOf(d) || domain0;
      }
    }
    const onNow = HA.deviceIsOn({ entityId: d.entityId, type, style: d.style });
    const svc = onNow ? off : on;
    /* 自定义函数形态（插件高级用法）: 方向仍由 isOn 驱动，函数自己决定发什么。
     * api 给插件安全的执行环境（call/get/toast + 原始实例）；无实体也可执行（函数可自由操作）。
     * 同步抛错与 Promise 拒绝都拦住，避免插件 bug 波及主流程 */
    if (typeof svc === 'function') {
      const api = {
        obj: d,
        call: (dom, service, data) => HA.callService(dom, service, data || {}),
        get: (eid) => (typeof HA.getState === 'function' ? HA.getState(eid) : null),
        toast: (msg) => { if (window.App) App.toast(String(msg)); },
      };
      try {
        Promise.resolve(svc.call(null, d, api)).catch((err) => {
          if (window.App) App.toast('控制失败: ' + (err && err.message ? err.message : err));
        });
      } catch (err) {
        if (window.App) App.toast('控制失败: ' + (err && err.message ? err.message : err));
      }
      return;
    }
    if (!domain || !d.entityId) return;   // 没绑实体 / 推不出域就没法发服务
    HA.callService(domain, svc, { entity_id: d.entityId })
      .then(() => { if (feedback && window.App) App.toast((d.name || HA.friendly(d.entityId) || '设备') + ' · ' + (label || svc)); })
      .catch((err) => {
        if (window.App) App.toast('控制失败: ' + err.message);
      });
  },

  /* 设备标签显示开关（编辑页顶栏可切换） */
  setLabelsVisible(v) {
    this.labelsVisible = !!v;
    this.updateLabels();
  },

  render() {
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  },

  startLoop() {
    if (!this.webglOk) return;
    let last = performance.now();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.wrap.classList.contains('hidden')) { last = performance.now(); return; }
      const dt = Math.min(0.1, (performance.now() - last) / 1000);
      last = performance.now();
      this.controls.update();
      this.tickAnchorFx(dt);
      if (window.PluginEngine) PluginEngine.tick(dt);   // 插件逐帧动画（开门/扇叶/呼吸灯…）
      this.renderer.render(this.scene, this.camera);
      if (this.labels.length) this.updateLabels();
    };
    loop();
  },

  disposeGroup(g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        Array.isArray(o.material) ? o.material.forEach((m) => m.dispose()) : o.material.dispose();
      }
    });
  },
};
