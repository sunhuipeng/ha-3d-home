/*
 * editor.js — 2D 户型编辑器
 * 网格吸附(0.1m) + 端点吸附；工具: 选择/平移/墙体/门/窗/家具/设备/房间/测量/贴图/背景
 * （删除不是工具: 选中后按 Delete 或点属性栏按钮）
 */
import { HA } from '../services/ha.js';
import {
  uid, furnSpec, itemDisplayName,
  newRoom, roomArea, roomCentroid, roomPtsOk, pointInRoom, pointInRoomStrict, roomColor,
  KIND_ARR, KIND_NAME,
} from '../model/catalog.js';
import { PluginEngine, DEFAULT_OPENING_W } from './plugins.js';

/* 2D 编辑器的缩放基准: 60 像素 = 1 米 = 100%。初始 ppm、复位、缩放百分比换算
 * （引擎内 2 处 + editor store 1 处）都必须同值，改这里一处即可。 */
export const PPM_BASE = 60;

export const Editor = {
  canvas: null, ctx: null,
  ppm: PPM_BASE,           // 像素/米
  ox: 0, oy: 0,            // 平移偏移(像素)
  tool: 'select',
  floor: null,             // 当前楼层引用
  selection: null,         // {kind:'wall|door|window|furniture|device', id}
  ghost: null,             // 待放置的家具/设备 {kind, data}
  wallStart: null,         // 画墙起点
  /* 画房间的已落定点（世界坐标）。null = 没在画；>=1 点即进入绘制态。
   * 与 wallStart 的区别：墙每两点就产出一条独立墙段，房间是「整串点最后才落成一个多边形」，
   * 所以过程态用数组、只有 Esc/双击/右键/点回起点才 commitRoom() 写进 floor.rooms。 */
  roomPts: null,
  /* 拖动房间顶点微调（选中房间后顶点变成可拖手柄）：{ room, i, start:[x,y], moved }。
   * 与 dragEnd（拖墙端点）并列但互斥 —— 选中房间时墙端点圆圈不可能同时命中。 */
  dragVert: null,
  /* 鼠标悬停在哪个顶点上（只用于把手柄画大一点 + 改 grab 光标），-1 = 没有 */
  hoverVert: -1,
  /* 测量标线：纯视图标注，**不进 project.json、不进撤销栈**（不调 changed()）。
   * 每条恒两点 {x1,y1,x2,y2}（世界坐标，米），按绘制顺序叠放。 */
  measures: [],
  /* 当前测量链的锚点 [x,y]；null = 未起笔。单击落定上一段并把锚点推进到落点，
   * 所以「一条折线链」= 多次单击，右键/双击结束链但保留已画的线。 */
  measureFrom: null,
  mouse: { x: 0, y: 0, wx: 0, wy: 0, down: false },
  panning: false,
  drag: null,              // 拖动选中元素 {kind,id,dx,dy}
  onChange: null,
  onViewChange: null,      // 平移/缩放结束 → App 压一条视图快照（见 recode.js pushView）
  backgroundImage: null,   // 楼层贴图 {img, src, name, x, y, w, opacity, hidden}

  GRID: 0.1,
  WALL_T: 0.24,
  VERT_R: 6,      // 房间顶点手柄半径(屏幕 px)：比墙端帽大一圈，一眼能看出「这里能拖」
  VERT_HIT: 14,   // 顶点抓取热区半径(屏幕 px)：比手柄再大一圈，不用像素级对准

  /* 选择类工具：select 与 bg（贴图菜单态，画布行为等同选择） */
  isSelectTool() { return this.tool === 'select' || this.tool === 'bg'; },

  init(canvas) {
    if (this._inited) return;   // 重入守卫：HMR / 二次 init 会叠加监听器并出现双 RAF 循环
    this._inited = true;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());

    canvas.addEventListener('mousedown', (e) => this.onDown(e));
    canvas.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    /* 双击 / 右键 = 结束当前这一笔：墙断段、房间落定成多边形，**都不退出工具**，
     * 所以可以接着画下一段墙 / 下一间房。真正退出工具是 Esc（见 App.bindKeys）。
     * commitRoom() 在没在画房间时直接返回，其余工具下这两行等于原来的「清 wallStart」。 */
    canvas.addEventListener('dblclick', () => { this.wallStart = null; this.commitRoom(); this.endMeasureChain(); this.render(); });
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.wallStart = null; this.commitRoom(); this.endMeasureChain(); this.render(); });
    canvas.addEventListener('mouseleave', () => { this.hoverVert = -1; this.render(); });
  },

  resize() {
    if (!this.canvas) return;
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = Math.max(10, r.width * devicePixelRatio);
    this.canvas.height = Math.max(10, r.height * devicePixelRatio);
    this.render();
  },

  /* ------- 坐标换算 ------- */
  toScreen(wx, wy) { return [wx * this.ppm + this.ox, wy * this.ppm + this.oy]; },
  toWorld(sx, sy) { return [(sx - this.ox) / this.ppm, (sy - this.oy) / this.ppm]; },
  evPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  },

  fit() {
    if (!this.floor) return;
    const pts = [];
    this.floor.walls.forEach((w) => pts.push([w.x1, w.y1], [w.x2, w.y2]));
    this.floor.furniture.forEach((f) => pts.push([f.x - 1, f.y - 1], [f.x + 1, f.y + 1]));
    this.floor.devices.forEach((d) => pts.push([d.x - 1, d.y - 1], [d.x + 1, d.y + 1]));
    /* 房间顶点也参与取景/居中的包围盒：房间可能画到墙线外一点，不纳入会被裁在视野外 */
    ((this.floor.rooms) || []).forEach((r) => (r.pts || []).forEach((p) => pts.push(p)));
    if (!pts.length) { this.ppm = PPM_BASE; this.ox = this.canvas.width / 2; this.oy = this.canvas.height / 2; this.render(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
    const pad = 1.5;
    const w = this.canvas.width / devicePixelRatio, h = this.canvas.height / devicePixelRatio;
    const R = this.RULER;           // 刻度尺占据的边缘，适配时让出来
    const aw = Math.max(40, w - R), ah = Math.max(40, h - R);
    this.ppm = Math.min(aw / (maxX - minX + pad * 2), ah / (maxY - minY + pad * 2));
    this.ox = R + (aw - (minX + maxX) * this.ppm) / 2;
    this.oy = R + (ah - (minY + maxY) * this.ppm) / 2;
    this.render();
  },

  /* 居中: 保持当前缩放不变，只把户型包围盒平移回画布中心（解决平移后跑偏，一键归位）。
   * 包围盒取样与 fit() 一致（墙 + 家具 + 设备），只是不重算 ppm */
  center() {
    if (!this.floor) return;
    const pts = [];
    this.floor.walls.forEach((w) => pts.push([w.x1, w.y1], [w.x2, w.y2]));
    this.floor.furniture.forEach((f) => pts.push([f.x - 1, f.y - 1], [f.x + 1, f.y + 1]));
    this.floor.devices.forEach((d) => pts.push([d.x - 1, d.y - 1], [d.x + 1, d.y + 1]));
    /* 房间顶点也参与取景/居中的包围盒：房间可能画到墙线外一点，不纳入会被裁在视野外 */
    ((this.floor.rooms) || []).forEach((r) => (r.pts || []).forEach((p) => pts.push(p)));
    if (!pts.length) { this.ox = this.canvas.width / 2; this.oy = this.canvas.height / 2; this.render(); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(([x, y]) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); });
    const w = this.canvas.width / devicePixelRatio, h = this.canvas.height / devicePixelRatio;
    const R = this.RULER;
    const aw = Math.max(40, w - R), ah = Math.max(40, h - R);
    this.ox = R + (aw - (minX + maxX) * this.ppm) / 2;
    this.oy = R + (ah - (minY + maxY) * this.ppm) / 2;
    this.render();
  },

  /* 画布视图（平移偏移 + 缩放）：随撤销快照存取，恢复时不再 fit()，
   * 避免 undo/redo 时整幅画面位置和比例突变 */
  viewState() { return { ox: this.ox, oy: this.oy, ppm: this.ppm }; },
  setView(v) {
    if (!v) { this.fit(); return; }
    if (Number.isFinite(v.ppm)) this.ppm = Math.max(8, Math.min(400, v.ppm));
    if (Number.isFinite(v.ox)) this.ox = v.ox;
    if (Number.isFinite(v.oy)) this.oy = v.oy;
    this.render();
    if (window.App && App.updateZoomLabel) App.updateZoomLabel(Math.round(this.ppm / PPM_BASE * 100));
  },

  setZoom(ppm) {
    const [cx, cy] = [this.canvas.width / devicePixelRatio / 2, this.canvas.height / devicePixelRatio / 2];
    const [wx, wy] = this.toWorld(cx, cy);
    this.ppm = Math.max(8, Math.min(400, ppm));
    const [nx, ny] = this.toScreen(wx, wy);
    this.ox += cx - nx; this.oy += cy - ny;
    this.render();
    this.viewChanged();
  },

  /* ------- 吸附 ------- */
  snap(wx, wy, skipWallId) {
    let sx = Math.round(wx / this.GRID) * this.GRID;
    let sy = Math.round(wy / this.GRID) * this.GRID;
    // 端点吸附
    if (this.floor) {
      const tol = 0.18;
      let best = tol, bx = null, by = null;
      this.floor.walls.forEach((w) => {
        if (w.id === skipWallId) return;
        [[w.x1, w.y1], [w.x2, w.y2]].forEach(([px, py]) => {
          const d = Math.hypot(wx - px, wy - py);
          if (d < best) { best = d; bx = px; by = py; }
        });
      });
      if (bx !== null) { sx = bx; sy = by; }
    }
    return [Math.round(sx * 100) / 100, Math.round(sy * 100) / 100];
  },

  /* ------- 交互 ------- */
  onDown(e) {
    const [sx, sy] = this.evPos(e);
    const [wx, wy] = this.toWorld(sx, sy);
    this.mouse.down = true;

    if (e.button === 1 || this.tool === 'pan' || spaceHeld) {
      this.panning = true; this.panFrom = [sx, sy]; this.panMoved = false; return;
    }
    if (e.button === 2) return;
    /* 刻度尺区域不穿透: 避免点到「被尺子盖住、看不见」的元素 */
    if (sx < this.RULER || sy < this.RULER) return;

    switch (this.tool) {
      case 'wall': {
        /* 画墙工具下也保留编辑能力:
         * ① 点中「已选中墙」的端点圆 → 拖端点（不必先切回选择工具）
         * ② 点中已有墙体中部（离端点 0.35m 以外）→ 选中该墙并结束连续画墙，
         *    不会误落一条新墙；端点附近仍按落点处理（方便接墙 / 拐角相连） */
        const endHit = this.hitWallEnd(sx, sy);
        if (endHit) {
          this.dragEnd = { wall: endHit.wall, end: endHit.end, openings: [] };
          [...this.floor.doors, ...this.floor.windows].forEach((o) => {
            if (o.wallId !== endHit.wall.id) return;
            this.dragEnd.openings.push({ o, t: this.projT(endHit.wall, o.x, o.y) });
          });
          break;
        }
        const onWall = this.floor.walls.find((w) => {
          const tt = this.projT(w, wx, wy);
          const cx = w.x1 + (w.x2 - w.x1) * tt, cy = w.y1 + (w.y2 - w.y1) * tt;
          if (Math.hypot(wx - cx, wy - cy) > w.t / 2 + 0.08) return false;
          const dEnd = Math.min(Math.hypot(wx - w.x1, wy - w.y1), Math.hypot(wx - w.x2, wy - w.y2));
          return dEnd > 0.35;
        });
        if (onWall) {
          this.wallStart = null;
          this.select('wall', onWall.id, 'wall');
          this.render();
          break;
        }
        const [px, py] = this.wallPoint(wx, wy);
        if (!this.wallStart) { this.wallStart = [px, py]; }
        else {
          const [qx, qy] = this.wallPoint(wx, wy);
          if (Math.hypot(qx - this.wallStart[0], qy - this.wallStart[1]) > 0.05) {
            const w = { id: uid(), x1: this.wallStart[0], y1: this.wallStart[1], x2: qx, y2: qy, t: this.WALL_T };
            this.floor.walls.push(w);
            this.wallStart = [qx, qy];
            this.changed(false, 'wall:' + w.id);
          }
        }
        this.render();
        break;
      }
      case 'room': {
        /* 没在画的时候点到已有房间 = 选中它（与「墙工具点已有墙」同构），
         * 避免想把房间选中改名却反而在它上面又起了一个新多边形 */
        if (!this.roomPts) {
          const r = this.hitRoom(wx, wy);
          if (r) { this.select('room', r.id); this.render(); break; }
        }
        const [px, py] = this.roomPoint(wx, wy);
        const pts = this.roomPts;
        if (!pts) { this.roomPts = [[px, py]]; this.render(); break; }   // 第 1 点：起笔
        const last = pts[pts.length - 1];
        if (Math.hypot(px - last[0], py - last[1]) < 0.05) break;        // 手抖/双击的同点重复
        /* 第 3 点起回点起点 = 主动闭合落定（自动闭合之外的手动出口），留在工具里继续画 */
        const first = pts[0];
        if (pts.length >= 3 && Math.hypot(px - first[0], py - first[1]) < 0.25) {
          this.commitRoom();
          break;
        }
        pts.push([px, py]);
        /* 过程态不调 changed()：点 8 下就 8 条撤销记录会把历史栈冲垮。
         * 只有 commitRoom() 落定那一刻才压一条 'room:add'。 */
        this.render();
        break;
      }
      /* 测量：单击一次 = 「落定上一段 + 锚点推进到落点」，所以连续单击就是一条折线链。
       * 距离 < 0.02m 视为手抖/双击同点，既不成线也不推进锚点（不会留零长标线）。 */
      case 'measure': {
        const [px, py] = this.measurePoint(wx, wy);
        if (!this.measureFrom) { this.measureFrom = [px, py]; this.render(); break; }
        const [ax, ay] = this.measureFrom;
        if (Math.hypot(px - ax, py - ay) >= 0.02) {
          this.measures.push({ x1: ax, y1: ay, x2: px, y2: py });
          this.measureFrom = [px, py];
        }
        this.render();
        break;
      }
      case 'door': case 'window': {
        const hit = this.hitWall(wx, wy);
        if (!hit) { this.flashTip('请先点击一段墙体放置' + (this.tool === 'door' ? '门' : '窗')); break; }
        const w = hit.wall;
        // 投影到墙线
        const t = this.projT(w, wx, wy);
        const mx = w.x1 + (w.x2 - w.x1) * t, my = w.y1 + (w.y2 - w.y1) * t;
        const ang = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
        /* rot 全链统一存「度」: 沿墙角度 = 墙向角转度（3D/2D/面板按 ° 读写，与设备同一单位）。
         * 放置缺省宽按插件 def.defaultW 声明取（door 0.9 / window 1.2 由各自插件声明），引擎未就绪时回退 */
        const engine = (window.PluginEngine && PluginEngine.ready) ? PluginEngine : null;
        const defW = engine ? engine.defaultW(this.tool) : null;
        const item = { id: uid(), x: Math.round(mx * 100) / 100, y: Math.round(my * 100) / 100,
          w: defW || DEFAULT_OPENING_W[this.tool],
          rot: Math.round(ang * 180 / Math.PI * 1000) / 1000, wallId: w.id };
        /* 归属房间：门窗中心压在墙中线上，用与设备/家具同一个 roomIdAt（自带 4 屏幕像素
         * 边界容差）判一次。墙两侧可能是两间房，判不出来就不留键，由属性面板的下拉指定。 */
        this.withRoom(item);
        (this.tool === 'door' ? this.floor.doors : this.floor.windows).push(item);
        this.select('door/window', item.id, this.tool === 'door' ? 'door' : 'window');
        this.changed(false, this.tool + ':' + item.id);
        break;
      }
      case 'furniture': {
        /* 插件动态家具（家具库卡片带「插件」标记）：落 floors.devices，实例只存 style，
         * 尺寸/门数等由插件 model3d 按 styleOpts 现场算 —— 与静态家具的 mid 是两条数据路径 */
        if (this.ghost && this.ghost.kind === 'furn-plugin') {
          const g = this.ghost.data;
          const fx = this.snapG(wx), fy = this.snapG(wy);
          /* 落点落在哪个房间就归属哪个房间；压墙/画在房间外时不留 roomId 键，
           * 由右侧「所属房间」下拉手动指定（交界处不猜） */
          const d = this.withRoom({
            id: uid(), type: 'furniture',
            x: fx, y: fy, rot: 0,
            style: g.style || g.id,
          });
          this.floor.devices.push(d);
          this.select('device', d.id);
          this.changed(false, 'dev:' + d.id);
          break;
        }
        if (!this.ghost || this.ghost.kind !== 'furniture') break;
        const g = this.ghost.data;
        // 只存 mid（形态标识）+ 摆放参数；type/name/尺寸/颜色/模型等一律由目录形态解析（furnSpec），
        // 目录里改尺寸/换模型，已放置的家具自动跟着变
        const fx2 = this.snapG(wx), fy2 = this.snapG(wy);
        const f = this.withRoom({ id: uid(), mid: g.id || g.type, x: fx2, y: fy2, rot: 0 });
        this.floor.furniture.push(f);
        this.select('furniture', f.id);
        this.changed(false, 'furn:' + f.id);
        break;
      }
      case 'device': {
        if (!this.ghost || this.ghost.kind !== 'device') break;
        const g = this.ghost.data;
        // 实例只存实体 id + 类型 + 摆放参数；显示名一律由 HA.friendly(entityId) 解析
        const dx = this.snapG(wx), dy = this.snapG(wy);
        const d = this.withRoom({ id: uid(), entityId: g.entityId, type: g.type, x: dx, y: dy });
        this.floor.devices.push(d);
        this.select('device', d.id);
        this.ghost = null;
        this.changed(false, 'dev:' + d.id);
        break;
      }
      case 'select': default: {
        /* 已选中房间 → 先判顶点手柄：命中就进入顶点拖拽（微调多边形），
         * 否则下面 hitTest 又会把房间整体选中，永远拖不到顶点 */
        const vert = this.hitRoomVert(sx, sy);
        if (vert >= 0) {
          const room = this.floor.rooms.find((x) => x.id === this.selection.id);
          const p = room.pts[vert];
          this.dragVert = { room, i: vert, start: [p[0], p[1]], moved: false };
          if (this.canvas) this.canvas.style.cursor = 'grabbing';   // 拖动期间不再走 hover 分支，光标在这里定
          break;
        }
        /* 已选中墙 → 先判两端圆圈: 命中则进入端点拖拽（门窗按比例跟随重投影） */
        const endHit = this.hitWallEnd(sx, sy);
        if (endHit) {
          this.dragEnd = { wall: endHit.wall, end: endHit.end, openings: [] };
          [...this.floor.doors, ...this.floor.windows].forEach((o) => {
            if (o.wallId !== endHit.wall.id) return;
            this.dragEnd.openings.push({ o, t: this.projT(endHit.wall, o.x, o.y) });
          });
          break;
        }
        const hit = this.hitTest(wx, wy);
        if (hit) {
          this.select(hit.kind, hit.item.id, hit.kind);
          /* 墙体只选中、不拖动（防误移动）；房间同理 —— 它连 x/y 都没有，
           * 一旦进拖动分支 `wx - it.x` 就是 NaN，会把垃圾字段写进实例。
           * 其余元素（门窗/家具/设备）照常拖 */
          if (hit.kind !== 'wall' && hit.kind !== 'room') {
            const it = hit.item;
            this.drag = { kind: hit.kind, item: it, dx: wx - it.x, dy: wy - it.y };
          }
        } else {
          this.select(null);
        }
        this.render();
      }
    }
  },

  onMove(e) {
    const [sx, sy] = this.evPos(e);
    const [wx, wy] = this.toWorld(sx, sy);
    this.mouse.wx = wx; this.mouse.wy = wy;

    if (this.panning && this.mouse.down) {
      this.ox += sx - this.panFrom[0]; this.oy += sy - this.panFrom[1];
      this.panFrom = [sx, sy]; this.panMoved = true; this.render(); return;
    }
    if (this.drag && this.mouse.down) {
      const it = this.drag.item;
      const nx = Math.round((wx - this.drag.dx) * 100) / 100;
      const ny = Math.round((wy - this.drag.dy) * 100) / 100;
      if (nx !== it.x || ny !== it.y) { it.x = nx; it.y = ny; this.drag.moved = true; this.changed(true, 'drag:' + this.drag.kind + ':' + it.id); }
      return;
    }
    /* 拖房间顶点: 与画墙/画房间共用同一套吸附（0.1m 网格 + 已有墙端点吸附），
     * 所以微调出来的顶点依旧落在整米/半米的规整位置上，不会出现 3.4712 这种坐标。
     * label 带房间 id：同一次拖拽的多帧在 MERGE_MS 内合并成一条撤销记录。 */
    if (this.dragVert && this.mouse.down) {
      const { room, i } = this.dragVert;
      const [px, py] = this.snap(wx, wy, null);
      const p = room.pts[i];
      if (px !== p[0] || py !== p[1]) {
        p[0] = px; p[1] = py;
        this.dragVert.moved = true;
        this.changed(true, 'roomvert:' + room.id);
      }
      return;
    }
    /* 拖墙端点: 吸附(0.1m 网格/其他墙端点) → 更新端点 → 挂墙门窗按比例重投影。
     * 按住 Shift 时以「另一端」为基准锁正交，拖出严格的水平/垂直墙 */
    if (this.dragEnd && this.mouse.down) {
      const w = this.dragEnd.wall;
      const first = this.dragEnd.end === 1;
      const bx = first ? w.x2 : w.x1, by = first ? w.y2 : w.y1;   // 基准 = 另一端
      const L = this.lockAxis(bx, by, wx, wy);
      let [px, py] = this.snap(L.x, L.y, w.id);
      if (L.axis === 'h' && Math.abs(py - L.y) > 1e-6) py = L.y;
      if (L.axis === 'v' && Math.abs(px - L.x) > 1e-6) px = L.x;
      const k = this.dragEnd.end === 1 ? ['x1', 'y1'] : ['x2', 'y2'];
      if (px !== w[k[0]] || py !== w[k[1]]) {
        w[k[0]] = px; w[k[1]] = py;
        const ang = Math.atan2(w.y2 - w.y1, w.x2 - w.x1);
        this.dragEnd.openings.forEach(({ o, t }) => {
          o.x = Math.round((w.x1 + (w.x2 - w.x1) * t) * 100) / 100;
          o.y = Math.round((w.y1 + (w.y2 - w.y1) * t) * 100) / 100;
          o.rot = Math.round(ang * 180 / Math.PI * 1000) / 1000;   // 跟墙角度（度，全链统一单位）
        });
        this.dragEnd.moved = true;   // 挂墙门窗跟着挪了 → onUp 要重算它们的房间归属
        this.changed(true, 'dragend:' + w.id);
      }
      return;
    }
    /* 悬停: 房间顶点 / 墙端点圆圈给 grab 光标（拖动中 grabbing），其余走元素提示。
     * hoverVert 顺手记下来，drawRoom 用它把鼠标下的手柄画大一圈（"点得中"的可视反馈） */
    this.hoverVert = this.isSelectTool() ? this.hitRoomVert(sx, sy) : -1;
    if (this.tool === 'room' || this.tool === 'measure') {
      this.canvas.style.cursor = 'crosshair';   // 绘制/量距态：十字，明确「下一次单击会落点」
    } else if (this.isSelectTool() && (this.hoverVert >= 0 || this.hitWallEnd(sx, sy))) {
      this.canvas.style.cursor = this.mouse.down ? 'grabbing' : 'grab';
    } else if (this.canvas.style.cursor) {
      this.canvas.style.cursor = '';
    }
    // 悬浮提示（刻度尺区域内不提示：那层上盖着尺子，元素看不见）
    if (this.isSelectTool() && sx >= this.RULER && sy >= this.RULER) {
      const hit = this.hitTest(wx, wy);
      const tip = document.getElementById('tooltip');
      if (hit) {
        /* 显示名统一由 itemDisplayName 解析: 设备/门窗跟随 HA 与插件样式，家具跟随目录 */
        const it = hit.item;
        const dispName = itemDisplayName(hit.kind, it);
        /* 家具类设备（插件 type:'furniture'）在数据里仍存 floors.devices —— 拾取、移动、
         * 撤销栈全走设备那条链路；但用户视角它就是一件家具，提示词按「家具」称呼，
         * 与右侧属性面板（柜架 · 平开门衣柜）口径一致。另外它没有 HA 实体，
         * 下面那行「已开启/无状态」也不会命中。 */
        const tipKind = (hit.kind === 'device' && it && it.type === 'furniture') ? 'furniture' : hit.kind;
        let label = KIND_NAME[tipKind] + (dispName ? ' · ' + dispName : '');
        /* 房间的显示名不走 itemDisplayName（那是设备/门窗/家具的插件样式解析），
         * 直接「房间 · 名称 · 面积」，面积实时算（与属性面板同一份口径） */
        if (hit.kind === 'room' && it) {
          label = '房间 · ' + (it.name || '未命名') + ' · ' + Math.abs(roomArea(it.pts)).toFixed(1) + ' m²';
        }
        if (hit.kind === 'device' && hit.item.entityId) {
          const st = HA.getState(hit.item.entityId);
          label += ' · ' + (st ? PluginEngine.baseStateText(st) : '无状态');
        }
        tip.textContent = label;
        tip.style.left = (sx + 14) + 'px'; tip.style.top = (sy + 14) + 'px';
        tip.classList.remove('hidden');
      } else tip.classList.add('hidden');
    }
    this.render();
  },

  onUp(e) {
    const panned = this.panning && this.panMoved;   // 真拖动过才算一次视图改动（点一下没动不记）
    const dragged = this.drag;                      // 清空之前留一份，用来重算房间归属
    const vdrag = this.dragVert;                    // 同上：房间顶点拖拽需要收尾校验
    const edrag = this.dragEnd;                     // 同上：拖墙端点会让挂墙门窗跟着挪位
    this.mouse.down = false; this.panning = false; this.panMoved = false; this.drag = null; this.dragEnd = null;
    this.dragVert = null;
    if (this.canvas && this.canvas.style.cursor) this.canvas.style.cursor = '';
    if (panned) this.viewChanged();
    /* 顶点拖拽收尾: 允许拖出任意形状（包括凹多边形），但把「拖成一坨 / 三点共线」
     * 这种把面积拖没了的结果退回去 —— 房间没面积后，标签与 3D 地面都是坏的。
     * 拖动过程已经逐帧 changed()（同 label 合并成一条），这里只需回退 + 再压一条撤销。 */
    if (vdrag && vdrag.moved && !roomPtsOk(vdrag.room.pts)) {
      vdrag.room.pts[vdrag.i] = vdrag.start;
      this.flashTip('这个位置会让房间没有面积，已还原顶点');
      this.changed(false, 'roomvert:revert:' + vdrag.room.id);
    } else if (vdrag && vdrag.moved && this.resyncRooms(vdrag.room.id)) {
      /* 房间形状变了 → 重算元素的房间归属（只补不清：贴边/房外保持原值）。
       * 与顶点拖动共用 'roomvert:<id>' 这个 label，MERGE_MS 内会合并成同一条撤销，
       * 用户按一次 Ctrl+Z 就能把「形状 + 归属」一起回退。 */
      this.changed(false, 'roomvert:' + vdrag.room.id);
    }
    /* 拖完重算房间归属：只处理「真正移动过」的那一次 —— 单击选中不算，
     * 否则每次点一下都可能改写归属并压一条撤销。归属变了才 changed()。
     * 四类都要算：设备、静态家具、门、窗（门窗虽然挂在墙上，x/y 也是真实落点）。
     * 语义是「进了哪间房就绑哪间」，拖出房间不清空原归属（见 syncRoomId）。 */
    if (dragged && dragged.moved) {
      const k = dragged.kind;
      if (k === 'device' || k === 'furniture' || k === 'door' || k === 'window') {
        if (this.syncRoomId(dragged.item)) this.changed(false, 'room:assign:' + dragged.item.id);
      }
    }
    /* 拖墙端点：挂墙门窗被按比例重投影过，位置变了归属也可能变。
     * 这类位移不是用户直接拖门窗，所以不压单独撤销 —— 跟着墙体那一笔一起回退才合理，
     * 而墙体那笔已经在 onMove 里压过了，这里只同步数据 + 重绘。 */
    if (edrag && edrag.moved) {
      let any = false;
      edrag.openings.forEach(({ o }) => { if (this.syncRoomId(o)) any = true; });
      if (any) this.changed(false, 'room:assign:wall:' + edrag.wall.id);
    }
  },

  onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const [sx, sy] = this.evPos(e);
    const [wx, wy] = this.toWorld(sx, sy);
    this.ppm = Math.max(8, Math.min(400, this.ppm * factor));
    const [nx, ny] = this.toScreen(wx, wy);
    this.ox += sx - nx; this.oy += sy - ny;
    this.render();
    if (window.App) App.updateZoomLabel(Math.round(this.ppm / PPM_BASE * 100));
    /* 连续滚轮 = 一次缩放：停顿 350ms 后才记一条视图快照 */
    clearTimeout(this._wheelViewTimer);
    this._wheelViewTimer = setTimeout(() => this.viewChanged(), 350);
  },

  /* 视图（平移/缩放）结束 → 通知 App 压一条视图快照:
   * 让「平移过再改东西」的撤销不会把画面拉回平移之前的取景 */
  viewChanged(label) {
    if (this.onViewChange) this.onViewChange(label || 'view');
  },

  snapG(v) { return Math.round(v / this.GRID) * this.GRID; },

  /* 按住 Shift 的正交锁定: 以 (bx,by) 为基准，把指针锁到水平/垂直轴上（取偏移大的那根轴为自由轴）。
   * 返回 { x, y, axis }，axis: 'h' 水平（y 对齐基准）/ 'v' 垂直（x 对齐基准）/ null 未锁 */
  lockAxis(bx, by, wx, wy) {
    if (!shiftHeld) return { x: wx, y: wy, axis: null };
    if (Math.abs(wx - bx) >= Math.abs(wy - by)) return { x: wx, y: by, axis: 'h' };
    return { x: bx, y: wy, axis: 'v' };
  },

  /* 画墙取点（预览线 / 起点 / 落点共用，保证所见即所得）:
   * 先正交锁定 → 再吸附 → 吸附把点拉离锁定轴时退回锁定轴（只保留同轴端点吸附） */
  wallPoint(wx, wy) {
    if (!this.wallStart) return this.snap(wx, wy, null);
    const bx = this.wallStart[0], by = this.wallStart[1];
    const L = this.lockAxis(bx, by, wx, wy);
    const [sx, sy] = this.snap(L.x, L.y, null);
    if (L.axis === 'h' && Math.abs(sy - L.y) > 1e-6) return [sx, L.y];
    if (L.axis === 'v' && Math.abs(sx - L.x) > 1e-6) return [L.x, sy];
    return [sx, sy];
  },

  /* 画房间取点：与 wallPoint 同一套「所见即所得」（Shift 正交 → 网格/端点吸附 → 吸附把点
   * 拉离锁定轴时退回轴）。基准点 = 已落定的最后一个点，所以能沿上一条边拉出正交边。
   * 落点与预览必须共用它，否则鼠标处看到的边和松手生成的边会差一截。 */
  roomPoint(wx, wy) {
    const pts = this.roomPts;
    if (!pts || !pts.length) return this.snap(wx, wy, null);
    const [bx, by] = pts[pts.length - 1];
    const L = this.lockAxis(bx, by, wx, wy);
    const [sx, sy] = this.snap(L.x, L.y, null);
    if (L.axis === 'h' && Math.abs(sy - L.y) > 1e-6) return [sx, L.y];
    if (L.axis === 'v' && Math.abs(sx - L.x) > 1e-6) return [L.x, sy];
    return [sx, sy];
  },

  /* 量距取点：与 wallPoint / roomPoint 同一套「Shift 正交 → 网格/端点吸附 → 吸附把点
   * 拉离锁定轴就退回轴」。基准点 = 当前锚点，所以按住 Shift 能拉出严格水平/垂直的标线。 */
  measurePoint(wx, wy) {
    if (!this.measureFrom) return this.snap(wx, wy, null);
    const [bx, by] = this.measureFrom;
    const L = this.lockAxis(bx, by, wx, wy);
    const [sx, sy] = this.snap(L.x, L.y, null);
    if (L.axis === 'h' && Math.abs(sy - L.y) > 1e-6) return [sx, L.y];
    if (L.axis === 'v' && Math.abs(sx - L.x) > 1e-6) return [L.x, sy];
    return [sx, sy];
  },

  /* 结束当前测量链（右键/双击）：只清锚点，已画的标线保留、不退出工具，
   * 下一次单击从新位置起一条与前面不相连的链。 */
  endMeasureChain() {
    if (this.tool === 'measure' && this.measureFrom) { this.measureFrom = null; return true; }
    return false;
  },

  /* 清空全部标线（Esc / 切工具 / 切楼层）。同样不碰 undo 与项目数据。 */
  clearMeasures() {
    this.measures = [];
    this.measureFrom = null;
  },

  /* 落定当前房间。三个出口都走这里：Esc（并退出工具）、双击/右键、点回起点。
   * 无论成功与否都清空 roomPts —— 过程态绝不能残留到下一次绘制。
   * 返回 true = 真落定了一间；false = 点数不够 / 共线（会 flashTip 提示）。 */
  commitRoom() {
    const pts = this.roomPts;
    this.roomPts = null;
    if (!this.floor || !pts || pts.length < 3) { this.render(); return false; }
    if (!roomPtsOk(pts)) { this.flashTip('房间至少需要三个不共线的点'); this.render(); return false; }
    if (!Array.isArray(this.floor.rooms)) this.floor.rooms = [];
    const r = newRoom(pts, this.floor.rooms.length);
    this.floor.rooms.push(r);
    /* 新房间会把「原本未归属、但明确落在里面」的设备/家具/门窗收进来（只补不清：
     * 贴边与画在房外的保持原样）。scope 只给这一间，别处的手动归属不会被顺手重算。
     * 归属重算与「新建房间」是同一步操作，共用同一个 label，撤销一次就整体回退。 */
    this.resyncRooms(r.id);
    /* 一条撤销记录 = 一间房（过程点不记历史）。label 带 id 便于撤销栈按同类合并/去重 */
    this.changed(false, 'room:' + r.id);
    return true;
  },

  projT(w, px, py) {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    const len2 = dx * dx + dy * dy || 1;
    return Math.max(0.05, Math.min(0.95, ((px - w.x1) * dx + (py - w.y1) * dy) / len2));
  },

  hitWall(wx, wy) {
    if (!this.floor) return null;
    let best = null, bestD = 0.35;
    this.floor.walls.forEach((w) => {
      const t = this.projT(w, wx, wy);
      const cx = w.x1 + (w.x2 - w.x1) * t, cy = w.y1 + (w.y2 - w.y1) * t;
      const d = Math.hypot(wx - cx, wy - cy);
      if (d < bestD + w.t / 2) { bestD = d; best = { wall: w, d }; }
    });
    return best;
  },

  /* 房间命中：解析式射线法（点在多边形内 + 边界容差）。
   * **房间绝不能进离屏拾取层**（buildPick）—— 它是整片填充，按绘制顺序会把家具/设备/
   * 门窗的热区整片吃掉。所以房间永远排在命中链最末：元素 → 墙 → 房间。
   * 重叠时反向遍历 = 取后画的那间（与绘制顺序一致，和拾取层口径相同）。 */
  hitRoom(wx, wy) {
    const rooms = (this.floor && this.floor.rooms) || [];
    const tol = Math.max(0.08, 4 / this.ppm);   // 至少 4 屏幕像素：缩得很小时贴边也点得中
    for (let i = rooms.length - 1; i >= 0; i--) {
      const r = rooms[i];
      if (r && pointInRoom(r.pts, wx, wy, tol)) return r;
    }
    return null;
  },

  /* 落点归属的房间 id：只认「点落在多边形内」（hitRoom 自带 4 屏幕像素的边界容差）。
   * 压墙线 / 画在房间外的元素一律返回空串 —— 交界处不猜，交给属性面板的
   * 「所属房间」下拉手动指定（归属只有两个入口：放置/拖动结束自动判 + 手动改）。
   * 与 resyncRooms 的 pointInRoomStrict 三态是两套刻意的容差：这里是**元素自身的
   * 移动/放置**，用户动作明确，可以宽松贴边；那边是**房间形状变化**的批量重判，
   * 必须严格三态（edge 不猜）才能不冲掉手动指定 —— 详见 resyncRooms 注释。 */
  roomIdAt(x, y) {
    const r = this.hitRoom(x, y);
    return r ? r.id : '';
  },

  /* 放置新元素时顺手补 roomId：判不出房间就**不写这个键**（而不是留空串）。
   * 存档与插件侧统一按 falsy 判「未归属」，少一种「空串」中间态。 */
  withRoom(it) {
    const id = this.roomIdAt(it.x, it.y);
    if (id) it.roomId = id;
    return it;
  },

  /* 把实例的 roomId 同步成「它现在在哪个房间」：**只在（重新）进入某个房间时绑定**。
   * 移出房间 / 判定不出房间 → 保持原归属，**不清空** —— 把空调挪到墙边、或临时拖出去
   * 让它别挡路，都不该把已经指定好的房间弄丢。要解绑只能在属性面板选「未归属」。
   * 返回是否发生变化。 */
  syncRoomId(it) {
    if (!it) return false;
    const id = this.roomIdAt(it.x, it.y);
    if (!id || id === it.roomId) return false;
    it.roomId = id;
    return true;
  },

  /* 房间**形状变化**后重算归属（拖顶点 / 新画一间）。
   * 规则与「拖动元素」刻意不同：**只补不清** ——
   *   · 明确落在某间房内部（pointInRoomStrict === 'in'）且与当前归属不同 → 归到那间；
   *   · 贴边（墙两侧可能是两间房，歧义）或落在所有房间之外 → **保持原归属不动**。
   * 这样用户手动指定的归属不会被一次无关的形状微调冲成空值；
   * 而拖动元素本身仍然是双向同步（drag 出房间会清空），因为那一次是明确的用户移动。
   * 多间房重叠时取后画的那间，与 hitRoom / 绘制顺序一致。
   *
   * scopeId = 本次形状变化的那间房：只处理「原本归它」和「现在明确落在它里面」的元素。
   * 不传则全层重算。限制范围是为了保住别处的手动指定 —— 拖 A 房的顶点不该把
   * B 房里一个手动指过房间的插座重新按几何算一遍。
   *
   * 只改数据、不压撤销：调用方把它并进自己那一条（顶点拖动 / 新建房间是一步操作）。
   *
   * 容差与 roomIdAt（hitRoom 的 4 屏幕像素）刻意不同：这里用 pointInRoomStrict 三态
   * （edge = 距边 ≤0.15m 也不猜），因为形状变化是几何事件、没有「用户把它放进哪间」
   * 的明确意图，贴边一律保持原归属 —— 两套口径的原因互见 roomIdAt 注释。 */
  resyncRooms(scopeId) {
    const rooms = (this.floor && this.floor.rooms) || [];
    if (!rooms.length) return false;
    const pick = (x, y) => {
      for (let i = rooms.length - 1; i >= 0; i--) {
        const r = rooms[i];
        if (r && pointInRoomStrict(r.pts, x, y) === 'in') return r.id;
      }
      return '';
    };
    let any = false;
    const sync = (it) => {
      if (!it || typeof it.x !== 'number' || typeof it.y !== 'number') return;
      const id = pick(it.x, it.y);
      if (!id || id === it.roomId) return;   // 房间外 / 贴边 / 本来就对 → 一律不动
      /* 只管跟这间房有关的：原本归它的（可能被裁进了别的房），或现在明确落进它的。
       * 不相干房间里的旧归属一律不碰。 */
      if (scopeId && it.roomId !== scopeId && id !== scopeId) return;
      it.roomId = id;
      any = true;
    };
    (this.floor.doors || []).forEach(sync);
    (this.floor.windows || []).forEach(sync);
    (this.floor.devices || []).forEach(sync);
    (this.floor.furniture || []).forEach(sync);
    return any;
  },

  /* ================== 点击判定（像素拾取层） ==================
   * 为什么不再用「圆心 + 半径」：2D 符号由插件自绘，形状千差万别（摄像头 0.9m 视场扇、
   * 壁挂空调 0.85×0.22 长条、窗帘 0.9m 横杆、灯 r=0.13 小圆）。任何解析形状都得跟绘制
   * 代码维护两份几何，迟早漂移。这里改成「画什么就命中什么」：
   *   把同一批绘制函数（drawFurniture/drawDoorWindow/drawDevice）用唯一 id 色重画到
   *   一张离屏画布，点击时读那个像素的颜色 → 直接得到点到了谁。
   * 好处：任意形状（扇形/圆角/旋转/虚线）自动贴合；重叠按绘制顺序取最上层，与眼睛一致；
   *      读像素时取 13×13 邻域 = 「轮廓外 6px 也算命中」，热区是屏幕像素、不随缩放变。
   * 代价：形状/视图变化后多画一遍离屏（脏了才画；hover 只是重读同一张图，不重画）。
   * 墙不进拾取层：它面积最大、永远在最底下，仍走 hitWall 的胶囊判定兜底。 */
  PICK_PAD: 6,          // 读像素半径(屏幕 px)：符号外 6px 内也算命中
  _pick: null,          // { canvas, ctx, map: Map<颜色id, {kind,item}>, sig }

  /* 形状签名: 参与决定「离屏图要不要重画」。元素增删/移动/旋转/缩放/换样式 都会变，
   * 视图平移缩放也会变（屏幕坐标变了）——变化了才重画，避免每次 mousemove 都全量重绘 */
  pickSig(W, H) {
    let h = 2166136261;
    const m = (v) => { h = Math.imul(h ^ ((v * 64) | 0), 16777619); };
    m(W); m(H); m(this.ppm); m(this.ox); m(this.oy);
    /* 插件加载完之前 2D 走兜底符号，加载完形状会变 → 插件表变化必须让离屏图失效 */
    const PE = window.PluginEngine;
    m(PE ? PE.defs.length : -1); m(PE && PE.ready ? 1 : 0);
    const f = this.floor;
    if (!f) return h;
    const str = (s) => { let k = s.length; for (let i = 0; i < s.length; i++) k = (k * 33 + s.charCodeAt(i)) | 0; m(k); };
    const list = (arr, tag) => {
      m(tag); m(arr.length);
      for (let i = 0; i < arr.length; i++) {
        const it = arr[i];
        m(it.x); m(it.y); m(it.rot || 0); m(it.w || 0); m(it.pct || 100);
        str(String(it.id || '')); str(String(it.style || ''));
        /* 样式参数也参与：家具/门窗的外形可能完全由 styleOpts 决定（如衣柜长度 → 门数），
         * 参数变了符号形状就变了，离屏拾取图必须失效，否则点到的还是旧尺寸的热区 */
        str(it.styleOpts ? JSON.stringify(it.styleOpts) : '');
      }
    };
    list(f.windows, 1); list(f.doors, 2); list(f.furniture, 3); list(f.devices, 4);
    return h;
  },

  ensurePick() {
    if (!this.canvas) return null;
    let p = this._pick;
    if (!p) {
      const c = document.createElement('canvas');
      /* willReadFrequently: 这张画布的用途就是被反复读像素，提前声明避免 GPU 回读抖动 */
      p = this._pick = {
        canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }),
        map: new Map(), sig: 0, cw: 0, ch: 0,
      };
    }
    /* 只在主画布缓冲区尺寸变了才去量 CSS 尺寸（getBoundingClientRect 会触发布局，
     * hitTest 又在每次 mousemove 上跑，不能每次都量） */
    if (p.cw !== this.canvas.width || p.ch !== this.canvas.height) {
      const rect = this.canvas.getBoundingClientRect();
      p.cw = this.canvas.width; p.ch = this.canvas.height;
      p.canvas.width = Math.max(1, Math.round(rect.width));
      p.canvas.height = Math.max(1, Math.round(rect.height));
      p.sig = 0;   // 改尺寸会清空画布 + 重置 ctx 状态
    }
    const sig = this.pickSig(p.canvas.width, p.canvas.height);
    if (p.sig !== sig) { this.buildPick(p, p.canvas.width, p.canvas.height); p.sig = sig; }
    return p;
  },

  /* 用唯一色重画三类元素。色号 = 序号 × 8（r 低 5 位 + g 进位，b 恒 0），
   * 背景全透明 → 读出来 a 为 0 就是空白。
   * 为什么 ×8：抗锯齿边缘的半透明像素会被浏览器「预乘 alpha → 读回非预乘」的往返舍入
   * 污染（rgb(3,0,0) 在 a≈0.3 时读回来可能是 2 或 4）——密排编号会让边缘命中串成
   * 相邻创建的另一个元素；8 的间隔配合 pickAt 里 ±2 的容差，舍入伤不到编号 */
  buildPick(p, W, H) {
    const ctx = p.ctx;
    p.map.clear();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!this.floor) return;
    let n = 0;
    const put = (kind, item, draw) => {
      n++;
      const code = n * 8;
      const col = 'rgb(' + (code & 255) + ',' + ((code >> 8) & 255) + ',0)';
      p.map.set(n, { kind, item });
      /* fill/ink = 实体轮廓（参与命中）；accent/accent2 = 装饰（光线、气流、指示灯…）
       * 传透明 → 装饰既不命中也不遮挡，否则空调下方的"气流弧"会把热区往外撑一圈 */
      draw(pickCtx(ctx, col), { fill: col, ink: col, accent: 'rgba(0,0,0,0)', accent2: 'rgba(0,0,0,0)', lw: 1 });
    };
    /* 顺序 = 绘制顺序（后画的盖先画的）→ 拾取结果天然是「看得见的最上面那个」 */
    this.floor.windows.forEach((o) => put('window', o, (c, pal) => this.drawDoorWindow(c, o, true, pal)));
    this.floor.doors.forEach((o) => put('door', o, (c, pal) => this.drawDoorWindow(c, o, false, pal)));
    this.floor.furniture.forEach((f) => put('furniture', f, (c, pal) => this.drawFurniture(c, f, pal)));
    this.floor.devices.forEach((d) => put('device', d, (c, pal) => this.drawDevice(c, d, pal)));
  },

  /* 读一个点（屏幕 CSS 坐标）：取 PICK_PAD 邻域内「离点击点最近」的 id 色。
   * 取最近而不是取出现次数最多 —— 贴着两个元素的交界点按时，选离得更近的那个 */
  pickAt(sx, sy) {
    const p = this.ensurePick();
    if (!p || !p.map.size) return null;
    const W = p.canvas.width, H = p.canvas.height;
    const cx = Math.round(sx), cy = Math.round(sy), r = this.PICK_PAD;
    const x0 = Math.max(0, cx - r), y0 = Math.max(0, cy - r);
    const x1 = Math.min(W, cx + r + 1), y1 = Math.min(H, cy + r + 1);
    if (x1 <= x0 || y1 <= y0) return null;
    let img;
    try { img = p.ctx.getImageData(x0, y0, x1 - x0, y1 - y0); } catch (e) { return null; }
    const d = img.data, w = x1 - x0;
    let best = null, bestD = Infinity;
    for (let i = 0, px = 0; i < d.length; i += 4, px++) {
      if (d[i + 3] !== 255) continue;   // 只认完全不透明：半透明边缘像素被预乘舍入污染，色号不可信
      const raw = d[i] | (d[i + 1] << 8);          // = 序号 × 8
      const n = Math.round(raw / 8);
      if (n < 1 || Math.abs(raw - n * 8) > 2) continue;   // 不在合法格点上（杂色/融合色）→ 忽略
      const e = p.map.get(n);
      if (!e) continue;
      const col = px % w, row = (px - col) / w;
      const dx = x0 + col - sx, dy = y0 + row - sy;
      const dist = dx * dx + dy * dy;
      if (dist < bestD) { bestD = dist; best = e; }
    }
    return best ? { kind: best.kind, item: best.item } : null;
  },

  hitTest(wx, wy) {
    if (!this.floor) return null;
    const [sx, sy] = this.toScreen(wx, wy);
    const hit = this.pickAt(sx, sy);
    if (hit) {
      /* 家具压在门窗上时仍优先门窗（原有体验）：家具靠墙放常与门窗符号重叠，
       * 若点在门窗符号本身附近，把它从家具手里夺回来，否则门被沙发盖住就再也点不中 */
      if (hit.kind === 'furniture') {
        const o = this.hitOpenings(wx, wy);
        if (o) return o;
      }
      return hit;
    }
    const hw = this.hitWall(wx, wy);
    if (hw) return { kind: 'wall', item: hw.wall };
    /* 房间兜底：只有点在空白（既没压元素也没压墙）时才落到房间面上。
     * 顺序固定为 元素 → 墙 → 房间 —— 房间是地面分区，不能抢上面几层的东西。 */
    const hr = this.hitRoom(wx, wy);
    return hr ? { kind: 'room', item: hr } : null;
  },

  /* 门窗的解析复判（只在「家具已经命中」时用）：先门后窗，顺序与绘制优先级一致 */
  hitOpenings(wx, wy) {
    for (let i = this.floor.doors.length - 1; i >= 0; i--) {
      const o = this.floor.doors[i];
      if (this.hitOpening(o, wx, wy)) return { kind: 'door', item: o };
    }
    for (let i = this.floor.windows.length - 1; i >= 0; i--) {
      const o = this.floor.windows[i];
      if (this.hitOpening(o, wx, wy)) return { kind: 'window', item: o };
    }
    return null;
  },

  /* 门窗命中: 点击点到「洞口线段」（沿墙方向、长 o.w、中心 o.x/y）的距离 < 0.25m */
  hitOpening(o, wx, wy) {
    const r = (o.rot || 0) * Math.PI / 180;   // rot 存度，与设备同一单位
    const c = Math.cos(r), s = Math.sin(r);
    const hx = c * o.w / 2, hy = s * o.w / 2;
    const dx = hx * 2, dy = hy * 2;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((wx - (o.x - hx)) * dx + (wy - (o.y - hy)) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    /* 0.25m 对小符号偏窄；缩得很小时再补一条「至少 8 屏幕像素」的下限 */
    const tol = Math.max(0.25, 8 / this.ppm);
    return Math.hypot(wx - (o.x - hx + dx * t), wy - (o.y - hy + dy * t)) < tol;
  },

  /* 选中墙的端点圆圈命中（屏幕坐标）: 返回 { wall, end: 1|2 } 或 null。
   * 只有「已选中的墙」才判端点 —— 未选中时先点一下选中，再点端圈拖动 */
  hitWallEnd(sx, sy) {
    if (!this.selection || this.selection.kind !== 'wall' || !this.floor) return null;
    const w = this.floor.walls.find((x) => x.id === this.selection.id);
    if (!w) return null;
    const r = Math.max(w.t * this.ppm / 2 + 6, 14);   // 端帽半径 + 呼吸，最小 14px 好点
    const ends = [[w.x1, w.y1, 1], [w.x2, w.y2, 2]];
    for (const [px, py, end] of ends) {
      const [ex, ey] = this.toScreen(px, py);
      if (Math.hypot(sx - ex, sy - ey) <= r) return { wall: w, end };
    }
    return null;
  },

  /* 选中房间的顶点手柄命中（屏幕坐标）: 返回顶点序号或 -1。
   * 与 hitWallEnd 同一范式 —— 只有「已选中的房间」才画手柄也才判命中：
   * 未选中时先点一下房间内部选中它，顶点才浮出来，避免画布上到处是抓取点。
   * 热区 12px（视觉手柄 5px 半径）：缩得再小也点得中，与墙体端点的 14px 同量级。 */
  hitRoomVert(sx, sy) {
    if (!this.selection || this.selection.kind !== 'room' || !this.floor) return -1;
    const r = (this.floor.rooms || []).find((x) => x.id === this.selection.id);
    if (!r || !Array.isArray(r.pts)) return -1;
    const R = this.VERT_HIT;
    for (let i = 0; i < r.pts.length; i++) {
      const [ex, ey] = this.toScreen(r.pts[i][0], r.pts[i][1]);
      if (Math.hypot(sx - ex, sy - ey) <= R) return i;
    }
    return -1;
  },

  select(kind, id, kind2) { this.selection = kind ? { kind: kind2 || kind, id } : null; if (window.App && window.App.setSelection) window.App.setSelection(this.selection); },

  deleteSelection() {
    if (!this.selection || !this.floor) return;
    const { kind, id } = this.selection;
    const arr = this.floor[KIND_ARR[kind]];
    let deleted = false;
    if (arr) {
      const i = arr.findIndex((x) => x.id === id);
      if (i >= 0) { arr.splice(i, 1); deleted = true; }
    }
    /* 删房间必须同时清掉设备/家具/门窗上的引用：留下悬空 roomId，面板会显示一个
     * 查不到名字的房间，房间统计也会算进一个不存在的房间 */
    if (kind === 'room') {
      const orphan = [
        ...(this.floor.doors || []), ...(this.floor.windows || []),
        ...(this.floor.devices || []), ...(this.floor.furniture || []),
      ].filter((x) => x && x.roomId === id);
      /* 房间没了 → 这批元素失去归属。**只重判这一批**（明确落在另一间房里就归过去），
       * 别处已有的归属一律不碰：全层重算会把「手动指过房间」的元素按几何改掉。
       * 落在所有房间外/贴边的保持「未归属」，等用户手改。 */
      orphan.forEach((x) => {
        delete x.roomId;
        const nid = this.roomIdAt(x.x, x.y);
        if (nid && nid !== id) x.roomId = nid;
      });
      if (orphan.length) deleted = true;
    }
    this.select(null);   // 两边选中态同步走 select
    /* 选中项早已不存在（如被撤销栈恢复过）时数据未变，不压撤销 */
    if (deleted) this.changed(false, 'del:' + kind + ':' + id);
  },

  /* light=拖拽中的轻量重绘; label=改动来源（历史栈据此把连续同类操作合并为一步） */
  changed(light, label) {
    this.render();
    if (this.onChange) this.onChange(light, label);
  },

  flashTip(msg) {
    const tip = document.getElementById('tooltip');
    tip.textContent = msg;
    tip.style.left = '50%'; tip.style.top = '60px';
    tip.classList.remove('hidden');
    clearTimeout(this._ft);
    this._ft = setTimeout(() => tip.classList.add('hidden'), 1600);
  },

  /* ------- 渲染 ------- */
  render() {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.canvas.width, h = this.canvas.height;
    const dpr = devicePixelRatio;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#eef1f5';
    ctx.fillRect(0, 0, w, h);
    if (!this.floor) return;
    ctx.scale(dpr, dpr);
    const W = w / dpr, H = h / dpr;

    // 网格
    const step = 0.5 * this.ppm;
    if (step > 6) {
      ctx.strokeStyle = 'rgba(150,160,180,.16)';
      ctx.lineWidth = 1;
      const [gx0, gy0] = this.toScreen(0, 0);
      for (let x = gx0 % step; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = gy0 % step; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    }

    // 贴图参考（hidden=手动隐藏，仍保留可再显示）
    if (this.backgroundImage && this.backgroundImage.img && !this.backgroundImage.hidden) {
      const bg = this.backgroundImage;
      const [bx, by] = this.toScreen(bg.x, bg.y);
      ctx.globalAlpha = bg.opacity == null ? 0.35 : bg.opacity;
      ctx.drawImage(bg.img, bx, by, bg.w * this.ppm, bg.w * this.ppm * (bg.img.height / bg.img.width));
      ctx.globalAlpha = 1;
    }

    /* 房间地面分区：画在墙 / 家具 / 设备**下面**（紧贴贴图之上）。观感必须是「地面铺了色」，
     * 而不是盖在户型上的一块色块 —— 墙线、门洞、家具都得压在它上面。 */
    (this.floor.rooms || []).forEach((r) => this.drawRoom(ctx, r));

    // 墙体
    this.floor.walls.forEach((wl) => {
      const [x1, y1] = this.toScreen(wl.x1, wl.y1);
      const [x2, y2] = this.toScreen(wl.x2, wl.y2);
      const t = Math.max(4, wl.t * this.ppm);
      const sel = this.selection && this.selection.kind === 'wall' && this.selection.id === wl.id;
      ctx.lineCap = 'butt';
      // 白底
      ctx.strokeStyle = '#fdfdfe';
      ctx.lineWidth = t;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      // 边框（画两条平行线）
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const nx = Math.sin(ang) * t / 2, ny = -Math.cos(ang) * t / 2;
      ctx.strokeStyle = sel ? '#3b82f6' : '#2a3346';
      ctx.lineWidth = 1.6;
      [[nx, ny], [-nx, -ny]].forEach(([ox2, oy2]) => {
        ctx.beginPath(); ctx.moveTo(x1 + ox2, y1 + oy2); ctx.lineTo(x2 + ox2, y2 + oy2); ctx.stroke();
      });
      // 端帽
      [[x1, y1], [x2, y2]].forEach(([cx, cy]) => {
        ctx.fillStyle = sel ? '#3b82f6' : '#2a3346';
        ctx.beginPath(); ctx.arc(cx, cy, t / 2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fdfdfe';
        ctx.beginPath(); ctx.arc(cx, cy, t / 2 - 1.2, 0, Math.PI * 2); ctx.fill();
      });
      /* 选中墙: 端点叠加高亮拖拽圆（白底蓝圈）——表示端点可拖 */
      if (sel) {
        [[x1, y1], [x2, y2]].forEach(([cx, cy]) => {
          ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
          ctx.fillStyle = '#fff'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = '#3b82f6'; ctx.stroke();
        });
        /* 选中才显示长度（未选中不显示，避免画面堆字）；贴在墙面一侧，文字始终保持可读方向 */
        const lenM = Math.hypot(wl.x2 - wl.x1, wl.y2 - wl.y1);
        let rot = Math.atan2(y2 - y1, x2 - x1);
        if (rot > Math.PI / 2) rot -= Math.PI;
        if (rot < -Math.PI / 2) rot += Math.PI;
        ctx.save();
        ctx.translate((x1 + x2) / 2, (y1 + y2) / 2);
        ctx.rotate(rot);
        const lbl = lenM.toFixed(2) + ' m';
        ctx.font = 'bold 11px -apple-system, system-ui, sans-serif';
        const tw = ctx.measureText(lbl).width;
        const ty = -(t / 2 + 8);              // 沿法线抬到墙外侧（屏幕上方那一侧）
        ctx.fillStyle = 'rgba(255,255,255,.92)';
        roundRect(ctx, -tw / 2 - 4, ty - 8, tw + 8, 15, 4);
        ctx.fill();
        ctx.fillStyle = '#1d4ed8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(lbl, 0, ty);
        ctx.restore();
      }
    });

    /* 三类元素都走「绘制函数」而不是内联：视觉层与拾取层（pickAt）共用同一份代码，
     * 形状只有一处定义 —— 改绘制就同时改命中，不会两边漂移 */
    // 窗（墙上蓝条）
    this.floor.windows.forEach((wd) => this.drawDoorWindow(ctx, wd, true));
    // 门
    this.floor.doors.forEach((d) => this.drawDoorWindow(ctx, d, false));
    // 家具
    this.floor.furniture.forEach((f) => this.drawFurniture(ctx, f));
    // 设备
    this.floor.devices.forEach((d) => this.drawDevice(ctx, d));

    // 绘制预览（画墙 / ghost）
    if (this.tool === 'wall' && this.wallStart) {
      const [x1, y1] = this.toScreen(...this.wallStart);
      const [px, py] = this.wallPoint(this.mouse.wx, this.mouse.wy);
      const [x2, y2] = this.toScreen(px, py);
      const t = Math.max(4, this.WALL_T * this.ppm);
      ctx.strokeStyle = 'rgba(59,130,246,.85)';
      ctx.lineWidth = t;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      const len = Math.hypot(px - this.wallStart[0], py - this.wallStart[1]);
      ctx.fillStyle = '#1c2333';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText((len).toFixed(2) + ' m', (x1 + x2) / 2, (y1 + y2) / 2 - 12);
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#6b7280';
      ctx.fillText('单击继续 · 双击/右键结束', (x1 + x2) / 2, (y1 + y2) / 2 + 22);
    }
    /* 画房间预览：>=3 点即「自动闭合」成一个面，但还能继续加点把面撑大 ——
     * 闭合是视觉层的实时结果，不是落盘动作；真正落定由双击/右键/点回起点/Esc 触发。
     * 橡皮筋始终从「最后一个已落定点」连到吸附后的鼠标点，所见即所得。 */
    if (this.tool === 'room' && this.roomPts && this.roomPts.length) {
      const pts = this.roomPts;
      const scr = pts.map(([x, y]) => this.toScreen(x, y));
      const closed = pts.length >= 3;
      ctx.beginPath();
      scr.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (closed) {
        ctx.closePath();
        ctx.fillStyle = 'rgba(59,130,246,.14)';
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(59,130,246,.8)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      /* 橡皮筋：最后一点 → 鼠标（吸附后）。鼠标再点就是新顶点 */
      const [ls, lt] = scr[scr.length - 1];
      const [mx, my] = this.roomPoint(this.mouse.wx, this.mouse.wy);
      const [msx, msy] = this.toScreen(mx, my);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = 'rgba(59,130,246,.6)';
      ctx.beginPath(); ctx.moveTo(ls, lt); ctx.lineTo(msx, msy); ctx.stroke();
      ctx.setLineDash([]);
      /* 顶点：起点实心（点回它可闭合），其余白底蓝圈 */
      scr.forEach(([x, y], i) => {
        ctx.beginPath(); ctx.arc(x, y, i === 0 ? 4.5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#3b82f6' : '#fff';
        ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = '#3b82f6'; ctx.stroke();
      });
      /* 面积：>=3 点实时算（只算已落定点，不含橡皮筋，避免数字随鼠标乱跳） */
      if (closed) {
        const [ax, ay] = this.toScreen(...roomCentroid(pts));
        const lbl = Math.abs(roomArea(pts)).toFixed(1) + ' m²';
        ctx.font = 'bold 12px -apple-system, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(lbl).width;
        ctx.fillStyle = 'rgba(255,255,255,.94)';
        roundRect(ctx, ax - tw / 2 - 6, ay - 9, tw + 12, 18, 5);
        ctx.fill();
        ctx.fillStyle = '#1d4ed8';
        ctx.fillText(lbl, ax, ay);
      }
      /* 操作提示跟随鼠标（贴边自动翻到左侧/上方，和 drawAxisHint 同一套逻辑） */
      const tip = '单击加点 · 3 点自动闭合 · 双击/右键落定 · Esc 结束';
      ctx.font = '11px -apple-system, system-ui, sans-serif';
      const tw2 = ctx.measureText(tip).width;
      const W2 = this.canvas.width / devicePixelRatio, H2 = this.canvas.height / devicePixelRatio;
      let bx = msx + 16, by = msy + 18;
      if (bx + tw2 + 14 > W2 - 4) bx = msx - 16 - tw2 - 14;
      if (by + 20 > H2 - 4) by = msy - 18 - 20;
      ctx.fillStyle = 'rgba(255,255,255,.94)';
      roundRect(ctx, bx, by, tw2 + 14, 20, 5);
      ctx.fill();
      ctx.fillStyle = '#6b7280';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tip, bx + (tw2 + 14) / 2, by + 10);
    }

    if (this.ghost && !this.isSelectTool()) {
      const [x, y] = this.toScreen(this.snapG(this.mouse.wx), this.snapG(this.mouse.wy));
      ctx.globalAlpha = .6;
      if (this.ghost.kind === 'furniture' || this.ghost.kind === 'furn-plugin') {
        const g = this.ghost.data;
        ctx.fillStyle = g.color || '#c9a26e';
        roundRect(ctx, x - g.w * this.ppm / 2, y - g.d * this.ppm / 2, g.w * this.ppm, g.d * this.ppm, 5);
        ctx.fill();
        /* 插件家具再补一圈虚线：提示落点是 floors.devices 的动态实例（尺寸由插件决定） */
        if (this.ghost.kind === 'furn-plugin') {
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else if (this.ghost.kind === 'device') {
        ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(59,130,246,.35)'; ctx.fill();
        ctx.strokeStyle = '#3b82f6'; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    /* 房间顶点手柄最后画 = 永远在最顶层，不会被后画的墙、门窗、家具、设备盖住
     * （房间本体在渲染顺序里是最底层，但「拖拽手柄」是交互元素，必须盖在所有东西上） */
    this.drawRoomHandles();
    this.drawAxisHint();
    this.drawRulers();
    /* 标线**最后画** = 全画布最高图层：墙、门窗、家具、设备、房间手柄、ghost、刻度尺全在它下面 */
    this.drawMeasures();
  },

  /* ------- 测量标线 ------- */
  MEASURE: '#e11d48',   // 玫红：与墙深灰 #2a3346、选中蓝 #3b82f6、房间色都区分得开

  /* 一个固定点 + 若干条标线 + 活线（测量中）。层级由 render() 保证（最后调用）。 */
  drawMeasures() {
    if (!this.floor || !this.ctx) return;
    const ctx = this.ctx;
    const measuring = this.tool === 'measure';
    if (!this.measures.length && !measuring) return;
    ctx.save();
    /* ① 已落定的线：常驻，按绘制顺序叠放 */
    this.measures.forEach((m) => this.drawMeasureSeg(ctx, m.x1, m.y1, m.x2, m.y2, false));
    /* ② 锚点 + 活线：测量中才画 */
    if (measuring) {
      const [msx, msy] = this.toScreen(this.mouse.wx, this.mouse.wy);
      if (this.measureFrom) {
        const [ax, ay] = this.measureFrom;
        const [lx, ly] = this.measurePoint(this.mouse.wx, this.mouse.wy);
        const len = Math.hypot(lx - ax, ly - ay);
        /* 活线：半透明虚线 + 鼠标端空心圆（锚点实心，一眼分得清哪头是起点） */
        if (len >= 0.02) {
          this.drawMeasureSeg(ctx, ax, ay, lx, ly, true);
          const [esx, esy] = this.toScreen(lx, ly);
          ctx.beginPath(); ctx.arc(esx, esy, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#fff'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = this.MEASURE; ctx.stroke();
        }
        /* 锚点：实心玫红圆 + 淡外环，比线端点更重 */
        const [asx, asy] = this.toScreen(ax, ay);
        ctx.beginPath(); ctx.arc(asx, asy, 5, 0, Math.PI * 2);
        ctx.fillStyle = this.MEASURE; ctx.fill();
        ctx.beginPath(); ctx.arc(asx, asy, 8.5, 0, Math.PI * 2);
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(225,29,72,.35)'; ctx.stroke();
      }
      /* 鼠标旁操作提示（与画房间同一套贴边翻转） */
      const tip = this.measureFrom
        ? '单击落定并续测 · Shift 锁水平/垂直 · 右键结束 · Esc 清除'
        : '单击确定起点 · Esc 清除';
      ctx.font = '11px -apple-system, system-ui, sans-serif';
      const tw = ctx.measureText(tip).width;
      const W = this.canvas.width / devicePixelRatio, H = this.canvas.height / devicePixelRatio;
      let bx = msx + 16, by = msy + 18;
      if (bx + tw + 14 > W - 4) bx = msx - 16 - tw - 14;
      if (by + 20 > H - 4) by = msy - 18 - 20;
      ctx.fillStyle = 'rgba(255,255,255,.94)';
      roundRect(ctx, bx, by, tw + 14, 20, 5);
      ctx.fill();
      ctx.fillStyle = '#6b7280';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tip, bx + (tw + 14) / 2, by + 10);
    }
    ctx.restore();
  },

  /* 单条标线：虚线 + 两端圆点 + 长度标签。live=true 时整体半透明（跟随鼠标的那条）。
   * 标签随线旋转但始终正着读（角度翻正），白底 pill 保证压在深色墙线上也清晰。 */
  drawMeasureSeg(ctx, x1, y1, x2, y2, live) {
    const [sx1, sy1] = this.toScreen(x1, y1);
    const [sx2, sy2] = this.toScreen(x2, y2);
    ctx.save();
    ctx.globalAlpha = live ? 0.72 : 1;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = this.MEASURE;
    ctx.beginPath(); ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2); ctx.stroke();
    ctx.setLineDash([]);
    [[sx1, sy1], [sx2, sy2]].forEach(([cx, cy]) => {
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = this.MEASURE; ctx.stroke();
    });
    let rot = Math.atan2(sy2 - sy1, sx2 - sx1);
    if (rot > Math.PI / 2) rot -= Math.PI;
    if (rot < -Math.PI / 2) rot += Math.PI;
    ctx.translate((sx1 + sx2) / 2, (sy1 + sy2) / 2);
    ctx.rotate(rot);
    const lbl = Math.hypot(x2 - x1, y2 - y1).toFixed(2) + ' m';
    ctx.font = 'bold 12px -apple-system, system-ui, sans-serif';
    const tw = ctx.measureText(lbl).width;
    const ty = -12;                     // 沿法线抬到线的一侧
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    roundRect(ctx, -tw / 2 - 5, ty - 8, tw + 10, 16, 4);
    ctx.fill();
    ctx.fillStyle = '#be123c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lbl, 0, ty);
    ctx.restore();
  },

  /* 选中房间的顶点手柄（叠在最上层）。
   * 视觉：白底 + 蓝环 + 中心蓝点，外面再套一圈半透明白环当描边 ——
   *       压在深色墙线或彩色家具上也能一眼看见；悬停/正在拖的那个放大 2px 并填实心蓝。
   * 命中不在这里算：走 hitRoomVert（半径 VERT_HIT，比手柄大一圈，不用像素级对准）。 */
  drawRoomHandles() {
    if (!this.selection || this.selection.kind !== 'room' || !this.floor) return;
    const r = (this.floor.rooms || []).find((x) => x.id === this.selection.id);
    if (!r || !Array.isArray(r.pts) || r.pts.length < 3) return;
    const ctx = this.ctx;
    const dragI = (this.dragVert && this.dragVert.room === r) ? this.dragVert.i : -1;
    ctx.save();
    r.pts.forEach(([wx, wy], i) => {
      const [x, y] = this.toScreen(wx, wy);
      const hot = i === this.hoverVert || i === dragI;
      const rad = this.VERT_R + (hot ? 2 : 0);
      /* 外层白晕：垫在任何背景上都拉得开对比度（比纯描边更"顶"） */
      ctx.beginPath(); ctx.arc(x, y, rad + 2.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = hot ? '#3b82f6' : '#fff'; ctx.fill();
      ctx.lineWidth = hot ? 2 : 1.8;
      ctx.strokeStyle = hot ? '#1d4ed8' : '#2563eb';
      ctx.stroke();
      /* 未悬停：中间点一个小蓝点，和墙端点的空心圆区分开（空心=墙，实心点=房间顶点） */
      if (!hot) {
        ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = '#2563eb'; ctx.fill();
      }
    });
    ctx.restore();
  },

  /* ============ 元素绘制（视觉层 / 拾取层共用） ============
   * paint 为空 = 视觉层，按设计稿配色 + 选中态 + 文字；
   * paint 有值 = 拾取层（见 buildPick），整块元素只画成这个唯一的 id 色。
   * 之所以抽成函数：形状只写一份，改绘制就等于改命中，不会出现两套几何漂移。 */

  /* 房间：半透明地面分区 + 虚线边界 + 名称/面积标签。
   * 只画视觉层 —— 房间不进离屏拾取层（原因见 hitRoom 注释），所以没有 paint 分支。 */
  drawRoom(ctx, r) {
    const pts = (r && r.pts) || [];
    if (pts.length < 3) return;
    const sel = this.selection && this.selection.kind === 'room' && this.selection.id === r.id;
    const scr = pts.map(([x, y]) => this.toScreen(x, y));
    ctx.save();
    ctx.beginPath();
    scr.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    /* 填充浅、边界细：房间是背景信息，权重必须低于墙线与家具。
     * 颜色取实例色（新建时按序号分配、落盘后固定），删掉别的房间不会让这间整体换色 */
    ctx.globalAlpha = sel ? 0.55 : 0.38;
    ctx.fillStyle = r.color || roomColor(0);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = sel ? '#3b82f6' : 'rgba(96,116,146,.55)';
    ctx.lineWidth = sel ? 2 : 1.2;
    if (!sel) ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    /* 标签：按屏幕像素面积决定要不要写（< 2600px² 的小房间不写，避免糊成一团）。
     * 未选中只写名字，选中才追加面积 —— 房间多时画面才干净 */
    const area = Math.abs(roomArea(pts));
    if (area * this.ppm * this.ppm > 2600) {
      const [ax, ay] = this.toScreen(...roomCentroid(pts));
      const label = (r.name || '房间') + (sel ? ' · ' + area.toFixed(1) + ' m²' : '');
      ctx.font = (sel ? 'bold ' : '') + '11px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = sel ? 'rgba(255,255,255,.94)' : 'rgba(255,255,255,.8)';
      roundRect(ctx, ax - tw / 2 - 5, ay - 8, tw + 10, 16, 4);
      ctx.fill();
      ctx.fillStyle = sel ? '#1d4ed8' : 'rgba(70,85,110,.9)';
      ctx.fillText(label, ax, ay);
    }
    ctx.restore();
  },

  /* 家具: 尺寸/名称/颜色从目录形态解析（furnSpec），实例只存 mid + 摆放参数 */
  drawFurniture(ctx, f, paint) {
    const [x, y] = this.toScreen(f.x, f.y);
    const sel = !paint && this.selection && this.selection.kind === 'furniture' && this.selection.id === f.id;
    const S = furnSpec(f);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(f.rot || 0);          // 家具 rot 存弧度（门窗/设备存度 —— 整链唯一的例外，别混用）
    const fpct = (f.pct || 100) / 100;
    const fw = S.w * fpct * this.ppm, fd = S.d * fpct * this.ppm;
    ctx.fillStyle = paint ? paint.fill : S.color + (sel ? '' : 'cc');
    ctx.strokeStyle = paint ? paint.ink : (sel ? '#3b82f6' : 'rgba(90,100,120,.55)');
    ctx.lineWidth = paint ? 1 : (sel ? 2 : 1.2);
    roundRect(ctx, -fw / 2, -fd / 2, fw, fd, Math.min(6, fd / 3));
    ctx.fill(); ctx.stroke();
    if (!paint && fw > 34 && fd > 16) {
      ctx.fillStyle = 'rgba(60,70,90,.75)';
      ctx.font = Math.min(11, fd / 2.2) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(S.name, 0, 0);   // 文字中心 = 方块中心（文字随方块一起旋转）
    }
    ctx.restore();
  },

  /* 设备: 平面简笔模型由插件自绘（plan2d 返回包围半径），编辑器只负责定位与选中虚线圈；
   * 没写 plan2d 的插件用「圆角方块+圆点」中性符号兜底 */
  drawDevice(ctx, d, paint) {
    const [x, y] = this.toScreen(d.x, d.y);
    const sel = !paint && this.selection && this.selection.kind === 'device' && this.selection.id === d.id;
    const st = HA.getState(d.entityId);
    const engine = (window.PluginEngine && PluginEngine.ready) ? PluginEngine : null;
    /* 家具（type:'furniture'）按设计就没有 HA 实体，不能按「未连接」画红描边 ——
     * hasState 只影响描边配色，不改变拾取/选中逻辑 */
    const hasState = !!st || d.type === 'furniture';
    /* 开/关判定统一走 HA.deviceIsOn（按 type/style 取插件顶层 isOn：窗帘 open / 扫地机
     * cleaning / 音箱 playing 由插件自己判断；未声明或插件抛异常时回退 HA.isOn 默认规则） */
    const on = HA.deviceIsOn(d);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((d.rot || 0) * Math.PI / 180);   // 水平旋转(°)，与 3D body.rotation.y 同向（rotate 后画布上方=-Y 即设备朝向）
    const plan = engine ? engine.devicePlan(d.type, d.style) : null;
    /* 状态/选中视觉由抽象层接管:
     * 1) 开/关 = plan2d 用 p.fill 给「线稿封闭形状内部」上色（贴合线框，透明角落不着色），
     *    颜色来自统一调色板（开=暖琥珀 / 关=白）—— 编辑器不再画整圆背景
     * 2) 选中 = 画完模型后统一叠加蓝色虚线圈（小模型贴合包裹 / 大模型封顶内叠）；
     *    例外：家具（type:'furniture'）不画 —— 见下方 drawSelRing 的条件
     * plan2d 只画中性线稿模型并返回包围半径 */
    /* 调色板统一走 PluginEngine.devicePalette（编辑器直接 ESM 引入，恒可用，不再字面量兜底） */
    const pal = paint || PluginEngine.devicePalette({ sel, on, hasState });
    const p = {
      sel, on, hasState: hasState, ppm: this.ppm, type: d.type,
      style: String(d.style || '').split(':').pop(),
      entityId: d.entityId, state: st, obj: d, getState: (id) => HA.getState(id),
      ink: pal.ink, fill: pal.fill, accent: pal.accent, accent2: pal.accent2, lw: pal.lw,
    };
    const rr = plan ? plan(ctx, p) : this.drawDeviceGlyphFallback(ctx, on, !!st, paint);
    /* 家具（type:'furniture'）不画选中虚线圈：
     * 点状设备（灯/插座）需要一个圆形「选中锚」，而家具符号本身就是一个边界明确的封闭
     * 平面轮廓（柜体/床/沙发），虚线圈套在矩形上既盖住门板线又容易和真实尺寸混淆。
     * 家具的选中态由右侧属性面板 + 拖拽/吸附反馈表达（plan2d 的 p.sel 也照常传下去，
     * 插件想自绘高亮可用）。 */
    if (sel && d.type !== 'furniture') this.drawSelRing(ctx, rr || 14);   // 半径在 drawSelRing 内做封顶：小模型贴合包裹 / 大模型内部叠加
    ctx.restore();
  },

  /* Shift 正交锁定的状态提示：鼠标旁一小行灰字「水平」/「垂直」，
   * 生效场景 = 正在画墙（基准=起点）或正在拖墙端点（基准=另一端） */
  drawAxisHint() {
    let axis = null;
    if (shiftHeld) {
      if (this.tool === 'wall' && this.wallStart) {
        axis = this.lockAxis(this.wallStart[0], this.wallStart[1], this.mouse.wx, this.mouse.wy).axis;
      } else if (this.tool === 'room' && this.roomPts && this.roomPts.length) {
        /* 房间的正交基准 = 最后一个已落定点（能拉出与上一条边垂直/延长的边） */
        const bp = this.roomPts[this.roomPts.length - 1];
        axis = this.lockAxis(bp[0], bp[1], this.mouse.wx, this.mouse.wy).axis;
      } else if (this.tool === 'measure' && this.measureFrom) {
        /* 量距的正交基准 = 当前锚点（与画墙同一个气泡反馈） */
        axis = this.lockAxis(this.measureFrom[0], this.measureFrom[1], this.mouse.wx, this.mouse.wy).axis;
      } else if (this.dragEnd && this.dragEnd.wall) {
        const w = this.dragEnd.wall, first = this.dragEnd.end === 1;
        axis = this.lockAxis(first ? w.x2 : w.x1, first ? w.y2 : w.y1, this.mouse.wx, this.mouse.wy).axis;
      }
    }
    if (!axis) return;
    const ctx = this.ctx;
    const txt = axis === 'h' ? '水平' : '垂直';
    const W = this.canvas.width / devicePixelRatio, H = this.canvas.height / devicePixelRatio;
    let [sx, sy] = this.toScreen(this.mouse.wx, this.mouse.wy);
    ctx.save();
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    const tw = ctx.measureText(txt).width;
    const bw = tw + 14, bh = 18;
    let bx = sx + 16, by = sy + 16;
    if (bx + bw > W - 4) bx = sx - 16 - bw;      // 贴边时翻到左侧/上方
    if (by + bh > H - 4) by = sy - 16 - bh;
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    roundRect(ctx, bx, by, bw, bh, 5);
    ctx.fill();
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, bx + bw / 2, by + bh / 2);
    ctx.restore();
  },

  /* 上/左边缘刻度尺（钉在画布边缘，随平移缩放实时更新）:
   * 主刻度间距按缩放自适应（保持在 56px 以上），主刻度标注米数，次级再细分 5 等份 */
  RULER: 22,
  drawRulers() {
    const ctx = this.ctx;
    if (!ctx) return;
    const W = this.canvas.width / devicePixelRatio, H = this.canvas.height / devicePixelRatio;
    const R = this.RULER;
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
    let step = 100;
    for (let i = 0; i < steps.length; i++) { if (steps[i] * this.ppm >= 56) { step = steps[i]; break; } }
    const minor = step / 5;

    ctx.save();
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    // 尺底
    ctx.fillStyle = 'rgba(252,253,255,.94)';
    ctx.fillRect(0, 0, W, R);
    ctx.fillRect(0, 0, R, H);
    ctx.strokeStyle = 'rgba(120,132,152,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, R - 0.5); ctx.lineTo(W, R - 0.5);      // 横尺下沿
    ctx.moveTo(R - 0.5, 0); ctx.lineTo(R - 0.5, H);      // 竖尺右沿
    ctx.stroke();

    // 横尺（世界 x → 屏幕 x）
    const x0 = this.toWorld(R, 0)[0], x1w = this.toWorld(W, 0)[0];
    let i0 = Math.floor(x0 / minor), i1 = Math.ceil(x1w / minor);
    for (let i = i0; i <= i1; i++) {
      const v = Math.round(i * minor * 1000) / 1000;
      const sx = v * this.ppm + this.ox;
      if (sx < R) continue;
      const isMajor = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      ctx.strokeStyle = isMajor ? 'rgba(90,102,124,.75)' : 'rgba(140,152,172,.5)';
      ctx.beginPath();
      ctx.moveTo(sx + 0.5, isMajor ? R - 9 : R - 4.5);
      ctx.lineTo(sx + 0.5, R);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = '#5b6577';
        ctx.textAlign = 'left';
        ctx.fillText(String(Math.round(v * 10) / 10), sx + 3, R / 2 - 3);
      }
    }

    // 竖尺（世界 y → 屏幕 y）
    const y0 = this.toWorld(0, R)[1], y1w = this.toWorld(0, H)[1];
    i0 = Math.floor(y0 / minor); i1 = Math.ceil(y1w / minor);
    for (let i = i0; i <= i1; i++) {
      const v = Math.round(i * minor * 1000) / 1000;
      const sy = v * this.ppm + this.oy;
      if (sy < R) continue;
      const isMajor = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      ctx.strokeStyle = isMajor ? 'rgba(90,102,124,.75)' : 'rgba(140,152,172,.5)';
      ctx.beginPath();
      ctx.moveTo(isMajor ? R - 9 : R - 4.5, sy + 0.5);
      ctx.lineTo(R, sy + 0.5);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = '#5b6577';
        ctx.textAlign = 'left';
        ctx.save();
        ctx.translate(R / 2 - 2, sy + 3);
        ctx.rotate(-Math.PI / 2);       // 竖排文字，自下而上读
        ctx.fillText(String(Math.round(v * 10) / 10), 0, 0);
        ctx.restore();
      }
    }

    // 左上角单位块
    ctx.fillStyle = 'rgba(243,246,251,.98)';
    ctx.fillRect(0, 0, R, R);
    ctx.strokeStyle = 'rgba(120,132,152,.35)';
    ctx.beginPath();
    ctx.moveTo(0, R - 0.5); ctx.lineTo(R, R - 0.5);
    ctx.moveTo(R - 0.5, 0); ctx.lineTo(R - 0.5, R);
    ctx.stroke();
    ctx.fillStyle = '#7a8496';
    ctx.textAlign = 'center';
    ctx.fillText('m', R / 2, R / 2);
    ctx.restore();
  },

  /* 通用兜底: 设备插件没实现 plan2d 时的中性符号（圆角方块 + 圆点），返回包围半径 */
  drawDeviceGlyphFallback(ctx, on, hasState, paint) {
    const s = 0.28 * this.ppm;
    const rad = Math.min(s / 4, 6);
    ctx.beginPath();
    ctx.moveTo(-s / 2 + rad, -s / 2);
    ctx.arcTo(s / 2, -s / 2, s / 2, s / 2, rad);
    ctx.arcTo(s / 2, s / 2, -s / 2, s / 2, rad);
    ctx.arcTo(-s / 2, s / 2, -s / 2, -s / 2, rad);
    ctx.arcTo(-s / 2, -s / 2, s / 2, -s / 2, rad);
    ctx.closePath();
    const pal = paint || PluginEngine.devicePalette({ on, hasState });
    ctx.fillStyle = pal.fill;
    ctx.fill();
    ctx.lineWidth = paint ? 1 : pal.lw;
    ctx.strokeStyle = pal.ink;
    ctx.stroke();
    if (!paint) {   // 中心圆点是装饰，拾取层不画（否则会盖成另一个色块）
      ctx.beginPath(); ctx.arc(0, 0, s * 0.14, 0, Math.PI * 2);
      ctx.fillStyle = pal.accent;
      ctx.fill();
    }
    return s * 0.72;
  },

  /* 设备选中圈: 蓝色虚线圆。半径 = min(插件返回的包围半径 + 4px, SEL_RING_MAX) ——
   * 线稿小 → 贴合式包裹（留 4px 呼吸空隙）；线稿大（如摄像头视场、空调内机）→
   * 圆环封顶后叠加画在线稿之上，作为「选中标记」而不是把整个符号圈起来 */
  SEL_RING_MAX: 26,
  drawSelRing(ctx, r) {
    const rr = Math.min(r + 4, this.SEL_RING_MAX);
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2);
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  },

  /* 门窗平面符号: 造型差异由插件自绘（plan2d(c,p)），这里只负责定位/选中态和通用兜底。
   * 这样新增造型（推拉/对开/卷帘…）只改插件，编辑器不再堆积 sid 分支。 */
  drawDoorWindow(ctx, d, isWindow, paint) {
    const [x, y] = this.toScreen(d.x, d.y);
    const kind = isWindow ? 'window' : 'door';
    const sel = !paint && !!(this.selection && this.selection.kind === kind && this.selection.id === d.id);   // 只高亮被选中的那一个（之前只比 kind，选中任意一扇全部高亮）
    const L = d.w * this.ppm;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((d.rot || 0) * Math.PI / 180);   // 门窗与设备同一单位（度），rotate 后画布上方=-Y 即朝向
    const engine = (window.PluginEngine && PluginEngine.ready) ? PluginEngine : null;
    const get = (id) => HA.getState(id);
    /* 「开」判定走统一入口 HA.deviceIsOn（插件顶层 isOn(obj,get) → 默认规则），
     * 与设备 2D / 3D 标签 / 大屏统计同一口径 */
    const on = HA.deviceIsOn(Object.assign({}, d, { type: kind }));
    const plan = engine ? engine.devicePlan(kind, d.style) : null;
    if (plan) {
      /* fill/accent/accent2/lw 与设备同一套调色板（devicePalette）；ink 是门窗自己的
       * 描边语义（选中蓝 / 窗蓝 / 墙深色），不走设备的灰/红 */
      const pal = paint || PluginEngine.devicePalette({ on, hasState: true });
      plan(ctx, {
        L, sel, on, ppm: this.ppm,
        ink: paint ? paint.ink : (sel ? '#3b82f6' : (isWindow ? '#7fb3e8' : '#2a3346')),
        fill: pal.fill,   // 开=暖琥珀 / 关=白，插件填进封闭形状内部（与设备同一套约定）
        accent: pal.accent,
        accent2: pal.accent2,
        lw: pal.lw,
        entityId: d.entityId, state: get(d.entityId), obj: d, getState: get,
      });
    } else {
      this.drawDoorWindowFallback(ctx, L, isWindow, sel, on, paint);
    }
    ctx.restore();
  },

  /* 通用兜底: 不知道具体造型时只画「洞口矩形 + 中缝线」，插件实现 plan2d 后不会走到这里 */
  drawDoorWindowFallback(ctx, L, isWindow, sel, on, paint) {
    const pal = paint || PluginEngine.devicePalette({ on, hasState: true });
    ctx.fillStyle = pal.fill;
    ctx.strokeStyle = paint ? paint.ink : (sel ? '#3b82f6' : (isWindow ? '#7fb3e8' : '#2a3346'));
    ctx.lineWidth = paint ? 1 : (isWindow ? 2 : pal.lw);
    const h = isWindow ? 6 : 5;
    ctx.fillRect(-L / 2, -3, L, h);
    ctx.strokeRect(-L / 2, -3, L, h);
    if (!paint) {
      ctx.beginPath();
      ctx.moveTo(-L / 2, 0);
      ctx.lineTo(L / 2, 0);
      ctx.stroke();
    }
  },
};

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* 拾取层专用的「单色 ctx」：插件画 2D 符号时会用半透明装饰（例如摄像头的视场扇
 * rgba(148,163,184,.12)）和 p.fill/p.ink。直接照搬会把下面的元素「染色」成读不出 id 的
 * 中间色，那块区域就点不中了。
 * 规则：不透明的颜色 → 全部换成这个元素的 id 色；半透明（alpha < 0.9）→ 什么都不画。
 * 于是「实体轮廓」参与命中、「半透明装饰」既不命中也不遮挡下层，与肉眼看到的一致。 */
function pickCtx(ctx, color) {
  const solid = color, blank = 'rgba(0,0,0,0)';
  return new Proxy(ctx, {
    get(t, k) {
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, k, v) {
      if (k === 'fillStyle' || k === 'strokeStyle' || k === 'shadowColor') {
        t[k] = colorAlpha(v) >= 0.9 ? solid : blank;
        return true;
      }
      if (k === 'globalAlpha') { t[k] = v >= 0.9 ? 1 : 0; return true; }
      if (k === 'globalCompositeOperation') { t[k] = 'source-over'; return true; }
      t[k] = v;
      return true;
    },
  });
}

/* 颜色不透明度，#rgb/#rrggbb/rgb()/命名色 一律当 1，rgba()/#rrggbbaa 取 alpha */
function colorAlpha(v) {
  if (typeof v !== 'string') return 1;   // 渐变 / 图案：按不透明处理
  const s = v.trim().toLowerCase();
  if (s.charAt(0) === '#') {
    if (s.length === 9) return parseInt(s.slice(7, 9), 16) / 255;
    if (s.length === 5) return parseInt(s.charAt(4) + s.charAt(4), 16) / 255;
    return 1;
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(',');
    return parts.length >= 4 ? parseFloat(parts[3]) : 1;
  }
  return 1;
}

/* uid() 已下沉到 catalog.js（大屏页也要用 buildDefaultProject，不能依赖本文件） */

let spaceHeld = false;
let shiftHeld = false;        // 画墙 / 拖墙端点时按住 = 正交锁定
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') spaceHeld = true;
  /* Esc 清标线放在引擎里自清一次：标线状态本来就在这块模块内，不依赖页面层
   * 键盘处理器的调用顺序（页面层那个还负责压撤销栈/退工具，两边互补不冲突）。 */
  if (e.key === 'Escape' && (Editor.measures.length || Editor.measureFrom)) {
    Editor.clearMeasures();
    Editor.render();
  }
  /* 按下 Shift 的那一刻鼠标没动 → 主动重绘一次，预览线与「水平/垂直」提示立即更新 */
  if (e.key === 'Shift' && !shiftHeld) {
    shiftHeld = true;
    if ((Editor.tool === 'wall' && Editor.wallStart)
      || (Editor.tool === 'measure' && Editor.measureFrom)
      || Editor.dragEnd) Editor.render();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceHeld = false;
  if (e.key === 'Shift' && shiftHeld) {
    shiftHeld = false;
    if ((Editor.tool === 'wall' && Editor.wallStart)
      || (Editor.tool === 'measure' && Editor.measureFrom)
      || Editor.dragEnd) Editor.render();
  }
});
/* 切走窗口收不到 keyup，回来自动松开（避免锁定状态卡住） */
window.addEventListener('blur', () => { spaceHeld = false; shiftHeld = false; });
