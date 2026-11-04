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
    this.ppm = Math.min(w / (maxX - minX + pad * 2), h / (maxY - minY + pad * 2));
    this.ox = (w - (minX + maxX) * this.ppm) / 2;
    this.oy = (h - (minY + maxY) * this.ppm) / 2;
    this.render();
  },

  setZoom(ppm) {
    const [cx, cy] = [this.canvas.width / devicePixelRatio / 2, this.canvas.height / devicePixelRatio / 2];
    const [wx, wy] = this.toWorld(cx, cy);
    this.ppm = Math.max(8, Math.min(400, ppm));
    const [nx, ny] = this.toScreen(wx, wy);
    this.ox += cx - nx; this.oy += cy - ny;
    this.render();
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
      this.panning = true; this.panFrom = [sx, sy]; return;
    }
    if (e.button === 2) return;

    switch (this.tool) {
      case 'wall': {
        const [px, py] = this.snap(wx, wy, null);
        if (!this.wallStart) { this.wallStart = [px, py]; }
        else {
          const [qx, qy] = this.snap(wx, wy, null);
          if (Math.hypot(qx - this.wallStart[0], qy - this.wallStart[1]) > 0.05) {
            const w = { id: uid(), x1: this.wallStart[0], y1: this.wallStart[1], x2: qx, y2: qy, t: this.WALL_T };
            this.floor.walls.push(w);
            this.wallStart = [qx, qy];
            this.changed(false, 'wall');
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
        const item = { id: uid(), x: Math.round(mx * 100) / 100, y: Math.round(my * 100) / 100, w: this.tool === 'door' ? 0.9 : 1.2, rot: ang, wallId: w.id };
        (this.tool === 'door' ? this.floor.doors : this.floor.windows).push(item);
        this.select('door/window', item.id, this.tool === 'door' ? 'door' : 'window');
        this.changed(false, this.tool);
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
        this.changed(false, 'furn');
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
        this.changed(false, 'dev');
        break;
      }
      case 'select': default: {
        const hit = this.hitTest(wx, wy);
        if (hit) {
          this.select(hit.kind, hit.item.id, hit.kind);
          const it = hit.item;
          this.drag = { kind: hit.kind, item: it, dx: wx - it.x, dy: wy - it.y };
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
      this.panFrom = [sx, sy]; this.render(); return;
    }
    if (this.drag && this.mouse.down) {
      const it = this.drag.item;
      const nx = Math.round((wx - this.drag.dx) * 100) / 100;
      const ny = Math.round((wy - this.drag.dy) * 100) / 100;
      if (nx !== it.x || ny !== it.y) { it.x = nx; it.y = ny; this.changed(true); }
      return;
    }
    // 悬浮提示
    if (this.isSelectTool()) {
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
    this.mouse.down = false; this.panning = false; this.drag = null;
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
  },

  snapG(v) { return Math.round(v / this.GRID) * this.GRID; },

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
    const tol = 0.2;
    // 设备 / 家具优先
    for (let i = this.floor.devices.length - 1; i >= 0; i--) {
      const d = this.floor.devices[i];
      if (Math.hypot(wx - d.x, wy - d.y) < 0.3) return { kind: 'device', item: d };
    }
    for (let i = this.floor.furniture.length - 1; i >= 0; i--) {
      const f = this.floor.furniture[i];
      const S = furnSpec(f);   // 尺寸从目录形态解析
      if (Math.abs(wx - f.x) < S.w * ((f.pct || 100) / 100) / 2 + tol && Math.abs(wy - f.y) < S.d * ((f.pct || 100) / 100) / 2 + tol) return { kind: 'furniture', item: f };
    }
    for (let i = this.floor.doors.length - 1; i >= 0; i--) {
      const d = this.floor.doors[i];
      if (Math.hypot(wx - d.x, wy - d.y) < 0.45) return { kind: 'door', item: d };
    }
    for (let i = this.floor.windows.length - 1; i >= 0; i--) {
      const w = this.floor.windows[i];
      if (Math.hypot(wx - w.x, wy - w.y) < 0.45) return { kind: 'window', item: w };
    }
    return this.hitWall(wx, wy) ? { kind: 'wall', item: this.hitWall(wx, wy).wall } : null;
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
    this.changed(false, 'del');
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
      /* 开/关判定跟随插件的 click.isOn（窗帘 open / 扫地机 cleaning / 音箱 playing 等复杂状态
       * 由插件自己判断）；插件没声明时回退 HA.isOn 默认规则 */
      const cspec = engine ? engine.clickSpec(d.type, d.style) : null;
      const on = HA.isOnOf(d.entityId, cspec);
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
      const [px, py] = this.snap(this.mouse.wx, this.mouse.wy, null);
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
    ctx.rotate(d.rot || 0);
    const engine = (window.PluginEngine && PluginEngine.ready) ? PluginEngine : null;
    const get = (id) => HA.getState(id);
    /* 「开」判定: 插件声明了 isOn(obj, get) 则优先（按 fields 绑定的实体组合判断），
     * 没声明回退默认规则——主实体 on/open 即开，未绑定视为关（与 3D 常闭一致） */
    const pOn = engine ? engine.openingIsOn(kind, d.style, d, get) : null;
    const on = pOn != null ? pOn : (() => { const st = d.entityId ? get(d.entityId) : null; return !!(st && (st.state === 'on' || st.state === 'open')); })();
    const plan = engine ? engine.openingPlan(kind, d.style) : null;
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
window.addEventListener('keydown', (e) => { if (e.code === 'Space') spaceHeld = true; });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });
