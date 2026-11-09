/*
 * app.js — Vue 3 应用: 界面状态与交互（Canvas 编辑器 / Three.js 3D / HA 客户端保持独立模块）
 */
'use strict';

const { createApp } = Vue;

const AppComponent = {
  data() {
    return {
      project: { name: '我的家', floors: [], settings: newSettings() },
      floorIdx: 0,
      mode: '2d',
      showLabels: true,   // 3D 设备标签显示开关
      tool: 'select',
      selection: null,          // {kind, id}
      savedState: '已保存',
      houseW: 0, houseD: 0,     // 本层户型长宽（米）——2D 徽标显示，跟随当前楼层（切层即刷新）
      entVersion: 0,            // HA 实体变化版本号（触发计算属性）
      histVer: 0,               // 历史栈版本号（撤销/重做按钮置灰态的触发器）
      haStatus: { status: 'connecting' },

      furnOpen: false,
      devOpen: false,
      ghostFurn: null,          // 待放置家具的形态 id（catalog item.id，不是 type）
      furnCat: null,            // 家具库当前类别（null=全部）

      devSearch: '',
      devFilter: 'all',
      tabsFadeL: false,         // 分类页签左侧还有内容（渐隐提示）
      tabsFadeR: false,         // 右侧还有内容

      connOpen: false,
      inHaUrl: '',
      inToken: '',
      connMsg: '',
      connMsgOk: false,

      /* 导入插件（zip 上传：拖拽或点选，选好后自动上传） */
      importOpen: false,
      importDrag: false,
      importing: false,
      importFile: null,
      importMsg: '',
      importMsgOk: true,
      /* 安装密钥：studio 发布插件时要在设置里填同一个值。
       * keyValue 只在「刚生成」的这一次会话里拿得到（生成接口的响应），刷新后
       * 页面只显示末 4 位 —— 明文始终可以从服务端 data/install-key.json 取回。 */
      keyTail: '',
      keyLocked: false,
      keyValue: '',
      keyBusy: false,
      keyCopied: false,

      dispOpen: false,      // 展示大屏配置弹窗
      quickInput: '',       // 快捷设备搜索输入

      bgOpen: false,        // 贴图（参考底图）菜单
      backdropOpen: false,  // 背景插件面板（3D 地面背景：扁平/立体、静态/动态）
      bgTick: 0,            // 背景参数变更计数器（驱动 bgOptionList 重算）
      bgW: 10,              // 贴图宽度（米，滑块双向绑定）
      bgInfo: { has: false, hidden: false },

      resetOpen: false,     // 重置本层确认弹窗
      resetText: '',

      zoomPct: 100,
      tooltipMsg: '',
      tooltipShow: false,
      tooltipStyle: {},
    };
  },

  computed: {
    cur() { return this.project ? this.project.floors[this.floorIdx] : null; },
    /* 数据卡列表（按楼层独立；动态数量，至少显示一行空行便于添加） */
    dataCardRows() {
      const c = (this.cur && this.cur.display && this.cur.display.dataCards) || [];
      return c.length ? c : [''];
    },
    furnitureList() { void this.entVersion; return allFurniture(); },
    /* 家具分类页签（catalog.js 派生: 全部 → 各固定类型 → 其他） */
    furnTabs() {
      void this.entVersion;
      return furnitureTabs();
    },
    /* 当前类型下的家具形态（null=全部; 'other'=其他，含历史数据里枚举外的野值） */
    furnListByCat() {
      void this.entVersion;
      const all = allFurniture();
      if (!this.furnCat) return all;
      if (this.furnCat === 'other') return all.filter((f) => isOtherFurnType(f.type));
      return all.filter((f) => f.type === this.furnCat);
    },
    /* 背景插件（按插件分组；面板只显示 icon + 文案，不做实时预览） */
    bgGroups() {
      void this.entVersion;
      return (window.PluginEngine && PluginEngine.ready) ? PluginEngine.backgroundGroups() : [];
    },
    /* 当前背景（项目设置里的聚合 id，如 'background:grass'；空=默认纯色+网格） */
    bgStyle() {
      return (this.project && this.project.settings && this.project.settings.background) || '';
    },
    /* 当前背景的元信息（未选中对象时右侧面板标题用） */
    bgMeta() {
      void this.entVersion;
      void this.bgTick;
      if (!this.bgStyle || !window.PluginEngine || !PluginEngine.ready) return null;
      const b = PluginEngine.backgroundOf(this.bgStyle);
      if (!b) return null;
      return { name: b.name, icon: b.icon, plugin: b.group, hz: b.hz || 0 };
    },
    /* 当前背景可配置参数（插件声明 options schema，值 = 默认值 ∪ 已保存值） */
    bgOptionList() {
      void this.entVersion;
      void this.bgTick;
      if (!this.bgStyle || !window.PluginEngine || !PluginEngine.ready) return [];
      const schema = PluginEngine.normalizeOptions(PluginEngine.optionsSchema(this.bgStyle));
      if (!schema.length) return [];
      const saved = (PluginEngine.bgOptions && PluginEngine.bgOptions[this.bgStyle]) || {};
      return schema.map((o) => Object.assign({}, o, {
        value: saved[o.key] != null && saved[o.key] !== '' ? saved[o.key] : o.def,
      }));
    },
    /* 当前背景的「动态实体字段」绑定区（def.fields 声明；值存 settings.backgroundFields）。
     * 与 bgOptionList 的静态手工参数分开：这里的实体状态变化会回调插件顶层 onData(fields, api)。
     * 绑定按**插件**共用一份：同一插件下切换具体样式不会丢失已绑实体。 */
    bgFieldList() {
      void this.entVersion;   // 插件异步加载完成后重算（loadAll 完成时会 entVersion++）
      void this.bgTick;
      if (!this.bgStyle || !window.PluginEngine || !PluginEngine.ready) return [];
      const bd = PluginEngine.backgroundOf(this.bgStyle);
      if (!bd || !Array.isArray(bd.fields) || !bd.fields.length) return [];
      const saved = PluginEngine.bgBindings(this.bgStyle);
      return bd.fields.filter((f) => f && f.key).map((f) => Object.assign({}, f, {
        value: saved[f.key] || '',
      }));
    },
    /* 选中项标题（家具从目录形态解析；设备名跟随 HA，门窗跟随插件样式名） */
    selName() {
      const it = this.selItem;
      if (!it || !this.selection) return '';
      void this.entVersion;   // HA 改名 / 插件加载完成后重算
      return itemDisplayName(this.selection.kind, it);
    },
    /* 选中家具的固定类型（目录解析，枚举外的历史野值已归一成 other） */
    furnType() {
      const it = this.selItem;
      if (!it || !this.selection || this.selection.kind !== 'furniture') return '';
      return furnSpec(it).type;
    },
    /* 选中家具有没有可用模型：目录与实例都没给地址时，面板才露出「模型地址」手填行 */
    selHasModel() {
      const it = this.selItem;
      if (!it || !this.selection || this.selection.kind !== 'furniture') return true;
      return !!(it.model || furnSpec(it).model);
    },
    /* 选中家具的同类模型（右侧切换，按固定类型聚合） */
    sameModels() {
      void this.entVersion;
      const it = this.selItem;
      if (!it || this.selection.kind !== 'furniture') return [];
      const t = furnSpec(it).type;
      if (!t) return [];
      /* 「其他」把野值一起收进来（归一后它们都显示为 other） */
      return allFurniture().filter((f) => (t === 'other' ? isOtherFurnType(f.type) : f.type === t));
    },
    /* 选中对象的插件样式列表（右侧切换）: 设备按 type 聚合，门窗按插件 styles 聚合 */
    selStyleList() {
      const it = this.selItem;
      if (!it) return [];
      const k = this.selection.kind;
      if (k === 'device') return deviceStyles(devTypeOf(it)) || [];
      if (k === 'door' || k === 'window') {
        void this.entVersion;   // 插件异步加载完成后重算
        if (!window.PluginEngine || !PluginEngine.ready) return [];
        return PluginEngine.styles(k) || [];
      }
      return [];
    },
    selStyleId() {
      const it = this.selItem;
      if (!it) return '';
      if (this.selection.kind === 'device') {
        const s = deviceStyleDef(it, devTypeOf(it));
        return s ? s.id : '';
      }
      const list = this.selStyleList;
      const s = (it.style && list.find((x) => x.id === it.style)) || list[0];
      return s ? s.id : '';
    },
    selStyleDesc() {
      const s = this.selStyleList.find((x) => x.id === this.selStyleId);
      return s && s.desc ? s.desc : '';
    },
    /* 样式区标题: 设备按类型取名（灯体样式/设备造型），门窗用 kindName */
    selStyleTitle() {
      return this.selection.kind === 'device'
        ? (this.devIsLight ? '灯体样式' : '设备造型')
        : this.kindName + '样式';
    },
    devIsLight() {
      const it = this.selItem;
      if (!it || this.selection.kind !== 'device') return false;
      return devTypeOf(it) === 'light';
    },
    devStyleName() {
      const it = this.selItem;
      if (!it || this.selection.kind !== 'device') return '';
      const type = devTypeOf(it);
      const s = deviceStyleDef(it, type);
      return s ? s.name : '';
    },
    /* 标签抬升高度的造型默认值（styles[].labelOffset，缺省 0.3m） */
    labelOffsetDefault() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it) return 0.3;
      if (k !== 'device' && k !== 'door' && k !== 'window') return 0.3;
      const type = k === 'device' ? devTypeOf(it) : k;
      return window.PluginEngine ? PluginEngine.labelOffset(type, it.style) : 0.3;
    },
    /* 面板显示值：实例覆盖 obj.labelOffset 优先，没设过就显示造型默认值 */
    labelOffsetVal() {
      const it = this.selItem;
      return it && it.labelOffset != null ? it.labelOffset : this.labelOffsetDefault;
    },
    /* 当前样式的条目参数（样式条目声明 options schema，值 = 默认值 ∪ 实例已存值 obj.styleOpts）。
     * 引擎对设备/门窗一视同仁（ctx.options 注入），设备样式声明了 options 也能在这里配 */
    selOptList() {
      void this.entVersion;
      const k = this.selection && this.selection.kind;
      if (k !== 'device' && k !== 'door' && k !== 'window') return [];
      const it = this.selItem;
      if (!it) return [];
      const s = this.selStyleList.find((x) => x.id === this.selStyleId);
      const schema = PluginEngine.normalizeOptions((s && s.options) || []);
      if (!schema.length) return [];
      const saved = it.styleOpts || {};
      return schema.map((o) => Object.assign({}, o, {
        value: saved[o.key] != null && saved[o.key] !== '' ? saved[o.key] : o.def,
      }));
    },
    /* 选中对象的插件绑定字段（设备/门窗同一套: 按当前样式所属**插件**取 fields 声明；
     * 切到没有 fields 的插件样式（如自定义台灯/固定窗）本区自动隐藏）
     * ⚠ 绑定值存在实例 obj[key] 上（不是按 style 分桶），同一插件下切换多个样式
     *   共用同一份绑定 —— 灯换个灯体造型不会丢已绑的功率/色温实体。
     *   序列化时 catalog.copyFields 用所有插件 fields 的并集做白名单，切样式/存档都不丢。 */
    selFields() {
      const k = this.selection.kind;
      if (k !== 'device' && k !== 'door' && k !== 'window') return [];
      if (!window.PluginEngine) return [];
      void this.entVersion;   // 插件异步加载完成后重算
      const it = this.selItem;
      const kindOrType = k === 'device' ? devTypeOf(it) : k;
      const def = PluginEngine.defFor(kindOrType, it && it.style);
      return def ? PluginEngine.fieldsOf(def) : [];
    },
    /* 实体绑定区的说明文案（设备/门窗各一句） */
    selFieldsTip() {
      return this.selection.kind === 'device'
        ? '除主实体外，插件还可挂功率/温湿度/人体/曲目等实体，用来丰富模型屏幕与标签的数据'
        : '绑定实体后由插件按状态驱动模型（如门磁 on=开门动画）';
    },

    /* 点击控制规格（插件声明优先，否则内置默认；null = 不支持点击）。
     * 设备与门/窗同一套：门/窗的 type 就是 'door'/'window'（实例数据没有 type 字段，按选中种类传） */
    devClickSpec() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it || !window.PluginEngine) return null;
      if (k !== 'device' && k !== 'door' && k !== 'window') return null;
      return PluginEngine.clickSpec(k === 'device' ? devTypeOf(it) : k, it.style);
    },
    /* 复选框状态: 实例显式设置优先，未设置时跟随插件的 defaultOn。
     * 门窗已并入设备、同一规则：插件声明了 click 的门窗默认勾选，
     * 没声明的没有 spec、默认不勾选（即旧的「门窗默认不可点」效果改由插件声明驱动） */
    devClickOn() {
      const it = this.selItem;
      if (!it) return false;
      if (it.click === true || it.click === false) return it.click;
      const spec = this.devClickSpec;
      return !!(spec && spec.defaultOn);
    },
    devClickText() {
      const spec = this.devClickSpec;
      if (!spec) return '';
      /* on/off 为插件自定义函数时显示「自定义动作」（服务名拿不到） */
      const name = (v) => (typeof v === 'function' ? '自定义动作' : v);
      const a = name(spec.on), b = name(spec.off);
      return spec.label + '（' + (a === b ? a : a + ' / ' + b) + '）';
    },
    /* 「点击动作」下拉选项：全局拉平一张表（不按设备域分流，绝对自由选）；
     * 实例选中的值存 it.clickSvc = on 服务名，发服务的域由绑定实体前缀决定 */
    devClickSvcOpts() {
      if (!window.PluginEngine) return [];
      return PluginEngine.clickServiceOptions();
    },

    /* 展示大屏展示项配置数据 */
    dispScenes() {
      void this.entVersion;
      return HA.all()
        .filter((s) => /^scene\./.test(s.entity_id))
        .map((s) => ({ eid: s.entity_id, name: HA.friendly(s.entity_id) }));
    },
    /* 快捷设备列表（当前楼层 display.quickDevices，含任意 HA 实体，不限户型内） */
    quickList() {
      void this.entVersion;
      return ((this.cur && this.cur.display && this.cur.display.quickDevices) || [])
        .map((eid) => ({ eid, name: HA.friendly(eid) || eid }));
    },
    dispCountText() {
      const d = (this.cur && this.cur.display) || {};
      return ((d.displayScenes || []).length) + ' 个场景 · ' + ((d.quickDevices || []).length) + ' 个设备';
    },
    selItem() {
      if (!this.selection || !this.cur) return null;
      const map = { wall: 'walls', door: 'doors', window: 'windows', furniture: 'furniture', device: 'devices' };
      const arr = this.cur[map[this.selection.kind]];
      return arr ? arr.find((x) => x.id === this.selection.id) || null : null;
    },
    kindName() {
      return this.selection ? ({ wall: '墙体', door: '门', window: '窗', furniture: '家具', device: '设备' })[this.selection.kind] : '';
    },
    devState() {
      void this.entVersion;
      const it = this.selItem;
      if (!it || !it.entityId) return '';
      const st = HA.getState(it.entityId);
      if (!st) return '';
      return st.state + HA.unitOf(st);
    },

    /* 设备面板分类页签: 完全由 catalog.js 的 DEVICE_TYPES 派生（新增类型不用改 UI）。
     * 零计数的分类默认隐藏（全部/其他/已添加常驻），当前选中的那一项始终保留，
     * 避免数据变化时选中的按钮凭空消失。 */
    devTabs() {
      const c = this.devData.counts || {};
      const keep = { all: 1, other: 1, placed: 1 };
      return deviceTabs().filter((t) => keep[t.key] || (c[t.key] || 0) > 0 || this.devFilter === t.key);
    },

    /* 设备面板数据 */
    devData() {
      void this.entVersion;
      const counts = { all: HA.all().length };
      Object.keys(DEVICE_TYPES).forEach((k) => { counts[k] = 0; });
      const q = this.devSearch.toLowerCase();
      const f = this.devFilter;
      const list = [];
      HA.all().forEach((s) => {
        const eid = s.entity_id;
        const type = deviceTypeOf(eid);
        counts[type] = (counts[type] || 0) + 1;
        // 分类过滤: all 显示全部；placed 只显示已放置点位；其余按 type 精确匹配
        if (f !== 'all') {
          if (f === 'placed') return;
          if (type !== f) return;
        }
        const name = HA.friendly(eid);
        if (q && !(eid.toLowerCase().includes(q) || name.toLowerCase().includes(q) || (s.state || '').toLowerCase().includes(q))) return;
        const unit = HA.unitOf(s);
        /* 状态文案与"已开启"判定都问插件（与 3D 标签同一套规则），不在 UI 里按 type 写分支 */
        const txt = window.PluginEngine ? PluginEngine.labelOf(type, s) : '';
        list.push({
          eid, name, type,
          on: HA.entityIsOn(eid, type),
          stateText: txt || (s.state === 'on' ? '已开启' : s.state === 'off' ? '已关闭' : s.state + unit),
        });
      });
      const placed = [];
      if (this.project) {
        this.project.floors.forEach((fl, fi) => fl.devices.forEach((d) => {
          // "已添加"分类: 支持按名称/实体/楼层过滤（设备名实时由 HA 解析，实例不存 name）
          const hay = (HA.friendly(d.entityId) + ' ' + (d.name || '') + ' ' + (d.entityId || '') + ' ' + fl.name).toLowerCase();
          if (q && !hay.includes(q)) return;
          placed.push({ fl: fl.name, fi, d, name: itemDisplayName('device', d) });
        }));
        counts.placed = placed.length;
      }
      // 已放置点位只在"已添加"分类显示，其余 tab 只看实体列表
      if (this.devFilter === 'placed') return { counts, list: [], placed };
      return { counts, list: list.slice(0, 120), placed: [] };
    },

    /* 连接状态 */
    connClass() {
      const s = this.haStatus.status;
      return { on: s === 'connected', err: s === 'demo' || s === 'error' || s === 'disconnected' };
    },
    connText() {
      const s = this.haStatus.status;
      if (s === 'connected') return 'HA 已连接';
      if (s === 'demo') return '演示模式';
      if (s === 'connecting') return '连接中…';
      if (s === 'error') return this.haStatus.message || '连接失败';
      return '未连接';
    },
    connStateText() {
      const s = this.haStatus.status;
      if (s === 'connected') return '已连接 · 设备状态正在实时同步';
      if (s === 'demo') return '演示模式（未配置 Home Assistant）';
      if (s === 'connecting') return '正在连接…';
      return this.haStatus.message || '未连接';
    },
    haUrlText() { return HA.url || '未配置'; },
    entityCount() { void this.entVersion; return HA.all().length; },

    /* HUD（纯函数在共享模块 hud.js，编辑页与大屏同一套实现） */
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
  },

  methods: {
    /* ------- 设备分类页签（单行横向滚动） ------- */
    onTabsScroll() { this.updateTabsEdge(); },
    /* 鼠标滚轮在页签条上 → 横向滚动（触控板横向滑动同样支持） */
    onTabsWheel(e) {
      const box = this.$refs.devTabsBox;
      if (!box) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      box.scrollLeft += delta;
      this.updateTabsEdge();
    },
    /* 两端渐隐提示: 只有该侧确实还有被裁掉的内容时才显示 */
    updateTabsEdge() {
      const box = this.$refs.devTabsBox;
      if (!box || !box.clientWidth) return;
      const max = box.scrollWidth - box.clientWidth;
      this.tabsFadeL = box.scrollLeft > 2;
      this.tabsFadeR = max > 2 && box.scrollLeft < max - 2;
    },
    /* 选中的分类滚动到可视区中部（切换分类、数据变化、面板打开时调用） */
    scrollTabsToActive() {
      const box = this.$refs.devTabsBox;
      if (!box || !box.clientWidth) return;
      const el = box.querySelector('button.active');
      if (el) {
        const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
        const target = r.left - b.left + box.scrollLeft - (box.clientWidth - r.width) / 2;
        box.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
      }
      this.updateTabsEdge();
    },
    /* 切换分类/搜索后实体列表重刷 → 回到顶部 */
    resetDevListScroll() {
      const list = this.$refs.devListBox;
      if (list) list.scrollTop = 0;
    },

    /* ------- 初始化 ------- */
    async init() {
      await loadCatalog();   // 目录先于项目加载（示例户型需要按形态 id 引用家具）
      this.entVersion++;   // CATALOG 非响应式: 加载完成手动触发依赖它的计算属性（家具列表/页签）重算
      await this.loadProject();
      await PluginEngine.loadAll();   // 加载 assets/plugins 有状态模型插件
      this.entVersion++;   // 同理: 插件注册完成后再触发一次（背景分组/设备造型等）
      await this.$nextTick();

      Editor.init(document.getElementById('c2d'));
      Editor.onChange = (light, label) => { this.dirty(label || (light ? 'drag' : 'edit')); };
      Editor.onViewChange = () => this.viewDirty();   // 平移/缩放也进撤销栈（见 recode.js pushView）
      this.setFloor();
      if (typeof Recode !== 'undefined') Recode.setBaseView(Editor.viewState());   // 初始快照也记视图
      View3D.init('c3dWrap');
      View3D.frame({ dir: [9, 10, 11], dist: Math.hypot(9, 10, 11), target: [0, 0, 0] });   // 编辑器取景由 app 自己控制（= 原默认视角）
      this.applyBg();   // 恢复项目里保存的背景插件地面（空则默认纯色 + 网格）

      // 关闭页面前确保已保存
      window.addEventListener('beforeunload', () => {
        if (this.savedState !== '已保存' && this.project && navigator.sendBeacon) {
          /* 与手动保存 / autoSave 走同一份 serializeProject 快照：原始 this.project
           * 可能带着过期的 anchors 等运行期字段，整份提交会干扰服务端 disk 优先的合并。 */
          navigator.sendBeacon('/api/project',
            new Blob([JSON.stringify(serializeProject(this.project))], { type: 'application/json' }));
        }
      });

      await HA.loadConfig();
      this.inHaUrl = HA.url;
      this.inToken = HA.token;
      HA.on('change', () => this.onHAChange());
      HA.on('status', (s) => { this.haStatus = s; });
      HA.connect();

      View3D.startLoop();
      this.bindKeys();

      // 支持 ?view=3d 直达 3D 视图
      const q = new URLSearchParams(location.search);
      if (q.get('view') === '3d') this.setMode('3d');

      // 点画布关闭悬浮面板
      document.getElementById('c2d').addEventListener('mousedown', () => {
        if (this.tool === 'select') { this.furnOpen = false; this.devOpen = false; }
      });
    },

    async loadProject() {
      this.project = await fetchProject() || buildDefaultProject();
      Recode.init(this.project, this.floorIdx);   // 撤销栈以载入的项目为初始态
      this.applyTitle();
      this.updateHouseSize();
    },

    /* 本层户型长宽（米）：2D 画布右上角徽标（跟随当前楼层，切层/改墙即刷新）。
     * studio 背景占位盒参考的是「各层最大尺寸」（保存时落盘 houseW/houseD），不再看这个徽标 */
    updateHouseSize() {
      const fp = (typeof floorFootprint === 'function') ? floorFootprint(this.cur) : null;
      this.houseW = fp ? Math.round(fp.w * 10) / 10 : 0;
      this.houseD = fp ? Math.round(fp.d * 10) / 10 : 0;
    },

    /* 浏览器标签页标题: 项目名称 · 编辑（名称改动/撤销重做后由 watch 同步） */
    applyTitle() { document.title = (this.project && this.project.name ? this.project.name : 'HA 3D Home') + ' · 编辑'; },

    async saveProject() {
      clearTimeout(this._saveTimer);
      const body = serializeProject(this.project);   // 自上而下重建，旧字段不入库
      if (!body) { this.toast('项目为空，无需保存'); return; }
      try {
        await fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        this.savedState = '已保存';
        this.toast('项目已保存');
      } catch (e) { this.toast('保存失败: ' + e.message); }
    },
    dirty(label) {
      // 快照式撤销: 每次数据改动压栈（restoring 期间的 dirty 来自恢复动作本身，不进栈）
      if (typeof Recode !== 'undefined') Recode.push(this.project, this.floorIdx, label || 'edit', Editor.viewState());
      this.histVer++;
      this.updateHouseSize();   // 墙体增删/拖动都会走到这里，长宽徽标实时跟着变
      this._save();
    },
    /* 视图改动（平移/缩放）单独压栈: 数据没变 → 不动保存状态、不用重算长宽。
     * 有了这条，「先平移视图、再改东西」后撤销时才不会把画面拽回平移前的取景 */
    viewDirty() {
      if (typeof Recode === 'undefined' || !this.project) return;
      if (Recode.pushView(this.project, this.floorIdx, Editor.viewState())) this.histVer++;   // 让撤销按钮可用态刷新
    },
    _save() {
      this.savedState = '未保存';
      // 自动保存: 编辑停止 1 秒后同步到服务器
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.autoSave(), 1000);
    },

    /* ------- 撤销 / 重做（快照式，见 js/recode.js） ------- */
    canUndo() { void this.histVer; return typeof Recode !== 'undefined' && Recode.canUndo(); },
    canRedo() { void this.histVer; return typeof Recode !== 'undefined' && Recode.canRedo(); },
    undo() {
      const s = Recode.undo();
      if (!s) return;
      this._applySnapshot(s);
      this.toast(s.undone === 'view' ? '已撤销视图（平移/缩放）' : '已撤销');
    },
    redo() {
      const s = Recode.redo();
      if (!s) return;
      this._applySnapshot(s);
      this.toast(s.undone === 'view' ? '已重做视图（平移/缩放）' : '已重做');
    },
    /* 恢复快照 + 全套联动刷新（restoring 抑制期间的 dirty 进栈） */
    _applySnapshot(s) {
      Recode.restoring = true;
      try {
        this.project = s.project;
        this.floorIdx = Math.min(Math.max(0, s.floorIdx), this.project.floors.length - 1);
        Editor.select(null);   // 选中对象可能已不在恢复后的数据里
        /* 楼层重指向但不重新 fit: 视图直接用快照里存的，撤销/重做时画面不跳 */
        this.setFloor(false);
        Editor.setView(s.view);   // 同步缩放标签（setView 内部回调 updateZoomLabel）
        this.applyBg();        // 背景插件地面（settings.background 属于快照）
        this.rebuild3D();      // 3D 模式下重建（2D 模式 no-op，进 3D 时 setMode 会再建）
        this.updateHouseSize(); // 快照里的墙体可能不同，长宽徽标同步
        this.histVer++;
        this._save();          // 恢复的结果也要落盘（刷新页面不回跳）
      } finally {
        Recode.restoring = false;
      }
    },
    async autoSave() {
      if (!this.project) return;
      const body = serializeProject(this.project);   // 与手动保存同一份干净快照
      if (!body) return;
      try {
        await fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        this.savedState = '已保存';
      } catch (e) { /* 下次编辑会重试 */ }
    },

    /* ------- 楼层 ------- */
    /* fit=false: 只重指向楼层 + 联动刷新，不用重新适配视野（撤销恢复走这条路，避免画面跳动） */
    setFloor(fit) {
      Editor.floor = this.cur;
      if (fit === false) Editor.render(); else Editor.fit();
      this.zoomPct = Math.round(Editor.ppm / 60 * 100);
      this.syncBg();
      this.updateHouseSize();
    },
    /* noView=true: 不记录切层这个「视图动作」（新建/删除楼层自己会压一条数据快照，
     * 再插一条视图快照会让撤销要按两次） */
    selectFloor(i, noView) {
      this.floorIdx = i;
      Editor.select(null);   // 切层清选中（App 与 Editor 两边由 select 内部同步）
      this.setFloor();
      if (!noView) this.viewDirty();   // 切层 = fit 重新取景，算一次视图变化（撤销能回到原来那层的取景）
      /* 切层必须让 3D 场景（含背景插件构图）一起换层：背景 group 是按当前楼层的
       * 房屋包围盒摆位的，只在 3D 模式 rebuild 会让「2D 下切层」时背景停留在上一层
       * 的落点，之后切回 3D 前房屋与平台就是错开的。切层是低频操作，隐藏容器里
       * 多建一次 3D 模型可以接受；进 3D 时 setMode 会再 resize + rebuild 一次。 */
      View3D.rebuild(this.project, i);
    },
    addFloor() {
      this.project.floors.push(newFloor((this.project.floors.length + 1) + '层'));
      this.selectFloor(this.project.floors.length - 1, true);
      this.dirty();
    },
    delFloor() {
      if (this.project.floors.length <= 1) return;
      this.project.floors.splice(this.floorIdx, 1);
      this.selectFloor(0, true);
      this.dirty();
    },
    setProjectName(v) { this.project.name = v.trim() || '我的家'; this.dirty(); },

    /* 墙面不透明度(%)：按楼层记忆，拖动实时刷新 3D */
    setWallOpacity(v) {
      const fl = this.cur;
      if (!fl) return;
      if (isNaN(v)) return;
      fl.wallOpacity = Math.min(100, Math.max(0, Math.round(v)));
      this.commit();
    },

    /* 层高(m)：实时预览。input（打字/点步进箭头）防抖 120ms 后重建 3D，change（失焦/回车）
     * 立即收口并钳制到 2~6。打字途中不钳制——0.5 会被 2~6 夹成 2 反写回输入框，打断输入。
     * 2D 平面不画层高，redraw2d 省掉；高度只影响 3D，由 commit 的 rebuild3D 刷新（wallH 在
     * View3D.build 里读 fl.height）。 */
    setFloorHeight(v, phase) {
      const fl = this.cur;
      if (!fl) return;
      const h = parseFloat(v);
      if (isNaN(h)) {
        if (phase === 'change') { fl.height = 2.8; this.commit({ redraw2d: false }); }   // 清空/乱输，失焦兜底回默认
        return;   // 输入中途（如「3.」）不更新，等下一个字符或失焦
      }
      clearTimeout(this._fhTimer);
      if (phase === 'change') {
        fl.height = Math.min(6, Math.max(2, h));
        this.commit({ redraw2d: false });
        return;
      }
      fl.height = h;
      this._fhTimer = setTimeout(() => this.commit({ redraw2d: false }), 120);
    },

    /* ------- 数据卡（按楼层独立，动态数量，实体搜索输入） ------- */
    setCard(i, v) {
      const cards = this.cur.display.dataCards = this.cur.display.dataCards || [];
      cards[i] = String(v || '').trim();
      this.dirty();
    },
    addCard() {
      const cards = this.cur.display.dataCards = this.cur.display.dataCards || [];
      cards.push('');
      this.dirty();
    },
    removeCard(i) {
      const cards = this.cur.display.dataCards || [];
      cards.splice(i, 1);
      this.dirty();
    },
    setWeather(v) { this.project.settings.weatherEntity = String(v || '').trim(); this.dirty(); },

    /* ------- 重置当前楼层 ------- */
    openResetFloor() { this.resetText = ''; this.resetOpen = true; },
    confirmResetFloor() {
      if (this.resetText.trim() !== '确认' || !this.cur) return;
      const fl = this.cur;
      fl.walls = []; fl.doors = []; fl.windows = []; fl.furniture = []; fl.devices = [];
      Editor.select(null);   // 清选中（App 与 Editor 两边同步）
      Editor.wallStart = null;
      Editor.ghost = null;
      this.resetOpen = false;
      this.commit();
      this.toast('已重置「' + fl.name + '」（自动保存）');
    },

    /* ------- 展示大屏展示项配置 ------- */
    openDispCfg() { this.dispOpen = true; },
    inList(arr, eid) { return Array.isArray(arr) && arr.includes(eid); },
    toggleList(key, eid) {
      const st = this.cur.display;
      const arr = st[key] = st[key] || [];
      const i = arr.indexOf(eid);
      if (i >= 0) arr.splice(i, 1); else arr.push(eid);
      this.dirty();
    },
    clearDispCfg() {
      this.cur.display.displayScenes = [];
      this.cur.display.quickDevices = [];
      this.dirty();
    },
    /* 快捷设备: 搜索添加 / 移除（楼层 display.quickDevices 存实体 id 数组） */
    quickIcon(eid) {
      const dom = String(eid || '').split('.')[0];
      return { light: '💡', switch: '🔌', fan: '🌀', cover: '🪟', climate: '❄️', media_player: '🎵', water_heater: '♨️', vacuum: '🤖', camera: '📷' }[dom] || '⚙️';
    },
    addQuickDevice() {
      const eid = String(this.quickInput || '').trim();
      if (!eid || !/^[a-z_]+\.[a-z0-9_]+$/i.test(eid)) { this.toast('请先在搜索框选择或输入完整实体 ID'); return; }
      const st = this.cur.display;
      const arr = st.quickDevices = st.quickDevices || [];
      if (arr.includes(eid)) { this.toast('该实体已在快捷设备中'); return; }
      arr.push(eid);
      this.quickInput = '';
      this.entVersion++;
      this.dirty();
      this.toast('已添加快捷设备 · ' + eid);
    },
    removeQuickDevice(eid) {
      const st = this.cur.display;
      const arr = st.quickDevices = st.quickDevices || [];
      const i = arr.indexOf(eid);
      if (i >= 0) arr.splice(i, 1);
      this.entVersion++;
      this.dirty();
    },
    /* ------- 左侧导航（统一状态机） -------
     * tool 是唯一激活源: select / pan / wall / door / window / furniture / device / bg / backdrop
     * 家具、设备、贴图、背景是"浮层工具"，再次点击同一按钮 → 收起并回到选择；
     * bg（贴图）态画布行为等同选择（Editor.isSelectTool 统一处理）；
     * 视图联动: 除背景（backdrop）外的所有工具强制 2D 编辑；背景反过来强制 3D（选完即所见）
     * keepView: 只收浮层/回到选择，不切换 2D/3D（浮层的 × 与 Esc 用） */
    setTool(t, keepView) {
      const togglable = ['furniture', 'device', 'bg', 'backdrop'];
      const next = (t === this.tool && togglable.includes(t)) ? 'select' : t;
      this.tool = next;
      Editor.tool = next;
      Editor.wallStart = null;
      if (next !== 'furniture' && next !== 'device') Editor.ghost = null;
      this.furnOpen = next === 'furniture';
      this.devOpen = next === 'device';
      this.bgOpen = next === 'bg';
      this.backdropOpen = next === 'backdrop';   // 左侧导航互斥：同一时刻只有一个是 active
      // 视图联动（两条互补规则）:
      //   · 背景（backdrop）→ 3D 展示：背景只在 3D 里看得见，选完即见即所得
      //   · 其余所有工具（选择/平移/墙体/门/窗/家具/设备/贴图）→ 2D 编辑
      // 例外: 再次点同一个浮层工具只是「收起浮层」（next 回到 select），或显式 keepView（× / Esc），
      //       此时不动视图，否则在 3D 里点背景收浮层会被拽回 2D
      const closingFlyout = next === 'select' && t !== 'select';
      if (!keepView && !closingFlyout) {
        if (next === 'backdrop') {
          if (this.mode === '2d') this.setMode('3d');
        } else if (this.mode === '3d') {
          this.setMode('2d');
        }
      }
      // 背景不是选择类工具（isSelectTool 不含 backdrop），选中对象时点背景面板不会自己变，
      // 这里显式清掉选中态 → 右侧统一切到「背景设置」面板（由 tool === 'backdrop' 驱动）
      if (next === 'backdrop' && this.selection) {
        Editor.select(null);
        Editor.render();
      }
    },
    pickFurniture(f) {
      this.ghostFurn = f.id;   // 形态标识（catalog.json items[].id）
      Editor.ghost = { kind: 'furniture', data: Object.assign({}, f) };
      Editor.tool = 'furniture';
      this.toast('在户型图上点击放置: ' + f.name);
    },

    /* ------- 背景（背景插件：统一返回 3D group，扁平或立体；静态或动态） ------- */
    applyBg() {
      if (!window.PluginEngine || !View3D.scene) return;
      this.bindBgSettings();
      /* 显式重放的三个前置动作（缺一个都会让背景与房屋错位）：
       * 1) init 时 View3D 还没 build 过，houseBounds() 返回 null，插件会按默认
       *    8×8 原点构图 —— 这里先把 project / house 对准当前楼层；
       * 2) 取消同层拖墙挂起的 160ms 重放，避免和本次显式重放并发双重建销 group；
       * 3) 成功后提交构图指纹，下一次 build 才不会误判「构图变了」再画一遍；
       *    失败不提交，留旧 key 让 build 自动重试。 */
      View3D.cancelBgReplay();
      View3D.ensureHouse(this.project, this.floorIdx);
      if (PluginEngine.applyBackground(this.bgStyle, View3D) === true) View3D.syncBgKey();
    },
    /* 把项目里的背景参数 / 实体绑定对象直接交给引擎（同一引用：面板改值 → 项目数据同步变 → 自动保存） */
    bindBgSettings() {
      if (!window.PluginEngine || !this.project) return;
      const s = this.project.settings || (this.project.settings = {});
      /* 老存档的实体绑定按样式存，这里就地合并成插件级一份（幂等），
       * 保证后续自动保存写进 data/project.json 的也是同一把 key。 */
      if (PluginEngine.migrateProjectBg) PluginEngine.migrateProjectBg(s);
      if (!s.backgroundOptions) s.backgroundOptions = {};
      if (!s.backgroundFields) s.backgroundFields = {};
      PluginEngine.bgOptions = s.backgroundOptions;
      PluginEngine.bgFields = s.backgroundFields;
      /* bgOptions / bgFields 是挂在引擎上的普通对象（非 Vue 响应式）。首次初始化时
       * 面板可能已经先算过一次空值并缓存，这里用 bgTick 让依赖它们的计算属性
       * （bgOptionList / bgFieldList）在引用接好之后重算一次，避免刷新后显示旧值。 */
      this.bgTick++;
    },
    /* 改背景参数: 只重绘地面（不重建户型），即时生效并自动保存。
     * 重绘做 90ms 防抖——自绘类背景（1024 贴图 + 撒点）不能让滑块的每个 input 都跑一遍 */
    setBgOpt(key, val) {
      if (!this.bgStyle || !window.PluginEngine) return;
      this.bindBgSettings();
      const store = PluginEngine.bgOptions;
      const cur = store[this.bgStyle] || (store[this.bgStyle] = {});
      cur[key] = val;
      this.bgTick++;
      clearTimeout(this._bgOptTimer);
      this._bgOptTimer = setTimeout(() => this.applyBg(), 90);
      this.dirty();
    },
    /* 改背景的实体绑定：绑定只影响数据，不重建几何，所以只推一次 onData。
     * 值存 settings.backgroundFields['<插件id>'][key] —— 该插件所有样式共用，
     * 切样式不会丢；换回未绑定时删掉该键。 */
    setBgField(key, val) {
      if (!this.bgStyle || !window.PluginEngine || !key) return;
      this.bindBgSettings();
      const store = PluginEngine.bgFields;
      const pk = PluginEngine.bgFieldKey(this.bgStyle);
      const cur = store[pk] || (store[pk] = {});
      const eid = String(val || '').trim();
      if (eid) cur[key] = eid; else delete cur[key];
      this.bgTick++;
      this.dirty();
      PluginEngine.notifyBackgroundData(true);
    },
    setBackground(b) {
      if (!this.project) return;
      if (!this.project.settings) this.project.settings = newSettings();
      this.project.settings.background = b ? b.id : '';
      this.applyBg();
      this.dirty();   // 自动保存到 data/project.json
      this.toast(b ? ('背景已切换: ' + b.name) : '已恢复默认背景（纯色 + 网格）');
    },
    pickEntity(e) {
      Editor.ghost = { kind: 'device', data: { entityId: e.eid, name: e.name, type: e.type } };
      Editor.tool = 'device';
      this.devOpen = false;
      this.toast('在户型图上点击放置: ' + e.name);
    },
    delSelected() { Editor.deleteSelection(); },
    locateDevice(p) {
      if (p.fi !== this.floorIdx) this.selectFloor(p.fi);
      Editor.select(p.d.kindName || 'device', p.d.id);
      Editor.fit();
      this.zoomPct = Math.round(Editor.ppm / 60 * 100);
      this.viewDirty();   // 定位后取景变了，记一条视图快照（撤销能回到定位前）
    },
    typeIcon(type) { return DEVICE_TYPES[type] ? DEVICE_TYPES[type].icon : '⚙️'; },
    /* 家具图标: 直接引用 catalog.js 的全局 furnIcon（图标数据在 catalog.json 的 icon 字段） */
    furnIcon,

    /* ------- 视图 ------- */
    setMode(m) {
      this.mode = m;
      this.$nextTick(() => {
        if (m === '3d') {
          // 关键: 容器从 v-show 隐藏变为可见后先 resize 再 build
          View3D.resize();
          View3D.rebuild(this.project, this.floorIdx);
          View3D.setLabelsVisible(this.showLabels);   // 恢复顶栏开关状态
        } else {
          Editor.resize();
        }
      });
    },
    toggleLabels() {
      this.showLabels = !this.showLabels;
      View3D.setLabelsVisible(this.showLabels);
      this.toast(this.showLabels ? '已显示设备标签' : '已隐藏设备标签');
    },
    /* 旋转锚点重置回房屋中心（长按 3D 画面可自定义锚点；编辑页不持久化锚点） */
    resetAnchor() {
      View3D.resetAnchor();
      this.toast('锚点已重置回房屋中心');
    },
    openDisplay() { window.open('/display.html', '_blank'); },
    zoomStep(f) { Editor.setZoom(Editor.ppm * f); this.zoomPct = Math.round(Editor.ppm / 60 * 100); },
    zoomFit() { Editor.fit(); this.zoomPct = Math.round(Editor.ppm / 60 * 100); this.viewDirty(); },
    zoomCenter() { Editor.center(); this.viewDirty(); },
    updateZoomLabel(pct) { this.zoomPct = pct; },

    /* ------- 属性编辑 ------- */
    setSelection(sel) { this.selection = sel; },
    setProp(key, value, type) {
      const it = this.selItem;
      if (!it) return;
      let v = parseFloat(value);
      if (type === 'str') {
        const s = (value || '').trim();
        if (s) it[key] = s; else delete it[key];   // 清空 = 解绑，不留空串（插件侧统一按 falsy 判未绑定）
      }
      else { if (isNaN(v)) return; it[key] = type === 'deg' ? v * Math.PI / 180 : v; }
      this.commit({
        rebuild: type !== 'str',   // 数值修改实时刷新 3D 预览
        updateAll: true,           // 实体绑定等字段变化 → 插件即时响应
        syncLabels: true,          // 绑定字段变化 → 标签文案重算
      });
    },
    deg(rad) { return Math.round((rad || 0) * 180 / Math.PI); },

    /* ------- 同类模型/造型切换 ------- */
    /* 「2D 重绘 + 存档 + 3D 重建」统一出口（属性/造型/数值修改共 10 余处手抄收敛于此）。
     * opts.redraw2d           是否重绘 2D（默认 true；纯 3D 属性可关）
     * opts.rebuild            是否重建 3D（默认 true；rebuild3D 内部只在 3D 模式生效）
     * opts.updateAll          附带推送插件状态（扩展实体绑定等字段变化）
     * opts.syncLabels         附带重算标签文案（绑定字段变化） */
    commit(opts) {
      const o = opts || {};
      if (o.redraw2d !== false) Editor.changed();
      this.dirty();
      if (o.rebuild !== false) this.rebuild3D();
      if (o.updateAll && window.PluginEngine) PluginEngine.updateAll();
      if (o.syncLabels && this.mode === '3d') View3D.syncLabels(this.project);
    },
    rebuild3D() {
      if (this.mode !== '3d') return;
      View3D.rebuild(this.project, this.floorIdx);
    },
    /* 家具: 切换为同类别的另一个模型（保留位置/旋转）。实例只存 mid，
     * 尺寸/名称/模型随目录形态解析，所以这里把旧数据抄在实例上的字段一并清掉 */
    swapFurnModel(f) {
      const it = this.selItem;
      if (!it || !f) return;
      it.mid = f.id;   // 形态标识（type/name/尺寸/颜色/模型等由目录解析）
      ['type', 'name', 'w', 'd', 'h', 'color', 'model'].forEach((k) => { if (k in it) delete it[k]; });
      this.commit();
      this.toast('已切换为: ' + f.name);
    },
    /* 点击控制开关（设备级覆盖插件默认） */
    setDevClick(v) {
      const it = this.selItem;
      if (!it) return;
      it.click = !!v;
      this.commit({ redraw2d: false });   // 标签可点击状态随重建刷新
      this.toast(it.click ? '点击控制已启用' : '点击控制已关闭');
    },
    /* 「点击动作」下拉（实例级覆盖，优先级最高）: 选择后整体替换插件 click / 内置默认；
     * 选回「默认」即清空回到插件/内置链路。选中动作时自动勾选启用（否则点了也不生效） */
    setDevClickSvc(key) {
      const it = this.selItem;
      if (!it) return;
      if (key) {
        it.clickSvc = key;
        if (it.click !== false) it.click = true;
        this.toast('点击动作已覆盖: ' + key);
      } else {
        delete it.clickSvc;
        this.toast('点击动作已恢复默认（插件 / 内置）');
      }
      this.commit({ redraw2d: false });
    },
    /* 切换样式: 只存 obj.style（形如 'plugin:style'）；设备首次切换带出该造型的默认离地高度。
     * 只改 style / z，不动实例上的 fields 绑定值 —— 同一插件多个样式共用绑定（与背景同口径）。 */
    setSelStyle(s) {
      const it = this.selItem;
      if (!it || !s || it.style === s.id) return;
      it.style = s.id;
      if (this.selection.kind === 'device' && it.z == null) it.z = s.z;
      this.commit();   // 2D 平面简笔立即重绘（changed 顺带触发自动保存）
      this.toast('样式已切换: ' + s.name);
    },
    /* 样式条目参数（如门的手向/开向）: 值按实例存 obj.styleOpts，整对象替换保证 Vue2 响应；
     * 120ms 防抖后 commit（2D 符号 + 3D 模型一起重画，滑杆拖动不会每次 input 都重建） */
    setSelOpt(key, val) {
      const it = this.selItem;
      if (!it) return;
      const cur = Object.assign({}, it.styleOpts);
      cur[key] = val;
      it.styleOpts = cur;
      clearTimeout(this._openOptTimer);
      this._openOptTimer = setTimeout(() => this.commit(), 120);
    },
    /* 扩展实体绑定的当前读数（面板里直接显示，确认绑对了没有）
     * 返回 { text, on } —— text 为空表示未绑定，'未找到' 表示实体不存在 */
    devFieldVal(key) {
      void this.entVersion;   // 依赖实体状态版本: HA 推送后自动重算
      const it = this.selItem;
      const eid = it && it[key];
      if (!eid) return '';
      const st = HA.getState(eid);
      if (!st) return '未找到';
      return st.state + HA.unitOf(st);
    },
    clearDevField(key) {
      const it = this.selItem;
      if (!it || !it[key]) return;
      this.setProp(key, '', 'str');
      this.toast('已解绑');
    },
    /* ------- 数值编辑（设备/门窗/家具共用底座） -------
     * applyNum: 解析 + 可选角度换算/夹取 + commit（原 setDevNum/setOpenNum/setFurnNum 三胞胎收敛于此）
     * wheelStep: 滚轮步进（deltaY 向上 = 增）后走 applyNum（原 wheelNum/wheelOpen/wheelFurn 收敛于此）
     * opts: { deg: 按°输入换算弧度, min/max: 夹取, int: 取整, redraw2d: 是否重绘 2D } */
    applyNum(key, value, opts) {
      const it = this.selItem;
      if (!it) return;
      const o = opts || {};
      const v = parseFloat(value);
      if (isNaN(v)) return;
      let n = o.deg ? v * Math.PI / 180 : v;
      if (o.int) n = Math.round(n);
      if (o.min != null) n = Math.max(o.min, n);
      if (o.max != null) n = Math.min(o.max, n);
      it[key] = n;
      this.commit({ redraw2d: o.redraw2d !== false });
    },
    wheelStep(key, e, step, opts) {
      const it = this.selItem;
      if (!it) return;
      const o = opts || {};
      const cur = o.deg ? this.deg(it[key]) : (parseFloat(it[key]) || 0);
      let v = cur + (e.deltaY < 0 ? step : -step);
      if (!o.deg) v = Math.round(v * 1000) / 1000;   // 浮点步进不留 0.30000000000000004 这类尾巴
      this.applyNum(key, String(v), o);
    },
    /* 设备数值: x/y/rot 重绘 2D（redraw2d=true），z 不重绘（贴地属性由 3D 决定） */
    setDevNum(key, value, redraw2d) {
      this.applyNum(key, value, { min: key === 'z' ? 0 : null, redraw2d: !!redraw2d });
    },
    wheelNum(key, e, step, redraw2d, min, max) {
      this.wheelStep(key, e, step, {
        redraw2d: !!redraw2d,
        min: min != null ? min : (key === 'z' ? 0 : null),
        max: max != null ? max : null,
      });
    },
    /* 标签抬升高度（m）: 实例覆盖造型声明值，只动 HTML 标签位置、不重建 3D ——
     * View3D.updateLabels 每帧读 obj.labelOffset，改完下一帧就到位。
     * 拖滑条时 200ms 防抖再 dirty（快照/自动保存），避免每一档都压一条撤销栈 */
    setDevLabelOffset(value) {
      const it = this.selItem;
      if (!it) return;
      if (String(value).trim() === '') return;                // 正在清空：等 @change 再决定
      const v = parseFloat(value);
      if (isNaN(v)) return;
      it.labelOffset = Math.round(Math.max(-1, Math.min(6, v)) * 100) / 100;
      clearTimeout(this._labelOffTimer);
      this._labelOffTimer = setTimeout(() => this.dirty(), 200);
    },
    /* 输入框失焦/回车：清空 = 删掉实例覆盖，回到造型声明的 labelOffset */
    commitDevLabelOffset(value) {
      if (String(value).trim() === '') this.clearDevLabelOffset();
      else this.setDevLabelOffset(value);
    },
    clearDevLabelOffset() {
      const it = this.selItem;
      if (!it || it.labelOffset == null) return;
      delete it.labelOffset;
      clearTimeout(this._labelOffTimer);
      this._labelOffTimer = setTimeout(() => this.dirty(), 200);
    },
    wheelDevLabelOffset(e, step) {
      const cur = parseFloat(this.labelOffsetVal) || 0;
      this.setDevLabelOffset(cur + (e.deltaY < 0 ? step : -step));
    },
    /* 门窗数值: 宽度（最小 0.05m）/角度，实时刷新 2D + 3D */
    setOpenNum(key, value, type) {
      this.applyNum(key, value, { deg: type === 'deg', min: type === 'deg' ? null : 0.05 });
    },
    /* 窗离地高度: 0 起步（门恒 0 不可调，面板不渲染输入框） */
    setOpenZ(value) { this.applyNum('z', value, { min: 0 }); },
    wheelOpenZ(e, step) { this.wheelStep('z', e, step, { min: 0 }); },
    wheelOpen(key, e, step, type) {
      this.wheelStep(key, e, step, { deg: type === 'deg', min: type === 'deg' ? null : 0.05 });
    },
    /* 家具数值: 旋转/位置/离地高度/整体比例（20–300 取整），实时刷新 2D + 3D */
    setFurnNum(key, value, type) {
      this.applyNum(key, value, {
        deg: type === 'deg',
        min: key === 'z' ? 0 : (key === 'pct' ? 20 : null),
        max: key === 'pct' ? 300 : null,
        int: key === 'pct',
      });
    },
    wheelFurn(key, e, step) {
      if (key === 'rot') return this.wheelStep(key, e, step, { deg: true });
      this.wheelStep(key, e, step, {
        min: key === 'z' ? 0 : (key === 'pct' ? 20 : null),
        max: key === 'pct' ? 300 : null,
        int: key === 'pct',
      });
    },
    /* 设备造型图标（由插件 styles[].icon 提供，缺省 ⚙️） */
    devStyleIcon,

    /* ------- 参考底图（2D 户型图：全项目共用一张 —— 服务器端只存 data/refimg.* 一张图，
     *          画完户型图基本就弃用，没必要按楼层各存一份；经 /api/refimg 读取，
     *          src 带 ?t= 时间戳防缓存，重复上传不用刷新页面即可看到新图） ------- */
    pickBackground() {
      // 打开系统文件选择框时保持贴图浮层可见（浏览器文件对话框不会触发页面事件）
      if (this.$refs.bgFile) this.$refs.bgFile.click();
    },
    onBgFile(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const rd = new FileReader();
      rd.onload = async () => {
        this.toast('贴图上传中…');
        try {
          const r = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name, data: rd.result }),
          });
          const j = await r.json();
          if (!r.ok || !j.url) throw new Error(j.error || ('HTTP ' + r.status));
          this.applyBgImage(j.url, file.name);
          this.toast('参考底图已上传（全项目共用，重复上传自动覆盖）');
        } catch (err) {
          this.toast('上传失败: ' + err.message);
        }
      };
      rd.readAsDataURL(file);
    },
    /* 加载贴图并写入项目（bgImage 挂在 project 上：全楼层共用一张）。
     * src 追加 ?t= 时间戳：同一会话里重复上传时 URL 变化，浏览器不命中旧缓存 */
    applyBgImage(src, name) {
      if (src.startsWith('/api/refimg')) {
        src = src + (src.includes('?') ? '&' : '?') + 't=' + Date.now();
      }
      const img = new Image();
      img.onload = () => {
        const meta = { src, name: name || '贴图', x: 0, y: 0, w: 10, opacity: 0.35, hidden: false };
        Editor.backgroundImage = Object.assign({ img }, meta);
        this.bgW = 10;
        this.bgInfo = { has: true, hidden: false };
        if (this.project) this.project.bgImage = meta;
        Editor.render();
        this.dirty();
      };
      img.onerror = () => this.toast('图片加载失败');
      img.src = src;
    },
    /* 把编辑器中的贴图状态写回项目并标记保存 */
    writeBg() {
      const bg = Editor.backgroundImage;
      if (!this.project || !bg || !bg.src) return;
      this.project.bgImage = {
        src: bg.src, name: bg.name || '贴图',
        x: bg.x, y: bg.y, w: bg.w,
        opacity: bg.opacity == null ? 0.35 : bg.opacity,
        hidden: !!bg.hidden,
      };
      this.dirty();
    },
    /* 楼层切换/载入时恢复贴图（项目级共用，切层不换图） */
    syncBg() {
      const b = this.project && this.project.bgImage;
      const cur = Editor.backgroundImage;
      if (!b || !b.src) {
        if (cur && cur.src) { Editor.backgroundImage = null; this.bgInfo = { has: false, hidden: false }; Editor.render(); }
        return;
      }
      if (cur && cur.src === b.src) {
        Object.assign(cur, { x: b.x, y: b.y, w: b.w, opacity: b.opacity, hidden: !!b.hidden });
        this.bgW = b.w || 10;
        this.bgInfo = { has: true, hidden: !!b.hidden };
        Editor.render();
        return;
      }
      const img = new Image();
      img.onload = () => {
        // 载入期间项目可能已被撤销/重做替换
        if (!this.project || !this.project.bgImage || this.project.bgImage.src !== b.src) return;
        Editor.backgroundImage = Object.assign({}, this.project.bgImage, { img });
        this.bgW = this.project.bgImage.w || 10;
        this.bgInfo = { has: true, hidden: !!this.project.bgImage.hidden };
        Editor.render();
      };
      img.src = b.src;
    },
    toggleBg() {
      const bg = Editor.backgroundImage;
      if (!bg || !bg.img) return;
      bg.hidden = !bg.hidden;
      this.bgInfo = { has: true, hidden: !!bg.hidden };
      this.writeBg();
      Editor.render();
    },
    onBgScale(e) {
      const bg = Editor.backgroundImage;
      if (!bg || !bg.img) return;
      const nw = parseFloat(e.target.value) || 10;
      // 缩放锚点 = 图片中心：调整左上角位置使中心保持不动
      const ratio = bg.img.height / bg.img.width;
      bg.x += (bg.w - nw) / 2;
      bg.y += (bg.w - nw) * ratio / 2;
      bg.w = nw;
      this.bgW = nw;
      this.writeBg();
      Editor.render();
    },
    clearBg() {
      Editor.backgroundImage = null;
      this.bgInfo = { has: false, hidden: false };
      // 保持贴图浮层打开，方便紧接着重新上传
      if (this.project && this.project.bgImage) { this.project.bgImage = null; this.dirty(); }
      Editor.render();
    },

    /* ------- 连接 ------- */
    openConn() {
      this.connOpen = true;
      this.inHaUrl = HA.url;
      this.inToken = HA.token;
      this.connMsg = '';
    },
    async saveConn() {
      this.connMsg = '保存中…'; this.connMsgOk = true;
      try {
        const r = await HA.saveConfig(this.inHaUrl, this.inToken);
        if (r.test && r.test.ok) { this.connMsg = '已保存 · HA 连接成功 (v' + (r.test.version || '?') + ')'; this.connMsgOk = true; }
        else if (r.test && !r.test.ok) { this.connMsg = '已保存，但测试失败: ' + r.test.error; this.connMsgOk = false; }
        else { this.connMsg = '已保存'; this.connMsgOk = true; }
        HA.connect();
      } catch (e) { this.connMsg = '保存失败: ' + e.message; this.connMsgOk = false; }
    },
    async testConn() {
      this.connMsg = '测试中…'; this.connMsgOk = true;
      try {
        const j = await (await fetch('/api/config/test', { method: 'POST' })).json();
        if (j.ok) { this.connMsg = '连接成功 · HA v' + j.version + ' · ' + (j.location_name || ''); this.connMsgOk = true; }
        else { this.connMsg = '失败: ' + j.error; this.connMsgOk = false; }
      } catch (e) { this.connMsg = '失败: ' + e.message; this.connMsgOk = false; }
    },

    /* ------- 导入插件 -------
     * 拖拽 / 点选一个 zip → 原样 POST 给服务端（/api/plugins/import）：
     * 服务端解压到临时目录、读 plugin.json 拿插件 id、再整体放进 custom/plugins/<id>/
     * （同 id 覆盖升级）；成功后刷新页面，插件引擎重新拉清单并加载。 */
    openImport() {
      this.importOpen = true;
      this.importDrag = false;
      this.importing = false;
      this.importFile = null;
      this.importMsg = '';
      this.importMsgOk = true;
      this.loadInstallKey();
    },
    /* 读安装密钥状态：只有末 4 位 + 是否被环境变量锁定（明文不走这条接口） */
    async loadInstallKey() {
      try {
        const d = await (await fetch('/api/install/config')).json();
        this.keyTail = d.keyTail || '';
        this.keyLocked = !!d.locked;
      } catch (e) { /* 读不到就保持原样 */ }
    },
    /* 生成新密钥（旧密钥立即失效）。明文只出现在这次响应里，直接显示在弹窗中供复制。 */
    async genInstallKey() {
      if (this.keyBusy) return;
      if (this.keyValue && !confirm('重新生成会让 studio 里已填的旧密钥立即失效，继续？')) return;
      this.keyBusy = true;
      this.keyCopied = false;
      try {
        const r = await fetch('/api/install/config/generate', { method: 'POST' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.key) throw new Error(d.error || ('HTTP ' + r.status));
        this.keyValue = d.key;
        this.keyTail = d.keyTail || d.key.slice(-4);
        this.importMsg = '已生成新密钥，复制后填到 studio 的「设置 → 密钥」里';
        this.importMsgOk = true;
      } catch (e) {
        this.importMsg = '生成失败: ' + e.message;
        this.importMsgOk = false;
      } finally { this.keyBusy = false; }
    },
    async copyInstallKey() {
      if (!this.keyValue) return;
      try {
        await navigator.clipboard.writeText(this.keyValue);
      } catch (e) {
        /* 非 https / 剪贴板权限被拒时的兜底：临时 textarea + execCommand */
        const ta = document.createElement('textarea');
        ta.value = this.keyValue; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
        document.body.removeChild(ta);
      }
      this.keyCopied = true;
      setTimeout(() => { this.keyCopied = false; }, 1600);
    },
    closeImport() { if (!this.importing) this.importOpen = false; },
    pickPluginFile() { if (!this.importing && this.$refs.impFile) this.$refs.impFile.click(); },
    onPluginPick(e) {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';                 // 清掉选择，允许再次选同一个文件
      if (f) this.importPluginZip(f);
    },
    onPluginDrop(e) {
      this.importDrag = false;
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.importPluginZip(f);
    },
    async importPluginZip(file) {
      if (this.importing) return;
      if (!/\.zip$/i.test(String(file.name || ''))) {
        this.importMsg = '请选择 .zip 插件包'; this.importMsgOk = false; return;
      }
      this.importing = true;
      this.importFile = file;
      this.importMsg = '';
      this.importMsgOk = true;
      try {
        const buf = await file.arrayBuffer();
        const r = await fetch('/api/plugins/import', {
          method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: buf,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
        /* 家具包（kind: catalog）自带件数/包名，提示按类分开写，免得「已导入插件」误导 */
        if (d.kind === 'catalog') {
          this.importMsg = (d.upgraded ? '已升级家具包 ' : '已导入家具包 ')
            + (d.name || d.id) + '（' + (d.count || 0) + ' 件家具）'
            + (d.version ? ' v' + d.version : '') + '，正在刷新…';
        } else {
          this.importMsg = (d.upgraded ? '已升级插件 ' : '已导入插件 ') + d.id
            + (d.version ? ' v' + d.version : '') + '，正在刷新…';
        }
        this.importMsgOk = true;
        setTimeout(() => location.reload(), 900);      // 刷新后 /api/plugins 重新拉取并加载
      } catch (err) {
        this.importMsg = '导入失败: ' + err.message;
        this.importMsgOk = false;
        this.importing = false;
        this.importFile = null;
      }
    },

    /* ------- HA 事件 ------- */
    onHAChange() {
      this.entVersion++;
      if (this.mode === '3d') View3D.refresh();
      else Editor.render();
    },

    /* ------- 提示 ------- */
    toast(msg) {
      this.tooltipMsg = msg;
      this.tooltipShow = true;
      this.tooltipStyle = { left: '50%', top: '60px', transform: 'translateX(-50%)' };
      clearTimeout(this._tt);
      this._tt = setTimeout(() => { this.tooltipShow = false; this.tooltipStyle = {}; }, 2200);
    },

    bindKeys() {
      window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        const map = { v: 'select', h: 'pan', w: 'wall', d: 'door', n: 'window', f: 'furniture', e: 'device', b: 'bg', g: 'backdrop' };
        const k = e.key.toLowerCase();
        /* 撤销/重做: Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z（或 Ctrl+Y）；输入框聚焦时 bindKeys 顶部已跳过 */
        const mod = e.ctrlKey || e.metaKey;
        if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
        if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
        if (map[k] && this.mode === '2d') this.setTool(map[k]);
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.mode === '2d') Editor.deleteSelection();
        /* Esc 统一收起: 取消绘制 + 收浮层 + 清选中 → 右侧无论从属性面板还是背景面板进来，
         * 都回到「楼层设置」；'none' 是故意不存在的工具值 —— 不点亮任何左侧按钮
         * （落到 editor 的 select default 分支，画布点击选中仍可用），也不默认切回「选择」 */
        if (e.key === 'Escape') { Editor.wallStart = null; Editor.ghost = null; Editor.select(null); Editor.render(); this.setTool('none', true); }
      });
    },
  },

  watch: {
    /* 项目名称变化（手动改名 / 撤销重做恢复）→ 标签页标题同步 */
    'project.name'() { if (this.project) this.applyTitle(); },
    /* 分类页签（单行滚动）: 选中项滚进可视区 + 两端渐隐提示同步 + 列表回顶部 */
    devFilter() {
      this.$nextTick(() => {
        this.scrollTabsToActive();
        this.resetDevListScroll();
      });
    },
    devTabs() { this.$nextTick(() => { this.scrollTabsToActive(); this.updateTabsEdge(); }); },
    devOpen(v) { if (v) this.$nextTick(() => { this.scrollTabsToActive(); this.updateTabsEdge(); }); },
    /* 搜索词变化列表重刷，同样回顶部 */
    devSearch() { this.$nextTick(() => this.resetDevListScroll()); },
  },

  mounted() { this.init(); },
};

