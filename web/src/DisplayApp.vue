<template>
  <!-- 启动图: 覆盖 JS 未加载完成时可能闪现的 Vue 模板字符串；样式内联不依赖外部资源 -->
  <div id="boot">
    <div class="b-logo">🏠</div>
    <div class="b-name">HA 3D Home</div>
    <div class="b-spin"></div>
    <div class="b-tip">正在加载，请稍候…</div>
  </div>

  <div id="display" v-cloak>
    <div id="stage"></div>

    <div class="d-hud" v-if="project && project.floors.length">
      <div class="d-top">
        <div class="d-title">
          🏠 {{ project.name }}<a class="d-edit" href="/index.html" title="打开编辑器修改户型">编辑 ↗</a><span class="d-temp">{{ hudTemp }}</span><span class="tb-ver" data-app-version hidden></span>
        </div>
        <div class="d-subs"><span v-for="s in hudSubs" :key="s">{{ s }}</span></div>
      </div>

      <!-- 左侧: 标题下方的实时数据卡 -->
      <div class="d-left" v-if="hudCards.length">
        <div class="d-card" v-for="c in hudCards" :key="c.eid">
          <div class="k">{{ c.name }}</div>
          <div class="v">{{ c.value }}<small> {{ c.unit }}</small></div>
        </div>
      </div>

      <!-- 右侧面板: 单一容器，内部卡片从上到下排列，容器整体纵向滚动 -->
      <div class="d-panel">
        <div class="d-card">
          <div class="ov-row">
            <span class="k">设备概览</span>
            <span class="ov-num">{{ onCount }}<small> / {{ deviceTotal }}</small></span>
          </div>
          <div class="ov-bar"><i :style="{ width: onPct + '%' }"></i></div>
        </div>

        <div class="d-card card-sec" v-if="scenes.length">
          <div class="k">场景</div>
          <div class="sc-list">
            <div class="sc-item" v-for="s in scenes" :key="s.eid">
              <span class="nm" :title="s.name">{{ s.name }}</span>
              <button class="sc-run" :class="{busy: sceneBusy[s.eid], ok: sceneDone[s.eid]}"
                      :disabled="!!sceneBusy[s.eid]"
                      :title="sceneBusy[s.eid] ? '执行中…' : (sceneDone[s.eid] ? '已执行' : '执行场景')"
                      @click="runScene(s)">
                <span v-if="sceneBusy[s.eid]" class="spin"></span>
                <span v-else-if="sceneDone[s.eid]">✓</span>
                <span v-else>▶</span>
              </button>
            </div>
          </div>
        </div>

        <div class="d-card card-sec" v-if="quickDevices.length">
          <div class="k">快捷设备</div>
          <div class="q-grid">
            <button class="act-btn" :class="{on: q.on}" v-for="q in quickDevices" :key="q.eid" :title="q.name" @click="toggleQuick(q)">
              <span class="ic">{{ q.icon }}</span><span class="tx">{{ q.name }}</span>
            </button>
          </div>
        </div>
      </div>

      <div class="d-floors" v-if="project.floors.length > 1">
        <button v-for="(f, i) in project.floors" :key="f.id" :class="{active: i === floorIdx}" @click="selectFloor(i)">{{ f.name }}</button>
      </div>

      <div class="d-tools">
        <button :class="{on: autoRotate}" @click="toggleRotate">⟳ 自动旋转</button>
        <button :class="{on: showLabels}" @click="toggleLabels">🏷 标签</button>
        <button @click="resetAnchor" title="长按画面可自定义旋转锚点；点此重置回房屋中心">◎ 重置锚点</button>
        <button @click="fullscreen">⛶ 全屏</button>
      </div>

      <div class="d-status" :class="{on: haStatus.status === 'connected'}">
        <span class="dot"></span>
        {{ statusText }}
      </div>

      <div class="d-toast" v-if="toast">{{ toast }}</div>
    </div>

    <div class="d-empty" v-else>
      <div style="font-size:40px">🏠</div>
      <div>还没有户型数据</div>
      <div style="opacity:.7;font-size:13px">请先到编辑器绘制户型并保存</div>
      <a href="/">→ 打开编辑器</a>
    </div>
  </div>
