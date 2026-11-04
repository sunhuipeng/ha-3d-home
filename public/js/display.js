/*
 * display.js — 展示大屏（独立页面，复用 ha.js / catalog.js / plugins.js / view3d.js 共享模块）
 * 长时间展示全屋状态: 3D 场景 + 实时数据 HUD + 自动旋转 + 断线自动重连
 */
'use strict';

const { createApp } = Vue;

/* ---- 取景记忆（按楼层）：拖动/缩放后把相机 x,y,z 与锚点存到 localStorage，
   键为 ha3d.displayCam.f<楼层>；切换楼层时恢复该楼层各自的视角 ---- */
const camKey = (f) => 'ha3d.displayCam.f' + f;
const DEF_CAM = { pos: [6, 12, 9] };                // 各楼层无记忆时的默认机位
let camSaveTimer = null, camSaveFirst = 0;
let camFloor = 0;                                   // 当前取景记忆归属楼层
function scheduleSaveCam() {
  // 自动旋转期间不保存（相机每帧都在被程序转动）；关闭旋转后恢复保存
  if (View3D.controls && View3D.controls.autoRotate) return;
  // 手动旋转/阻尼期间 change 事件高频触发：防抖 400ms，但最长 2s 强制落盘一次
  const now = Date.now();
  if (!camSaveFirst) camSaveFirst = now;
  if (camSaveTimer) clearTimeout(camSaveTimer);
  if (now - camSaveFirst >= 2000) { camSaveFirst = 0; saveCam(); return; }
  camSaveTimer = setTimeout(() => { camSaveFirst = 0; saveCam(); }, 400);
}
function saveCam() {
  try {
    const p = View3D.camera.position, t = View3D.controls.target;
    const r = (n) => Math.round(n * 100) / 100;
    localStorage.setItem(camKey(camFloor), JSON.stringify({
      floor: camFloor,
      pos: [r(p.x), r(p.y), r(p.z)],
      target: [r(t.x), r(t.y), r(t.z)],
    }));
  } catch (e) { /* ignore */ }
}
function applyCam(s) {
  View3D.camera.position.set(s.pos[0], s.pos[1], s.pos[2]);
  const ok = (a) => Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === 'number' && isFinite(n));
  if (ok(s.target)) View3D.controls.target.set(s.target[0], s.target[1], s.target[2]);
  View3D.controls.update();
}
/* 恢复指定楼层的取景记忆（该楼层无记忆时用默认机位） */
function restoreCam(f) {
  try {
    const s = JSON.parse(localStorage.getItem(camKey(f)) || 'null');
    if (s && Array.isArray(s.pos) && s.pos.length === 3) { applyCam(s); return true; }
  } catch (e) { /* ignore */ }
  return false;
}