/* 项目模型函数 (newFloor / buildDefaultProject) 已移至共享模块 catalog.js */

/*
 * entity-input — 可复用的实体搜索输入组件
 * 边输入边搜索 HA 实体（实体 ID / 友好名），下拉点选后回填完整实体 ID；
 * 也可直接手输。用于天气实体、数据卡、插件实体字段等所有"绑定实体"的输入框。
 */
const EntityInput = {
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: 'sensor.xxx' },
    domains: { type: Array, default: null },   // 可选: 只搜这些域（如 ['binary_sensor']）
  },
  emits: ['update:modelValue'],
  data() {
    return { text: this.modelValue || '', open: false, items: [], dropStyle: null };
  },
  watch: {
    modelValue(v) { if (v !== this.text) this.text = v || ''; },
  },
  mounted() {
    // 下拉打开期间容器滚动/窗口缩放时实时重定位（capture 捕获内部面板滚动）
    this._re = () => { if (this.open) this.place(); };
    window.addEventListener('scroll', this._re, true);
    window.addEventListener('resize', this._re);
  },
  unmounted() {
    window.removeEventListener('scroll', this._re, true);
    window.removeEventListener('resize', this._re);
  },
  methods: {
    search() {
      const q = (this.text || '').toLowerCase();
      const all = (window.HA ? HA.all() : []);
      this.items = all
        .filter((s) => {
          if (!s || !s.entity_id) return false;
          if (this.domains && this.domains.length && !this.domains.includes(s.entity_id.split('.')[0])) return false;
          if (!q) return true;
          const name = (s.attributes && s.attributes.friendly_name) || '';
          return s.entity_id.toLowerCase().includes(q) || String(name).toLowerCase().includes(q);
        })
        .slice(0, 8);
    },
    /* 下拉定位：JS 计算 + position:fixed，视口内钳制，永不超出屏幕或被容器裁剪 */
    place() {
      this.$nextTick(() => {
        const box = this.$el;
        if (!box || !box.querySelector) return;
        const el = box.querySelector('.ent-drop');
        if (!el) return;
        const r = box.getBoundingClientRect();
        const dw = el.offsetWidth, dh = el.offsetHeight;
        const pad = 8;
        // 水平：先贴输入框左缘，超右则整体左移钳制在视口内
        let left = r.left;
        if (left + dw > window.innerWidth - pad) left = window.innerWidth - pad - dw;
        if (left < pad) left = pad;
        // 垂直：默认向下弹；下方放不下且上方空间更大则向上弹
        let top = r.bottom + 4;
        if (top + dh > window.innerHeight - pad && r.top - dh - 4 > pad) top = r.top - dh - 4;
        this.dropStyle = {
          position: 'fixed',
          top: Math.round(top) + 'px',
          left: Math.round(left) + 'px',
          minWidth: Math.min(r.width, 360) + 'px',
        };
      });
    },
    onInput(e) {
      this.text = e.target.value;
      this.$emit('update:modelValue', this.text.trim());
      this.search();
      this.open = true;
      this.place();
    },
    onFocus() { this.search(); this.open = true; this.place(); },
    onBlur() {
      setTimeout(() => { this.open = false; }, 150);
      const v = this.text.trim();
      if (v !== this.modelValue) this.$emit('update:modelValue', v);
    },
    pick(s) {
      this.text = s.entity_id;
      this.open = false;
      this.$emit('update:modelValue', s.entity_id);
    },
    stText(s) {
      const unit = HA.unitOf(s);
      if (s.state === 'on') return '开启';
      if (s.state === 'off') return '关闭';
      if (s.state === 'unavailable') return '不可用';
      return s.state + unit;
    },
    stOn(s) { return s.state === 'on'; },
  },
  template: `
    <div class="ent-input">
      <input :value="text" :placeholder="placeholder" spellcheck="false"
             @input="onInput($event)" @focus="onFocus" @blur="onBlur" @keydown.esc="open = false">
      <div class="ent-drop" v-if="open && items.length" :style="dropStyle">
        <button type="button" class="ent-opt" v-for="s in items" :key="s.entity_id" @mousedown.prevent="pick(s)">
          <span class="col">
            <span class="l1">
              <span class="n">{{ (s.attributes && s.attributes.friendly_name) || s.entity_id }}</span>
              <span class="st" :class="{on: stOn(s)}">{{ stText(s) }}</span>
            </span>
            <span class="l2">
              <code>{{ s.entity_id }}</code>
            </span>
          </span>
        </button>
      </div>
    </div>
  `,
};