</template>

<script>
/*
 * DisplayApp — 展示大屏（独立页面，复用 ha.js / catalog.js / plugins.js / view3d.js 共享模块）
 * 长时间展示全屋状态: 3D 场景 + 实时数据 HUD + 自动旋转 + 断线自动重连
 * 由 main-display.js 通过 createApp(DisplayApp).mount('#app') 挂载。
 * 共享模块 HA / HUD / View3D / PluginEngine / loadCatalog / fetchProject / buildDefaultProject
 * 等均为 public/js 中挂载到 window 的全局变量，此处直接引用，不另行 import。
 */

/* ---- 大屏视图状态层（统一按楼层 id 读写）----
   楼层自带稳定 id（catalog.js 的 newFloor → uid()）：取景记忆、旋转锚点、
   服务端 settings.anchors 一律用 floorKey(f) = 楼层 id，不再另起索引键。
   读写收敛成三层，避免同一个状态散落在多条写路径里：
     · 本地层 localGet / localSet：localStorage 统一带异常保护（隐私模式 / 坏 JSON 不崩）
     · 权威层 settings.anchors：GET /api/project 下发，PUT /api/anchor 局部更新
     · 兜底顺序：服务端 → 本地 → 默认房屋中心
   取景记忆的高度存「相对房屋基准面」的量（y − houseY）：恢复时加回当前 houseY，
   背景换成山顶/低洼、houseY 变了，旧机位仍能与房屋保持原构图。旧版按索引命名的
   键不再读写（残留由使用者自行在 DevTools 清理）。 */
const CAM_PREFIX = 'ha3d.displayCam.';
const ANCHOR_PREFIX = 'ha3d.displayAnchor.';
const DEF_CAM = { dir: [6, 12, 9], dist: Math.hypot(6, 12, 9) };   // 相对房屋中心的默认机位

let anchorKeys = [];                                // 楼层索引 → 稳定 id（init 里赋值）
let serverAnchors = {};                             // 服务端下发的 settings.anchors
let currentProject = null;                          // 供「房屋中心」离线现算（不依赖 WebGL）
/* 索引越界 / 项目未就绪时退化成索引字符串，保证键名永远不为空 */
const floorKey = (f) => anchorKeys[f] || String(f);
const camKey = (f) => CAM_PREFIX + floorKey(f);
const anchorKey = (f) => ANCHOR_PREFIX + floorKey(f);

const finiteNum = (n) => typeof n === 'number' && isFinite(n);
const validAnchor = (s) => !!(s && typeof s === 'object' && (
  s.mode === 'center' || (s.mode === 'custom' && finiteNum(s.x) && finiteNum(s.y) && finiteNum(s.z))));

function localGet(key) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }        // localStorage 被禁 / 数据损坏
}
function localSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

let camSaveTimer = null, camSaveFirst = 0;
let camFloor = 0;                                   // 当前归属楼层（索引，落盘时经 floorKey 换成 id）
let camUserDriving = false;                         // OrbitControls 的 start/end 之间才是用户操作

/* change 事件在自动旋转时每帧都触发：只保存用户真实拖动/缩放产生的那批，
   自转造成的机位变化不落盘（旧代码用 autoRotate 一刀切，默认开着自转 →
   用户手动调整反而永远不保存）。防抖回调把楼层 key 快照进闭包：
   A 层拖动后 400ms 内切到 B 层，仍写回 A 层而不是串到 B。 */