createApp({
    data() {
    return {
      project: null,
      floorIdx: 0,
      entVersion: 0,
      haStatus: { status: 'connecting' },
      autoRotate: (function () { try { return localStorage.getItem('ha3d.autoRotate') !== '0'; } catch (e) { return true; } })(),
      showLabels: (function () { try { return localStorage.getItem('ha3d.showLabels') !== '0'; } catch (e) { return true; } })(),
      sceneBusy: {},           // eid → 执行中（防连点）
      sceneDone: {},           // eid → 刚执行成功（短暂 ✓ 反馈）
      toast: '',               // 底部轻提示文案
    };
  },

  computed: {
    cur() { return this.project ? this.project.floors[this.floorIdx] : null; },
    /* HUD 派生数据（纯函数在共享模块 hud.js，与编辑页同一套实现） */
    weatherState() {
      void this.entVersion;
      return HUD.weatherState(HA, this.project && this.project.settings);
    },
    hudTemp() {
      void this.entVersion;
      return HUD.hudTemp(this.weatherState);
    },
    hudSubs() {
      void this.entVersion;
      return HUD.hudSubs(this.weatherState);
    },
    hudCards() {
      void this.entVersion;
      return HUD.hudCards(HA, this.cur && this.cur.display);
    },
    /* 已放置设备中开启数量 */
    onCount() {
      void this.entVersion;
      let on = 0;
      if (!this.cur) return 0;
      this.cur.devices.forEach((d) => { if (HA.isOn(d.entityId)) on++; });
      return on;
    },
    deviceTotal() {
      return this.cur ? this.cur.devices.length : 0;
    },
    /* 开启占比（设备概览进度条） */
    onPct() {
      const t = this.deviceTotal;
      if (!t) return 0;
      return Math.max(0, Math.min(100, Math.round((this.onCount / t) * 100)));
    },
    /* HA 场景（仅 scene 实体；当前楼层勾选的优先，未勾选时展示全部场景，无场景则卡片隐藏） */
    /* HA 场景: 严格按当前楼层勾选（cur.display.displayScenes）展示；
     * 该楼层未配置时列表为空，卡片自动隐藏（不再回退展示全部场景） */
    scenes() {
      void this.entVersion;
      const cfg = (this.cur && this.cur.display && this.cur.display.displayScenes) || [];
      return HA.all()
        .filter((s) => /^scene\./.test(s.entity_id) && cfg.includes(s.entity_id))
        .slice(0, 24)
        .map((s) => ({
          eid: s.entity_id,
          name: HA.friendly(s.entity_id),
          type: s.entity_id.split('.')[0],
        }));
    },
    /* 快捷设备: 当前楼层勾选的任意 HA 实体（display.quickDevices，不要求已在户型中放置）；
     * 未勾选时隐藏（演示模式回退灯/插座） */
    quickDevices() {
      void this.entVersion;
      const eids = (this.cur && this.cur.display && this.cur.display.quickDevices) || [];
      let list = eids;
      if (!list.length && HA.demo) {
        list = HA.all()
          .filter((s) => /^light\./.test(s.entity_id) || /^switch\./.test(s.entity_id))
          .slice(0, 8)
          .map((s) => s.entity_id);
      }
      return list
        .map((eid) => {
          const st = HA.getState(eid);
          if (!st) return null;
          const dom = eid.split('.')[0];
          return {
            eid,
            name: HA.friendly(eid),
            icon: dom === 'light' ? '💡' : dom === 'fan' ? '🌀' : dom === 'cover' ? '🪟' : '🔌',
            on: HA.isOn(eid),
          };
        })
        .filter(Boolean);
    },
    statusText() {
      const s = this.haStatus.status;
      if (s === 'connected') return 'Home Assistant 已连接 · 实时同步中';
      if (s === 'demo') return '演示模式（未配置 Home Assistant）';
      if (s === 'connecting') return this.haStatus.message || '连接中…';
      if (s === 'error') return this.haStatus.message || '连接失败';
      return '未连接';
    },
  },

  methods: {
    async init() {
      await loadCatalog();   // 目录先于项目加载（家具形态解析需要）
      // 加载项目（编辑器保存的户型）；无保存数据时回退示例户型（fetchProject 在 catalog.js）
      this.project = await fetchProject() || buildDefaultProject();
      /* 标签页标题: 项目名称 · 大屏 */
      document.title = (this.project && this.project.name ? this.project.name : 'HA 3D Home') + ' · 大屏';

      // 楼层选择持久化: 多楼层时记住上次查看的楼层（单楼层无所谓，控件本身隐藏）
      try {
        const saved = parseInt(localStorage.getItem('ha3d.displayFloor'), 10);
        if (!isNaN(saved) && saved >= 0 && saved < this.project.floors.length) this.floorIdx = saved;
      } catch (e) { /* ignore */ }

      await PluginEngine.loadAll();   // 加载 assets/plugins 有状态模型插件（门窗/设备）
      await this.$nextTick();
      View3D.init('stage');
      View3D.controls.autoRotate = this.autoRotate;
      View3D.controls.autoRotateSpeed = 0.6;
      if (this.project) {
        View3D.rebuild(this.project, this.floorIdx);   // 楼层模型 + 标签 + 渲染（统一入口）
        View3D.frame(DEF_CAM);   // 默认机位；自转锚点仍是房屋中心
        // 取景记忆（按楼层）：恢复当前楼层上次保存的机位；此后每次操作自动保存到所属楼层
        camFloor = this.floorIdx;
        restoreCam(this.floorIdx);
        View3D.controls.addEventListener('change', scheduleSaveCam);
        View3D.onAnchor = () => saveCam();   // 长按设锚点/重置锚点后立即持久化（仅大屏；编辑页不设此回调）
        View3D.setLabelsVisible(this.showLabels);   // 恢复标签开关状态（localStorage 持久化）
        // 背景插件（3D 地面模型，扁平/立体/动态）；未选择时保持大屏浅灰底 + 网格
        const bgId = (this.project.settings && this.project.settings.background) || '';
        PluginEngine.bgOptions = (this.project.settings && this.project.settings.backgroundOptions) || {};
        if (bgId) PluginEngine.applyBackground(bgId, View3D);
      }
      View3D.startLoop();

      // HA 连接（未配置则演示模式；断线自动重连在 ha.js 内）
      await HA.loadConfig();
      HA.on('change', () => this.onHAChange());
      HA.on('status', (s) => { this.haStatus = s; });
      HA.connect();
    },

    selectFloor(i) {
      this.floorIdx = i;
      // 记住选择，刷新/重开大屏后回到同一楼层
      try { localStorage.setItem('ha3d.displayFloor', String(i)); } catch (e) {}
      // 取景记忆（按楼层）：切层先展示该楼层已保存的机位，没有则回默认机位
      // （rebuild 会把锚点重置回户型中心，所以机位恢复必须放在它之后）
      camFloor = i;
      View3D.rebuild(this.project, i);
      if (!restoreCam(i)) View3D.frame(DEF_CAM);
    },

    onHAChange() {
      this.entVersion++;
      this.checkSceneWatchers();   // WS 状态推送 → 立即核对场景执行回执
      View3D.refresh();
    },

    toggleRotate() {
      this.autoRotate = !this.autoRotate;
      View3D.controls.autoRotate = this.autoRotate;
      // 手动关掉自动旋转时，把当前机位立刻存一次（取景记忆）
      if (!this.autoRotate) saveCam();
      // 持久化旋转开关状态（刷新/重开大屏后保持）
      try { localStorage.setItem('ha3d.autoRotate', this.autoRotate ? '1' : '0'); } catch (e) {}
    },

    /* 锚点重置回房屋中心（长按左键可自定义锚点；此按钮一键还原） */
    resetAnchor() {
      View3D.resetAnchor();   // onAnchor 回调已指向 saveCam，会随重置立即持久化
    },

    /* 设备标签显示开关（与自动旋转同款：localStorage 记住选择，刷新保持） */
    toggleLabels() {
      this.showLabels = !this.showLabels;
      View3D.setLabelsVisible(this.showLabels);
      try { localStorage.setItem('ha3d.showLabels', this.showLabels ? '1' : '0'); } catch (e) {}
    },

    /* 执行场景: 服务调用 → 等待 HA 状态回执（scene 的 state=最近触发时间戳，经 WS 推送）
     * 三态反馈: 转圈(执行中) → ✓(确认执行) / "已发送"(4s 内未收到状态变化，服务已被接受) */
    runScene(s) {
      if (!this._sceneLock) this._sceneLock = {};
      const eid = s.eid;
      if (this.sceneBusy[eid]) return;                       // 本次还在执行
      if (Date.now() < (this._sceneLock[eid] || 0)) return;   // 冷却窗口内忽略
      const domain = s.type;
      const service = domain === 'automation' ? 'trigger' : 'turn_on';
      const before = HA.getState(eid);
      const w = {
        eid,
        preState: before ? before.state : null,
        preLast: before && before.attributes ? before.attributes.last_triggered : null,
      };
      this.sceneBusy[eid] = true;
      this.toastMsg('正在执行 · ' + s.name);
      HA.callService(domain, service, { entity_id: eid })
        .then(() => {
          if (HA.demo) { this.sceneResult(w, true); return; }   // 演示模式视为成功
          this._sceneWatchers = (this._sceneWatchers || []).filter((x) => x.eid !== eid);
          this._sceneWatchers.push(w);
          this.waitSceneConfirm(w);   // WS 推送 + 轮询双路确认
        })
        .catch((e) => {
          console.error('执行失败', e);
          this.sceneBusy[eid] = false;
          this.toastMsg('✗ 执行失败 · ' + s.name);
        });
    },

    /* 确认成功: 绿色 ✓ + 提示；未确认: 服务已发出但 4s 内无状态变化 */
    sceneResult(w, confirmed) {
      this.sceneBusy[w.eid] = false;
      this._sceneLock[w.eid] = Date.now() + 1200;
      if (confirmed) {
        this.sceneDone[w.eid] = true;
        this.toastMsg('✓ 已执行 · ' + HA.friendly(w.eid));
        setTimeout(() => { this.sceneDone[w.eid] = false; }, 1500);
      } else {
        this.toastMsg('已发送（未收到执行回执）· ' + HA.friendly(w.eid));
      }
    },

    /* 状态比对: state 变化 或 last_triggered 变化 都算执行成功 */
    sceneConfirmed(w) {
      const st = HA.getState(w.eid);
      if (!st) return false;
      if (st.state != null && st.state !== w.preState) return true;
      const lt = st.attributes && st.attributes.last_triggered;
      return !!(lt && lt !== w.preLast);
    },

    /* 等待回执: onHAChange 的 WS 推送会触发 checkSceneWatchers；此处再以 400ms 轮询兜底，4s 超时 */
    waitSceneConfirm(w) {
      const t0 = Date.now();
      const tick = () => {
        const list = this._sceneWatchers || [];
        if (!list.includes(w)) return;              // 已由推送路径确认
        if (this.sceneConfirmed(w)) {
          this._sceneWatchers = list.filter((x) => x !== w);
          this.sceneResult(w, true);
          return;
        }
        if (Date.now() - t0 > 4000) {
          this._sceneWatchers = list.filter((x) => x !== w);
          this.sceneResult(w, false);
          return;
        }
        setTimeout(tick, 400);
      };
      setTimeout(tick, 400);
    },

    /* WS 状态推送 → 立即核对挂起的场景回执（比轮询更快） */
    checkSceneWatchers() {
      const list = this._sceneWatchers;
      if (!list || !list.length) return;
      list.slice().forEach((w) => {
        if (this.sceneConfirmed(w)) {
          this._sceneWatchers = this._sceneWatchers.filter((x) => x !== w);
          this.sceneResult(w, true);
        }
      });
    },

    /* 底部轻提示（自动消失） */
    toastMsg(text, ms) {
      this.toast = text;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { this.toast = ''; }, ms || 1600);
    },

    /* 快捷设备开关 */
    toggleQuick(q) {
      const domain = q.eid.split('.')[0];
      HA.callService(domain, 'toggle', { entity_id: q.eid }).catch((e) => {
        console.error('控制失败', e);
      });
    },

    fullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    },
  },

  mounted() { this.init(); },
}).mount('#display');
if (window.__bootDone) window.__bootDone();   // 挂载完成，移除启动图