/*
 * option-row — 插件参数控件行（背景参数 / 门窗样式参数等所有 options schema 共用）
 * schema 条目 o（range/number/select/checkbox/text 五类，value 已由调用方合并好默认值）；
 * 改动即 emit('set', key, value)，存哪、怎么触发实时预览由父级决定
 */
const OptionRow = {
  props: { o: { type: Object, required: true } },
  emits: ['set'],
  template: `
    <template v-if="o.type === 'range'">
      <input type="range" :min="o.min" :max="o.max" :step="o.step || 1" :value="o.value" @input="$emit('set', o.key, parseFloat($event.target.value))">
      <input class="num-s" type="number" :min="o.min" :max="o.max" :step="o.step || 1" :value="o.value" @change="$emit('set', o.key, parseFloat($event.target.value))">
    </template>
    <input v-else-if="o.type === 'number'" type="number" :step="o.step || 1" :value="o.value" @change="$emit('set', o.key, parseFloat($event.target.value))">
    <select v-else-if="o.type === 'select'" :value="o.value" @change="$emit('set', o.key, $event.target.value)">
      <option v-for="c in (o.choices || [])" :key="c.value" :value="c.value">{{ c.label }}</option>
    </select>
    <label class="sp-check" v-else-if="o.type === 'checkbox'">
      <input type="checkbox" :checked="!!o.value" @change="$emit('set', o.key, $event.target.checked)">
      <span>{{ o.tip || '启用' }}</span>
    </label>
    <input v-else :value="o.value" @change="$emit('set', o.key, $event.target.value)">
  `,
};

const app = createApp(AppComponent);
app.component('entity-input', EntityInput);
app.component('option-row', OptionRow);
window.App = app.mount('#app');
if (window.__bootDone) window.__bootDone();   // 挂载完成，移除启动图