function scheduleSaveCam() {
  if (!camUserDriving) return;
  const key = camKey(camFloor);
  const now = Date.now();
  if (!camSaveFirst) camSaveFirst = now;
  if (camSaveTimer) clearTimeout(camSaveTimer);
  if (now - camSaveFirst >= 2000) { camSaveFirst = 0; saveCam(key); return; }
  camSaveTimer = setTimeout(() => { camSaveFirst = 0; saveCam(key); }, 400);
}
function saveCam(targetKey) {
  try {
    const p = View3D.camera.position, H = View3D.houseY || 0;
    const r = (n) => Math.round(n * 100) / 100;
    localSet(targetKey || camKey(camFloor), { pos: [r(p.x), r(p.y - H), r(p.z)] });
  } catch (e) { /* ignore */ }
}
function applyCam(s) {
  /* y 是「相对房屋基准面」的量，恢复时加回当前 houseY 即可。
   * 旧代码写成 +(H_now − H_save) 把基准面重复减了一次：只要 houseY≠0（山顶背景），
   * 刷新后相机就会整体下沉 H。target 由 applyAnchor 统一设置，这里不碰。 */
  const H = View3D.houseY || 0;
  View3D.camera.position.set(s.pos[0], s.pos[1] + H, s.pos[2]);
  View3D.controls.update();
}
/* 恢复指定楼层的取景记忆（该楼层无记忆时用默认机位） */
function restoreCam(f) {
  const s = localGet(camKey(f));
  if (s && Array.isArray(s.pos) && s.pos.length === 3 && s.pos.every(finiteNum)) {
    applyCam(s); return true;
  }
  return false;
}

/* ---- 旋转锚点（按楼层 id）：锚点 = 自动旋转 / 轨道所绕的 x,y,z 空间坐标。
   权威数据在服务端 project.json 的 settings.anchors：GET /api/project 随项目一起下发，
   PUT /api/anchor 局部更新；刷新 / 换设备 / 换浏览器都一致，不依赖本机缓存。
   localStorage 只作离线兜底，服务端该楼层没有记录时才会用到；键与服务端同为
   floorKey(f)（楼层 id），不再按前端索引另起一套。
     · 默认 = 房屋中心（View3D.center 实时算，不写死坐标），记为 mode:'center'；
     · 长按 3D 画面 → mode:'custom' + x,y,z（y 存相对 houseY 的量）；
     · 重置 → mode:'center'，刷新后仍是房屋中心。 ---- */
let anchorResetting = false;                        // 重置按钮走「记默认」而不是「记坐标」

function writeAnchorLocal(f, s) { localSet(anchorKey(f), s); }
/* 写服务端：串行发送，避免连续长按 / 重置时旧请求后到把新值覆盖。
   失败静默降级 —— 本地已同步写过，服务端短暂不可用时仍记得住。 */
let anchorWriteSeq = Promise.resolve();
function putAnchorServer(key, s) {
  const payload = Object.assign({ floor: key }, s);
  anchorWriteSeq = anchorWriteSeq.catch(() => {}).then(() => fetch('/api/anchor', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })).then((r) => r.ok ? r.json() : null)
    .then((d) => { if (d && d.anchors) serverAnchors = d.anchors; })
    .catch(() => {});
}
/* 服务端优先，本地兜底；服务端数据坏了（不是对象）也当没有，继续走兜底 */
function anchorTable() {
  return (serverAnchors && typeof serverAnchors === 'object' && !Array.isArray(serverAnchors)) ? serverAnchors : {};
}
function readAnchor(f) {
  const table = anchorTable(), key = floorKey(f);
  /* hasOwnProperty：别让 constructor / __proto__ 从原型链上取到奇怪的值 */
  if (Object.prototype.hasOwnProperty.call(table, key) && validAnchor(table[key])) return table[key];
  const s = localGet(anchorKey(f));
  return validAnchor(s) ? s : null;
}
/* 长按 / 重置统一入口（View3D.onAnchor 指向它）：相机与锚点一起落盘 */
function onAnchorChanged() {
  saveCam();
  const t = View3D.controls.target, H = View3D.houseY || 0;
  const r = (n) => Math.round(n * 100) / 100;
  const s = anchorResetting ? { mode: 'center' }
    : { mode: 'custom', x: r(t.x), y: r(t.y - H), z: r(t.z) };
  writeAnchorLocal(camFloor, s);
  putAnchorServer(floorKey(camFloor), s);
}
/* 默认锚点 = 房屋中心。优先用引擎算好的 View3D.center；WebGL 不可用 / build 未跑成功时
   center 可能不存在，就从当前楼层墙体包围盒现算，保证「服务端没存、前端也没存」时
   一定落回房屋中心，而不是场景原点 (0,0,0)。返回普通 {x,y,z}，不依赖 THREE。 */
