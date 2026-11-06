/*
 * editor.js — 2D 户型编辑器
 * 网格吸附(0.1m) + 端点吸附；工具: 选择/平移/墙体/门/窗/家具/设备/贴图/背景
 * （删除不是工具: 选中后按 Delete 或点属性栏按钮）
 */
'use strict';

const Editor = {
  canvas: null, ctx: null,
  ppm: 60,                 // 像素/米
  ox: 0, oy: 0,            // 平移偏移(像素)
  tool: 'select',
  floor: null,             // 当前楼层引用
  selection: null,         // {kind:'wall|door|window|furniture|device', id}
  ghost: null,             // 待放置的家具/设备 {kind, data}
  wallStart: null,         // 画墙起点
  mouse: { x: 0, y: 0, wx: 0, wy: 0, down: false },
  panning: false,
  drag: null,              // 拖动选中元素 {kind,id,dx,dy}
  onChange: null,
  onViewChange: null,      // 平移/缩放结束 → App 压一条视图快照（见 recode.js pushView）
  backgroundImage: null,   // 楼层贴图 {img, src, name, x, y, w, opacity, hidden}

  GRID: 0.1,
  WALL_T: 0.24,

  /* 选择类工具：select 与 bg（贴图菜单态，画布行为等同选择） */
  isSelectTool() { return this.tool === 'select' || this.tool === 'bg'; },

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', () => this.resize());

    canvas.addEventListener('mousedown', (e) => this.onDown(e));
    canvas.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', () => { this.wallStart = null; this.render(); });
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.wallStart = null; this.render(); });
    canvas.addEventListener('mouseleave', () => { this.hoverItem = null; this.render(); });
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
    if (!pts.length) { this.ppm = 60; this.ox = this.canvas.width / 2; this.oy = this.canvas.height / 2; this.render(); return; }
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
    if (window.App && App.updateZoomLabel) App.updateZoomLabel(Math.round(this.ppm / 60 * 100));
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
          w: defW || (this.tool === 'door' ? 0.9 : 1.2),
          rot: Math.round(ang * 180 / Math.PI * 1000) / 1000, wallId: w.id };
        (this.tool === 'door' ? this.floor.doors : this.floor.windows).push(item);
        this.select('door/window', item.id, this.tool === 'door' ? 'door' : 'window');
        this.changed(false, this.tool + ':' + item.id);
        break;
      }
      case 'furniture': {
        if (!this.ghost || this.ghost.kind !== 'furniture') break;
        const g = this.ghost.data;
        // 只存 mid（形态标识）+ 摆放参数；type/name/尺寸/颜色/模型等一律由目录形态解析（furnSpec），
        // 目录里改尺寸/换模型，已放置的家具自动跟着变
        const f = { id: uid(), mid: g.id || g.type, x: this.snapG(wx), y: this.snapG(wy), rot: 0 };
        this.floor.furniture.push(f);
        this.select('furniture', f.id);
        this.changed(false, 'furn:' + f.id);
        break;
      }
      case 'device': {
        if (!this.ghost || this.ghost.kind !== 'device') break;
        const g = this.ghost.data;
        // 实例只存实体 id + 类型 + 摆放参数；显示名一律由 HA.friendly(entityId) 解析
        const d = { id: uid(), entityId: g.entityId, type: g.type, x: this.snapG(wx), y: this.snapG(wy) };
        this.floor.devices.push(d);
        this.select('device', d.id);
        this.ghost = null;
        this.changed(false, 'dev:' + d.id);
        break;
      }
      case 'select': default: {
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
          /* 墙体只选中、不拖动（防误移动）；其他元素照常拖 */
          if (hit.kind !== 'wall') {
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
      if (nx !== it.x || ny !== it.y) { it.x = nx; it.y = ny; this.changed(true, 'drag:' + this.drag.kind + ':' + it.id); }
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
        this.changed(true, 'dragend:' + w.id);
      }
      return;
    }
    /* 悬停: 端点圆圈给 grab 光标（拖动中 grabbing），其余走元素提示 */
    if (this.isSelectTool() && this.hitWallEnd(sx, sy)) {
      this.canvas.style.cursor = this.mouse.down ? 'grabbing' : 'grab';
    } else if (this.canvas.style.cursor) {
      this.canvas.style.cursor = '';
    }
    // 悬浮提示（刻度尺区域内不提示：那层上盖着尺子，元素看不见）
    if (this.isSelectTool() && sx >= this.RULER && sy >= this.RULER) {
      const hit = this.hitTest(wx, wy);
      this.hoverItem = hit;
      const tip = document.getElementById('tooltip');
      if (hit) {
        const names = { wall: '墙体', door: '门', window: '窗', furniture: '家具', device: '设备' };
        /* 显示名统一由 itemDisplayName 解析: 设备/门窗跟随 HA 与插件样式，家具跟随目录 */
        const it = hit.item;
        const dispName = itemDisplayName(hit.kind, it);
        let label = names[hit.kind] + (dispName ? ' · ' + dispName : '');
        if (hit.kind === 'device' && hit.item.entityId) {
          const st = HA.getState(hit.item.entityId);
          label += ' · ' + (st ? (st.state === 'on' ? '已开启' : st.state === 'off' ? '已关闭' : st.state) : '无状态');
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
    this.mouse.down = false; this.panning = false; this.panMoved = false; this.drag = null; this.dragEnd = null;
    if (this.canvas && this.canvas.style.cursor) this.canvas.style.cursor = '';
    if (panned) this.viewChanged();
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
    if (window.App) App.updateZoomLabel(Math.round(this.ppm / 60 * 100));
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

  hitTest(wx, wy) {
    if (!this.floor) return null;
    // 设备优先（点状物）
    for (let i = this.floor.devices.length - 1; i >= 0; i--) {
      const d = this.floor.devices[i];
      if (Math.hypot(wx - d.x, wy - d.y) < 0.3) return { kind: 'device', item: d };
    }
    // 门窗先于家具: 门窗是墙上的细长符号，家具包围盒常盖到墙上 —— 家具先判会把
    // 点在窗户/门上的点击整个抢走（表现为「很难点中窗户」）。
    // 判定用「到洞口线段的距离」而不是中心点圆：细长符号两端也能点中，也不误抢两侧
    for (let i = this.floor.doors.length - 1; i >= 0; i--) {
      const o = this.floor.doors[i];
      if (this.hitOpening(o, wx, wy)) return { kind: 'door', item: o };
    }
    for (let i = this.floor.windows.length - 1; i >= 0; i--) {
      const o = this.floor.windows[i];
      if (this.hitOpening(o, wx, wy)) return { kind: 'window', item: o };
    }
    for (let i = this.floor.furniture.length - 1; i >= 0; i--) {
      const f = this.floor.furniture[i];
      const S = furnSpec(f);   // 尺寸从目录形态解析
      const tol = 0.2;
      if (Math.abs(wx - f.x) < S.w * ((f.pct || 100) / 100) / 2 + tol && Math.abs(wy - f.y) < S.d * ((f.pct || 100) / 100) / 2 + tol) return { kind: 'furniture', item: f };
    }
    const hw = this.hitWall(wx, wy);
    return hw ? { kind: 'wall', item: hw.wall } : null;
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
    return Math.hypot(wx - (o.x - hx + dx * t), wy - (o.y - hy + dy * t)) < 0.25;
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

  select(kind, id, kind2) { this.selection = kind ? { kind: kind2 || kind, id } : null; if (window.App && window.App.setSelection) window.App.setSelection(this.selection); },

  deleteSelection() {
    if (!this.selection || !this.floor) return;
    const { kind, id } = this.selection;
    const map = { wall: 'walls', door: 'doors', window: 'windows', furniture: 'furniture', device: 'devices' };
    const arr = this.floor[map[kind]];
    if (arr) {
      const i = arr.findIndex((x) => x.id === id);
      if (i >= 0) arr.splice(i, 1);
    }
    this.select(null);   // 两边选中态同步走 select
    this.changed(false, 'del:' + kind + ':' + id);
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

    // 窗（墙上蓝条）
    this.floor.windows.forEach((wd) => this.drawDoorWindow(wd, true));
    // 门
    this.floor.doors.forEach((d) => this.drawDoorWindow(d, false));

    // 家具（尺寸/名称/颜色从目录形态解析 furnSpec，实例只存 mid + 摆放参数）
    this.floor.furniture.forEach((f) => {
      const [x, y] = this.toScreen(f.x, f.y);
      const sel = this.selection && this.selection.kind === 'furniture' && this.selection.id === f.id;
      const S = furnSpec(f);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(f.rot || 0);
      const fpct = (f.pct || 100) / 100;
      const fw = S.w * fpct * this.ppm, fd = S.d * fpct * this.ppm;
      ctx.fillStyle = S.color + (sel ? '' : 'cc');
      ctx.strokeStyle = sel ? '#3b82f6' : 'rgba(90,100,120,.55)';
      ctx.lineWidth = sel ? 2 : 1.2;
      roundRect(ctx, -fw / 2, -fd / 2, fw, fd, Math.min(6, fd / 3));
      ctx.fill(); ctx.stroke();
      if (fw > 34 && fd > 16) {
        ctx.fillStyle = 'rgba(60,70,90,.75)';
        ctx.font = Math.min(11, fd / 2.2) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(S.name, 0, 0);   // 文字中心 = 方块中心（文字随方块一起旋转）
      }
      ctx.restore();
    });

    // 设备: 平面简笔模型由插件自绘（plan2d 返回包围半径），编辑器只负责定位与选中虚线圈；
    // 没写 plan2d 的插件用「圆角方块+圆点」中性符号兜底
    this.floor.devices.forEach((d) => {
      const [x, y] = this.toScreen(d.x, d.y);
      const sel = this.selection && this.selection.kind === 'device' && this.selection.id === d.id;
      const st = HA.getState(d.entityId);
      const engine = (window.PluginEngine && PluginEngine.ready) ? PluginEngine : null;
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
       * 2) 选中 = 画完模型后统一叠加蓝色虚线圈（小模型贴合包裹 / 大模型封顶内叠）
       * plan2d 只画中性线稿模型并返回包围半径 */
      const pal = (window.PluginEngine && PluginEngine.devicePalette)
        ? PluginEngine.devicePalette({ sel, on, hasState: !!st })
        : { fill: on ? '#fdeecb' : '#fff', ink: st ? '#6b7280' : '#d94f4f', accent: '#c3cad6', accent2: '#9aa3b2', lw: 1.6 };
      const p = {
        sel, on, hasState: !!st, ppm: this.ppm, type: d.type,
        style: String(d.style || '').split(':').pop(),
        entityId: d.entityId, state: st, obj: d, getState: (id) => HA.getState(id),
        ink: pal.ink, fill: pal.fill, accent: pal.accent, accent2: pal.accent2, lw: pal.lw,
      };
      const rr = plan ? plan(ctx, p) : this.drawDeviceGlyphFallback(on, !!st);
      if (sel) this.drawSelRing(rr || 14);   // 半径在 drawSelRing 内做封顶：小模型贴合包裹 / 大模型内部叠加
      ctx.restore();
    });

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
    if (this.ghost && !this.isSelectTool()) {
      const [x, y] = this.toScreen(this.snapG(this.mouse.wx), this.snapG(this.mouse.wy));
      ctx.globalAlpha = .6;
      if (this.ghost.kind === 'furniture') {
        const g = this.ghost.data;
        ctx.fillStyle = g.color || '#c9a26e';
        roundRect(ctx, x - g.w * this.ppm / 2, y - g.d * this.ppm / 2, g.w * this.ppm, g.d * this.ppm, 5);
        ctx.fill();
      } else if (this.ghost.kind === 'device') {
        ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(59,130,246,.35)'; ctx.fill();
        ctx.strokeStyle = '#3b82f6'; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    this.drawAxisHint();
    this.drawRulers();
  },

  /* Shift 正交锁定的状态提示：鼠标旁一小行灰字「水平」/「垂直」，
   * 生效场景 = 正在画墙（基准=起点）或正在拖墙端点（基准=另一端） */
  drawAxisHint() {
    let axis = null;
    if (shiftHeld) {
      if (this.tool === 'wall' && this.wallStart) {
        axis = this.lockAxis(this.wallStart[0], this.wallStart[1], this.mouse.wx, this.mouse.wy).axis;
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
  drawDeviceGlyphFallback(on, hasState) {
    const ctx = this.ctx;
    const s = 0.28 * this.ppm;
    const rad = Math.min(s / 4, 6);
    ctx.beginPath();
    ctx.moveTo(-s / 2 + rad, -s / 2);
    ctx.arcTo(s / 2, -s / 2, s / 2, s / 2, rad);
    ctx.arcTo(s / 2, s / 2, -s / 2, s / 2, rad);
    ctx.arcTo(-s / 2, s / 2, -s / 2, -s / 2, rad);
    ctx.arcTo(-s / 2, -s / 2, s / 2, -s / 2, rad);
    ctx.closePath();
    ctx.fillStyle = on ? '#fdeecb' : '#fff';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = hasState ? '#6b7280' : '#d94f4f';
    ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, s * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = '#c3cad6';
    ctx.fill();
    return s * 0.72;
  },

  /* 设备选中圈: 蓝色虚线圆。半径 = min(插件返回的包围半径 + 4px, SEL_RING_MAX) ——
   * 线稿小 → 贴合式包裹（留 4px 呼吸空隙）；线稿大（如摄像头视场、空调内机）→
   * 圆环封顶后叠加画在线稿之上，作为「选中标记」而不是把整个符号圈起来 */
  SEL_RING_MAX: 26,
  drawSelRing(r) {
    const ctx = this.ctx;
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
  drawDoorWindow(d, isWindow) {
    const ctx = this.ctx;
    const [x, y] = this.toScreen(d.x, d.y);
    const kind = isWindow ? 'window' : 'door';
    const sel = !!(this.selection && this.selection.kind === kind && this.selection.id === d.id);   // 只高亮被选中的那一个（之前只比 kind，选中任意一扇全部高亮）
    const L = d.w * this.ppm;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((d.rot || 0) * Math.PI / 180);   // 门窗与设备同一单位（度），rotate 后画布上方=-Y 即朝向
    const engine = (window.PluginEngine && PluginEngine.ready) ? PluginEngine : null;
    const get = (id) => HA.getState(id);
    /* 「开」判定走统一入口 HA.deviceIsOn（插件顶层 isOn(obj,get) → 默认规则），
     * 与设备 2D / 3D 标签 / 大屏统计同一口径 */
    const on = HA.deviceIsOn({ entityId: d.entityId, type: kind, style: d.style });
    const plan = engine ? engine.devicePlan(kind, d.style) : null;
    if (plan) {
      plan(ctx, {
        L, sel, on, ppm: this.ppm,
        ink: sel ? '#3b82f6' : (isWindow ? '#7fb3e8' : '#2a3346'),
        fill: on ? '#fdeecb' : '#fff',   // 开=暖琥珀 / 关=白，插件填进封闭形状内部（与设备同一套约定）
        entityId: d.entityId, state: get(d.entityId), obj: d, getState: get,
      });
    } else {
      this.drawDoorWindowFallback(L, isWindow, sel, on);
    }
    ctx.restore();
  },

  /* 通用兜底: 不知道具体造型时只画「洞口矩形 + 中缝线」，插件实现 plan2d 后不会走到这里 */
  drawDoorWindowFallback(L, isWindow, sel, on) {
    const ctx = this.ctx;
    ctx.fillStyle = on ? '#fdeecb' : '#fff';
    ctx.strokeStyle = sel ? '#3b82f6' : (isWindow ? '#7fb3e8' : '#2a3346');
    ctx.lineWidth = isWindow ? 2 : 1.6;
    const h = isWindow ? 6 : 5;
    ctx.fillRect(-L / 2, -3, L, h);
    ctx.strokeRect(-L / 2, -3, L, h);
    ctx.beginPath();
    ctx.moveTo(-L / 2, 0);
    ctx.lineTo(L / 2, 0);
    ctx.stroke();
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

let _uidCounter = 0;
function uid() { return 'i' + Date.now().toString(36) + (++_uidCounter).toString(36); }

let spaceHeld = false;
let shiftHeld = false;        // 画墙 / 拖墙端点时按住 = 正交锁定
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') spaceHeld = true;
  /* 按下 Shift 的那一刻鼠标没动 → 主动重绘一次，预览线与「水平/垂直」提示立即更新 */
  if (e.key === 'Shift' && !shiftHeld) {
    shiftHeld = true;
    if ((Editor.tool === 'wall' && Editor.wallStart) || Editor.dragEnd) Editor.render();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceHeld = false;
  if (e.key === 'Shift' && shiftHeld) {
    shiftHeld = false;
    if ((Editor.tool === 'wall' && Editor.wallStart) || Editor.dragEnd) Editor.render();
  }
});
/* 切走窗口收不到 keyup，回来自动松开（避免锁定状态卡住） */
window.addEventListener('blur', () => { spaceHeld = false; shiftHeld = false; });
