/*
 * composables/useStageCamera.js — 控制面板取景体系（原 PanelApp.vue 的「取景」方法组）
 *
 * 与 useNumEditing（EditApp 拆分）同一口径：导出方法组对象，根组件
 * `...stageCameraMethods` 摊进 methods，Vue 把每个 method 绑定到组件实例，
 * `this` 语义与原地内联完全一致 —— 纯搬运零行为变化。
 * 依赖的组件上下文：this.sel（refocus 按选中范围分派）、this.autoRotate
 * （_smoothStop 收尾按用户意图恢复自转）。引擎一律走 window 桥接的 View3D。
 *
 * 覆盖：可视区实测（_visibleH / stageMetrics）→ 视锥对中（alignStageView）→
 * 距离与占比换算（fitDistance / fitScale / probeBox）→ 迭代收敛（_convergeFit）→
 * 平滑逼近（_desireFit / _smoothTick / _smoothStop）→ 两个入口（fitStage / fitRoom）
 * 与分派（refocus / focusRoom）。
 * 纯计算已前置在 model/panelCamera.js（可 Node 单测），本模块只留副作用壳。
 */
import { DEFAULT_CAM } from './useStageBoot';
import {
  isWideViewport, STAGE_BAND_INIT,
  FILL_STAGE_WIDE, FILL_STAGE_INIT, FILL_STAGE_GAIN,
  FILL_ROOM_WIDE, FILL_ROOM_GAIN, SMOOTH_K,
} from '../model/stageLayout.js';
import { stageMetricsOf, viewOffsetOf, fitScaleOf, fitDistanceOf, screenBoundsOf } from '../model/panelCamera.js';

export const stageCameraMethods = {
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
    const wide = isWideViewport(W, H);
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

  /* 默认取景：按「整栋房子的包围盒」塞满可视区，再把视锥对到可视区中心。
     animate = true 时用相机飞行过渡（房间 → 全屋 也要有动效，不能硬切）。
     keepDir = true 时保留用户当前视角方向，只改视距 —— 拖窗口改尺寸时用，
     否则每拖一像素就回到默认机位，用户的旋转会被吃掉。 */
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
};