function defaultAnchor(f) {
  const v3 = (typeof View3D !== 'undefined') ? View3D : null;
  const c = v3 && v3.center;
  if (c && finiteNum(c.x) && finiteNum(c.y) && finiteNum(c.z)) return { x: c.x, y: c.y, z: c.z };
  const H = (v3 && v3.houseY) || 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const floors = (currentProject && Array.isArray(currentProject.floors)) ? currentProject.floors : [];
  const fl = floors[f] || null;
  ((fl && Array.isArray(fl.walls)) ? fl.walls : []).forEach((w) => {
    if (!w || !finiteNum(w.x1) || !finiteNum(w.x2) || !finiteNum(w.y1) || !finiteNum(w.y2)) return;
    minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
  });
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 8; maxY = 8; }   // 空户型 / 项目未加载
  return { x: (minX + maxX) / 2, y: H + 1, z: (minY + maxY) / 2 };
}

/* 恢复锚点。必须在 rebuild / frame / 背景重放之后调用 —— 它们都会改 controls.target
   或 houseY，之后再覆盖成记住的锚点才是最终生效值。
   三级兜底：服务端 settings.anchors → 前端 localStorage → 默认房屋中心。
   任何一环异常都必须静默退化到房屋中心，绝不能让大屏页初始化崩掉。 */
function applyAnchor(f) {
  const key = floorKey(f);
  const v3 = (typeof View3D !== 'undefined') ? View3D : null;
  const H = (v3 && v3.houseY) || 0;
  let s = null;
  try { s = readAnchor(f); } catch (e) { s = null; }   // 本地数据损坏 → 走默认锚点

  try {
    if (s && s.mode === 'custom' && validAnchor(s)) {
      v3.controls.target.set(s.x, s.y + H, s.z);
      /* 服务端还没有这份记录（之前离线写入）→ 上报一次，其它设备也能同步到。
       * 只认独立锚点键：取景记忆里的相机 target 绝不是锚点，绝不拿来上报，
       * 否则每次刷新都可能把随手调的观看角度固化成自定义锚点且不可自愈。 */
      if (!validAnchor(anchorTable()[key])) putAnchorServer(key, s);
    } else {
      /* 服务端没存、前端没存、或两者都坏了：显式回到房屋中心，默认锚点一定生效 */
      v3.controls.target.copy(defaultAnchor(f));
    }
    if (v3.controls && typeof v3.controls.update === 'function') v3.controls.update();
  } catch (e) { /* WebGL / controls 不可用：不抛错，页面其它部分照常工作 */ }
}

export default {
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
    /* 已放置设备中开启数量（口径与 2D/3D 一致：插件 isOn(obj,get)，未声明回退通用规则） */
    onCount() {
      void this.entVersion;
      let on = 0;
      if (!this.cur) return 0;
      this.cur.devices.forEach((d) => { if (HA.deviceIsOn(d)) on++; });
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
            /* 快捷设备不在户型里、没有造型，按域取默认插件的 isOn（音箱 playing / 扫地机 cleaning 也算开） */
            on: HA.entityIsOn(eid, dom),
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
    /* 由 mounted 在 Vue 挂载完成后调用；12s 兜底防止脚本异常时卡死在启动图 */
    bootDone() {
      const b = document.getElementById('boot');
      if (!b) return;
      b.style.opacity = '0';
      b.style.pointerEvents = 'none';
      setTimeout(() => { b.remove(); }, 260);
    },

    async init() {
      await loadCatalog();   // 目录先于项目加载（家具形态解析需要）
      // 加载项目（编辑器保存的户型）；无保存数据时回退示例户型（fetchProject 在 catalog.js）
      this.project = await fetchProject() || buildDefaultProject();
      /* 旋转锚点：服务端数据 settings.anchors 随项目一起下发，按楼层稳定 id 索引。
         在这里初始化一次，切层 / 重建都复用同一份表，不用再发请求。 */
      currentProject = this.project;
      const floors = (this.project && Array.isArray(this.project.floors)) ? this.project.floors : [];
      anchorKeys = floors.map((fl, i) => String((fl && fl.id) || i));
      const sa = this.project && this.project.settings && this.project.settings.anchors;
      serverAnchors = (sa && typeof sa === 'object' && !Array.isArray(sa)) ? sa : {};
      /* 标签页标题: 项目名称 · 大屏 */
      document.title = (this.project && this.project.name ? this.project.name : 'HA 3D Home') + ' · 大屏';

      // 楼层选择持久化: 多楼层时记住上次查看的楼层（单楼层无所谓，控件本身隐藏）
      try {
        const saved = parseInt(localStorage.getItem('ha3d.displayFloor'), 10);
        if (!isNaN(saved) && saved >= 0 && saved < this.project.floors.length) this.floorIdx = saved;
      } catch (e) { /* ignore */ }

      await PluginEngine.loadAll();   // 加载 assets/plugins 有状态模型插件（门窗/设备）
      this.entVersion++;              // 插件就绪 → 开关判定从默认规则切到插件 isOn，强制重算统计
      await this.$nextTick();
      View3D.init('stage');
      View3D.controls.autoRotate = this.autoRotate;
      View3D.controls.autoRotateSpeed = 0.6;
      if (this.project) {
        /* 背景参数 / 实体绑定必须在 rebuild 之前注入：build() 的构图指纹会读
         * bgOptions，晚注入会让首次重放拿到空参数（旧代码正是这个顺序漏洞）。 */
        PluginEngine.bgOptions = (this.project.settings && this.project.settings.backgroundOptions) || {};
        PluginEngine.bgFields = (this.project.settings && this.project.settings.backgroundFields) || {};
        const bgId = (this.project.settings && this.project.settings.background) || '';
        View3D.rebuild(this.project, this.floorIdx);   // 楼层模型 + 标签 + 渲染（统一入口）
        View3D.frame(DEF_CAM);   // 默认机位；自转锚点暂为房屋中心
        // 取景记忆（按楼层）：恢复当前楼层上次保存的机位；此后每次操作自动保存到所属楼层
        camFloor = this.floorIdx;
        restoreCam(this.floorIdx);
        /* OrbitControls 的 start/end 只在用户拖动/缩放时触发，自转不会触发：
           据此区分「用户调了机位」与「程序在转」，交互结束立刻落一次盘。 */
        View3D.controls.addEventListener('start', () => { camUserDriving = true; });
        View3D.controls.addEventListener('end', () => { camUserDriving = false; saveCam(); });
        View3D.controls.addEventListener('change', scheduleSaveCam);
        View3D.onAnchor = onAnchorChanged;   // 长按设锚点 / 重置锚点后立即持久化（仅大屏；编辑页不设此回调）
        View3D.setLabelsVisible(this.showLabels);   // 恢复标签开关状态（localStorage 持久化）
        // 背景插件（3D 地面模型，扁平/立体/动态）；未选择时保持大屏浅灰底 + 网格
        if (bgId && PluginEngine.applyBackground(bgId, View3D) === true) View3D.syncBgKey();
        /* 锚点最后恢复：applyBackground 可能改 houseY 并平移 target，rebuild/frame 也会把
         * target 设回房屋中心；只有放在它们之后，记住的 x,y,z 才是最终生效值。 */
        applyAnchor(this.floorIdx);
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
      // （rebuild 会把锚点重置回户型中心，所以机位与锚点恢复都必须放在它之后）
      camFloor = i;
      View3D.rebuild(this.project, i);
      if (!restoreCam(i)) View3D.frame(DEF_CAM);
      applyAnchor(i);   // 每层各自记住自己的锚点；未设置过的层回房屋中心
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

    /* 锚点重置回房屋中心（长按左键可自定义锚点；此按钮一键还原）。
       重置状态也要「记住」：写 mode:'center'，刷新后仍是房屋中心而不是旧坐标。 */
    resetAnchor() {
      anchorResetting = true;
      try { View3D.resetAnchor(); } finally { anchorResetting = false; }
      this.toastMsg('锚点已重置回房屋中心');
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

  mounted() {
    this.init();
    this.bootDone();
    // 12s 兜底：脚本异常时强制移除启动图，不卡死在加载界面
    setTimeout(() => this.bootDone(), 12000);
  },
};
</script>

<style>
  body { background: #eef1f4; }
  #stage { position: fixed; inset: 0; background: #fafbfd; }
  #stage canvas { display: block; }
  .d-hud { position: fixed; inset: 0; pointer-events: none; z-index: 10; }
  .d-top { position: absolute; left: 28px; top: 24px; color: #1f2733; }
  .d-title { font-size: 26px; font-weight: 700; display: flex; align-items: baseline; gap: 14px; }
  /* 版本号胶囊在大标题里垂直居中、字号回落，别跟着 26px 走 */
  .d-title .tb-ver { align-self: center; font-size: 12px; font-weight: 400; opacity: .75; }
  .d-edit { font-size: 12px; font-weight: 500; color: #2456c4; text-decoration: none; padding: 3px 8px; border-radius: 7px; background: transparent; border: 1px solid transparent; opacity: .75; pointer-events: auto; transition: all .15s; }
  .d-edit:hover { background: rgba(36,86,196,.08); color: #1b47a8; opacity: 1; }
  .d-temp { font-size: 26px; color: #e8842c; }
  .d-subs { margin-top: 8px; font-size: 13px; opacity: .7; display: flex; gap: 16px; }
  .d-panel { position: absolute; right: 28px; top: 24px; bottom: 70px; width: 212px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; padding: 2px; scrollbar-width: thin; pointer-events: none; }
  .d-panel::-webkit-scrollbar { width: 5px; }
  .d-panel::-webkit-scrollbar-thumb { background: #c3ccd9; border-radius: 3px; }
  /* 扁平卡片: 小圆角、无阴影、留白更薄 */
  .d-card { background: rgba(255,255,255,.78); backdrop-filter: blur(8px); border: 1px solid #e3e9f1; color: #1f2733; border-radius: 9px; padding: 9px 13px; min-width: 178px; max-width: 100%; box-shadow: none; }
  .d-card .k { font-size: 12px; opacity: .55; letter-spacing: .2px; }
  .d-card .v { font-size: 21px; font-weight: 700; }
  .d-card .v small { font-size: 12px; font-weight: 400; opacity: .6; }
  /* 设备概览: 单行数值 + 细进度条 */
  .ov-row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; }
  .ov-num { font-size: 18px; font-weight: 700; line-height: 1.1; }
  .ov-num small { font-size: 11px; font-weight: 400; opacity: .55; }
  .ov-bar { margin-top: 7px; height: 3px; border-radius: 2px; background: #e4e9f0; overflow: hidden; }
  .ov-bar i { display: block; height: 100%; background: #f6a723; border-radius: 2px; transition: width .35s ease; }
  .card-sec { pointer-events: auto; }
  /* 场景: 每行一个，行间留白 + 浅底区分，右侧执行按钮 */
  .sc-list { margin-top: 7px; max-height: 246px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; scrollbar-width: thin; }
  .sc-list::-webkit-scrollbar { width: 4px; }
  .sc-list::-webkit-scrollbar-thumb { background: #cfd6e0; border-radius: 3px; }
  .sc-item { display: flex; align-items: center; gap: 8px; padding: 6px 9px; border-radius: 7px; background: rgba(238,242,248,.9); transition: background .15s; }
  .sc-item:hover { background: #e6ecf7; }
  .sc-item .nm { flex: 1; min-width: 0; font-size: 12.5px; color: #2a3340; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sc-run { flex: none; width: 20px; height: 20px; border-radius: 50%; border: 1px solid #d6dfec; background: #fff; color: #2456c4; font-size: 9px; line-height: 1; display: flex; align-items: center; justify-content: center; padding: 0; transition: all .15s; }
  .sc-run:hover { background: #2456c4; border-color: #2456c4; color: #fff; }
  .sc-run:active { transform: scale(.92); }
  .sc-run.busy { background: #eef3fd; border-color: #b9cdf3; cursor: default; }
  .sc-run.ok { background: #22b866; border-color: #22b866; color: #fff; }
  .sc-run[disabled] { cursor: default; }
  .sc-run .spin { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid #c2d3f2; border-top-color: #2456c4; animation: scspin .55s linear infinite; }
  @keyframes scspin { to { transform: rotate(360deg); } }
  /* 底部轻提示（场景执行反馈） */
  .d-toast { position: absolute; left: 50%; bottom: 32px; transform: translateX(-50%); background: rgba(31,39,51,.9); color: #fff; font-size: 12.5px; padding: 8px 18px; border-radius: 999px; white-space: nowrap; animation: toastIn .18s ease-out; }
  @keyframes toastIn { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }
  /* 快捷设备: 两列等宽 */
  .q-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
  .btn-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .act-btn { display: flex; align-items: center; gap: 5px; background: #fff; border: 1px solid #dfe5ee; color: #1f2733; border-radius: 9px; padding: 6px 10px; font-size: 12px; max-width: 100%; text-align: left; transition: all .15s; }
  .act-btn:hover { background: #eef3fd; border-color: #c9d8f5; }
  .act-btn .ic { flex: none; }
  .q-grid .act-btn { width: 100%; min-width: 0; padding: 7px 9px; }
  .q-grid .act-btn .tx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act-btn.scene { background: #eaf0fe; border-color: #c9dafb; color: #2456c4; }
  .act-btn.scene:hover { background: #d9e6fd; }
  .act-btn.on { background: #f6a723; border-color: #f0b95c; color: #1c2333; font-weight: 600; }
  .d-left { position: absolute; left: 28px; top: 108px; display: flex; flex-direction: column; gap: 10px; max-height: 30vh; overflow-y: auto; pointer-events: none; scrollbar-width: thin; }
  .d-left::-webkit-scrollbar { width: 5px; }
  .d-left::-webkit-scrollbar-thumb { background: #c3ccd9; border-radius: 3px; }
  .d-floors { position: absolute; left: 28px; bottom: 64px; display: flex; flex-direction: column; gap: 9px; pointer-events: auto; }
  .d-floors button { background: rgba(255,255,255,.9); border: 1px solid #dfe5ee; color: #1f2733; border-radius: 11px; padding: 8px 16px; font-size: 13px; text-align: left; transition: background .2s; }
  .d-floors button.active { background: #1f2733; border-color: #1f2733; color: #fff; font-weight: 700; }
  .d-tools { position: absolute; right: 28px; bottom: 24px; display: flex; gap: 8px; pointer-events: auto; }
  .d-tools button { background: rgba(255,255,255,.9); border: 1px solid #dfe5ee; color: #1f2733; border-radius: 10px; padding: 8px 14px; font-size: 12px; }
  .d-tools button.on { background: #1f2733; border-color: #1f2733; color: #fff; font-weight: 600; }
  .d-status { position: absolute; left: 28px; bottom: 24px; color: #6b7686; font-size: 12px; display: flex; align-items: center; gap: 7px; }
  .d-status .dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa3b2; }
  .d-status.on .dot { background: #22b866; box-shadow: 0 0 8px #22b86688; }
  .d-empty { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 14px; color: #1f2733; }
  .d-empty a { color: #2456c4; }
  [v-cloak] { display: none; }
  /* 启动图: 覆盖 JS 未加载完成时可能闪现的 Vue 模板字符串；样式内联不依赖外部资源 */
  #boot { position: fixed; inset: 0; z-index: 9999; background: #f4f6fa; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; transition: opacity .25s; font-family: system-ui, sans-serif; }
  #boot .b-logo { font-size: 46px; filter: drop-shadow(0 4px 10px rgba(60,80,120,.18)); }
  #boot .b-name { font-size: 17px; font-weight: 700; color: #1f2733; letter-spacing: 1px; }
  #boot .b-spin { width: 30px; height: 30px; border: 3px solid #d7deea; border-top-color: #3b82f6; border-radius: 50%; animation: b-rot .8s linear infinite; }
  #boot .b-tip { font-size: 12px; color: #8a94a6; }
  @keyframes b-rot { to { transform: rotate(360deg); } }
</style>
