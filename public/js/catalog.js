/*
 * catalog.js — 家具/设备目录（尺寸单位: 米）
 *
 * 数据模型:
 *   类型（type）: 家具类型 = assets/catalog.json 的 types（前后端共用的唯一出处，运行时下发）；
 *                设备类型 = DEVICE_TYPES（代码内固定，与插件 domain 对应）
 *   形态（id）  : 同类型下的不同模型/样子，全部来自 assets（运行时动态加载）:
 *                 - 家具: /api/catalog = assets 与 custom 的 catalog.json 合并 + 扫描两处 models/*.glb
 *                 - 设备造型: 插件的 styles（assets/plugins/<id>/plugin.js），启动时注册进
 *                   PluginEngine，界面直接从引擎聚合（catalog.json 不再重复声明）
 *                 放入 assets 重启服务后界面自动更新。
 *
 * 字段:
 *   形态条目: { id, type, name, w, d, h, color, icon, model?, scale? }
 *             id=形态标识; type=所属固定类型; icon=平面图标（SVG 内部图元，见 furnIcon）
 *             图标/名称/尺寸/兜底色全部在 assets/catalog.json 里维护，代码不写死形态
 *   已放置家具实例: { id, mid(形态id), x, y, rot, z?, pct?, model? }
 *             实例只存 mid + 摆放参数；type/名称/尺寸/颜色/模型由 furnSpec() 从目录解析，
 *             目录里改了形态（尺寸/换模型），已放置家具自动跟随。
 *   设备造型: PluginEngine.styles(type) → [{ id:'<插件id>:<造型id>', sid, plugin, name, z,
 *             labelOffset?, icon?, desc?, options?, model? }]
 *             设备实例的 style 字段存聚合后的完整 id（带插件前缀，避免多插件造型重名）；
 *             options 是造型的参数 schema（右侧面板「样式参数」区据此渲染），
 *             每个实例的取值存在 styleOpts 上，插件用 ctx.options / p.options 读。
 *             要新增设备造型 → 写一个插件（见 assets/plugins/door/plugin.js 头部手册），
 *             本文件不用改一行。
 */
'use strict';

/* 家具类型（左侧库分类页签）
 * **唯一出处是 assets/catalog.json 的 types**，由 /api/catalog 的 types 字段下发，loadCatalog()
 * 时填进这里 —— 前端不再单独维护一份类型表。服务端（server/catalog-import.js）校验家具包的
 * type 也是读同一个文件，所以「加/删一个分类」只改 catalog.json 一行，两端同时生效。
 * 下面这个初始值只是服务端还没响应时的占位（此时目录 items 也为空，页签只剩「全部」）。 */
let FURNITURE_TYPES = [{ type: 'other', name: '其他' }];

/* 用服务端下发的 types 覆盖；兼容字符串写法（"sofa"）与对象写法（{type,name}） */
function setFurnitureTypes(raw) {
  const out = [];
  const seen = new Set();
  (Array.isArray(raw) ? raw : []).forEach((t) => {
    const type = String((t && t.type) || t || '').trim().toLowerCase();
    if (!type || seen.has(type)) return;
    seen.add(type);
    out.push({ type, name: String((t && t.name) || type) });
  });
  if (out.length) FURNITURE_TYPES = out;
}

const CATALOG = { items: [] };

async function loadCatalog() {
  try {
    // 服务端动态合并（catalog.json + 扫描的模型文件）；失败时回退直接读静态清单
    let data = null;
    try {
      const r = await fetch('/api/catalog?_=' + Date.now());
      if (r.ok) data = await r.json();
    } catch (e) { /* ignore */ }
    if (!data) {
      const r2 = await fetch('/assets/catalog.json?_=' + Date.now());
      data = await r2.json();
    }
    if (!Array.isArray(data)) setFurnitureTypes(data.types);   // 分类枚举 = 服务端那一份
    const list = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
    CATALOG.items = list
      .filter((x) => x && x.id && x.name && x.w && x.d)
      .map((x) => Object.assign(
        { h: Math.max(x.h || 0.5, 0.05), color: '#9aa7b8' },
        x,
        { id: x.id, type: x.type || 'other' }   // type=代码固定枚举; 未声明者归入「其他」（自定义模型）
      ));
  } catch (e) {
    console.warn('[catalog] 目录加载失败，家具目录为空:', e);
    CATALOG.items = [];
  }
  return CATALOG.items;
}

const DEVICE_TYPES = {
  light:        { label: '灯光',   icon: '💡', domains: ['light'] },
  switch:       { label: '开关',   icon: '🔌', domains: ['switch'] },
  sensor:       { label: '传感器', icon: '🌡️', domains: ['sensor', 'binary_sensor'] },
  climate:      { label: '空调',   icon: '❄️', domains: ['climate'] },
  water_heater: { label: '热水器', icon: '🚿', domains: ['water_heater'] },
  cover:        { label: '窗帘',   icon: '🪟', domains: ['cover'] },
  fan:          { label: '风扇',   icon: '🌀', domains: ['fan'] },
  media_player: { label: '影音',   icon: '🎵', domains: ['media_player'] },
  vacuum:       { label: '扫地机', icon: '🤖', domains: ['vacuum'] },
  camera:       { label: '摄像头', icon: '📷', domains: ['camera'] },
  other:        { label: '其他',   icon: '⚙️', domains: [] },
};

function deviceTypeOf(entityId) {
  const dom = (entityId || '').split('.')[0];
  for (const [k, v] of Object.entries(DEVICE_TYPES)) {
    if (v.domains.includes(dom)) return k;
  }
  return 'other';
}

/* 设备实例的类型: 实例自身声明的 d.type 优先（放置时写入），缺省按实体域推导。
 * d.type 是唯一真源，推导只是兜底 —— 10 处手抄 `d.type || deviceTypeOf(d.entityId)` 收敛于此。 */
function devTypeOf(d) {
  return d.type || deviceTypeOf(d.entityId);
}

/* 设备面板的分类页签 —— 全部由 DEVICE_TYPES 派生，新增/删除设备类型只改上面那张表，UI 不用动。
 * 顺序: 全部 → 各固定类型（DEVICE_TYPES 声明顺序）→ 其他 → 已添加
 * 全部/其他/已添加 是面板专用视图（不是设备类型），固定保留在两端。 */
function deviceTabs() {
  const tabs = [{ key: 'all', label: '全部', icon: '▦' }];
  Object.entries(DEVICE_TYPES).forEach(([key, v]) => {
    if (key === 'other') return;   // 「其他」挪到最后，紧邻"已添加"
    tabs.push({ key, label: v.label, icon: v.icon });
  });
  const other = DEVICE_TYPES.other || { label: '其他', icon: '⚙️' };
  tabs.push({ key: 'other', label: other.label, icon: other.icon });
  tabs.push({ key: 'placed', label: '已添加', icon: '📌' });
  return tabs;
}

/*
 * 设备造型: 唯一来源 = 插件（assets/plugins/<id>/plugin.js 里的 styles）
 * 插件启动时注册进 PluginEngine，这里只做聚合查询:
 *   - 聚合 id = '<插件id>:<造型id>'（如 light:pendant），避免多个插件造型重名
 *   - sid     = 插件内部的原始造型 id（插件 model3d(ctx) 收到的 ctx.style.id 就是它）
 *   - plugin  = 提供该造型的插件 id（决定用哪个插件渲染）
 * 图标: 由插件在 styles[].icon 提供（文字或 SVG 字符串），缺省兜底 ⚙️
 */

/* 造型图标: 由插件自己在 styles[].icon 里提供（与门窗完全一致，引擎不再维护映射表）。
 * icon 可以是 SVG 字符串（v-html 渲染），也可以是单个 emoji/文字。
 * 插件没写 icon 时统一用 ⚙️ 兜底 —— 想让设备造型好看，去改对应插件。 */
function devStyleIcon(s) {
  return (s && s.icon) || '⚙️';
}

/* 某设备类型的全部造型（来自插件引擎聚合，未加载插件时为空） */
function deviceStyles(type) {
  const list = (window.PluginEngine && PluginEngine.ready) ? PluginEngine.styles(type) : [];
  return list.length ? list : null;
}

/* 设备当前造型定义（d.style 优先，否则该类型第一个） */
function deviceStyleDef(d, type) {
  const list = deviceStyles(type);
  if (!list) return null;
  return (d.style && list.find((s) => s.id === d.style)) || list[0];
}

/* 设备默认锚点离地高度（未手动设置 d.z 时使用） */
function deviceDefaultZ(d, type) {
  const s = deviceStyleDef(d, type);
  if (s) return s.z;
  return 1.2;
}

/*
 * 目录读取（数据来自 /api/catalog 动态合并，见 loadCatalog）:
 *   类型 = 有限枚举（FURNITURE_TYPES）；形态 = CATALOG.items（id=形态标识, type=固定类型）
 *   已放置的家具实例只存 mid（形态标识），尺寸/名称等经 furnSpec() 解析
 */

/* 「其他」分类 = type 为 other，或历史数据里枚举外的野值（旧版导入/自动发现的 glb） */
function isKnownFurnType(t) { return FURNITURE_TYPES.some((c) => c.type === t); }
function isOtherFurnType(t) { return t === 'other' || !isKnownFurnType(t); }
function hasFurnOther() { return CATALOG.items.some((f) => isOtherFurnType(f.type)); }

/* 家具面板的分类页签（与 deviceTabs 同思路，单一数据源派生）:
 * 顺序: 全部 → 各固定类型（该类型下有形态才显示）→ 其他（有 other/野值形态才显示，固定排最后） */
function furnitureTabs() {
  const tabs = [{ key: 'all', label: '全部' }];
  FURNITURE_TYPES.forEach((c) => {
    if (c.type === 'other') return;   // 「其他」挪到最后，避免夹在装饰后面
    if (CATALOG.items.some((f) => f.type === c.type)) tabs.push({ key: c.type, label: c.name });
  });
  if (hasFurnOther()) tabs.push({ key: 'other', label: '其他' });
  return tabs;
}

/* 全部家具形态 */
function allFurniture() { return CATALOG.items; }

/* 按形态标识查找 */
function findFurniture(id) { return CATALOG.items.find((f) => f.id === id); }

/* 家具实例 → 形态定义（mid 优先，其次按 model 匹配 —— 属性面板手改的模型地址反查目录） */
function furnVariantOf(f) {
  if (f.mid) { const v = findFurniture(f.mid); if (v) return v; }
  if (f.model) { const v = CATALOG.items.find((x) => x.model === f.model); if (v) return v; }
  return null;
}

/* 家具实例的「解析视图」: 尺寸/名称/颜色/模型等一律从目录形态取，
 * 实例上只存 mid + 摆放参数（x/y/z/rot/pct），形态缺失（条目被删）时用默认尺寸兜底。 */
function furnSpec(f) {
  const def = furnVariantOf(f) || {};
  const t = def.type || 'other';
  return {
    def,
    type: isOtherFurnType(t) ? 'other' : t,   // 枚举外的历史野值统一按「其他」处理
    name: def.name || '',
    w: def.w != null ? def.w : 0.8,
    d: def.d != null ? def.d : 0.8,
    h: def.h != null ? def.h : 0.5,
    color: def.color || '#c9a26e',
    model: f.model || def.model || '',   // 实例手填的模型地址优先（属性面板可改）
    scale: f.model ? (f.scale || 1) : (def.scale || 1),
  };
}

/* 实例显示名（悬浮提示 / 属性面板标题 / 「已添加」列表共用，一律动态解析）：
 *   furniture → 目录形态名（目录改名即时生效）
 *   device    → HA friendly_name（HA 里改名这里立刻变）
 *   门 / 窗   → 插件样式名（单开门 / 固定窗…，插件改了样式名也会跟着变）
 * 实例本身不存 name 字段（避免与 HA / 目录两边不同步产生脏数据）。 */
function itemDisplayName(kind, it) {
  if (!it) return '';
  if (kind === 'furniture') return furnSpec(it).name;
  if (kind === 'device') {
    /* 有 state 才有 friendly_name；HA 还没连上时不拿实体 id 尾段冒充名字（避免闪现 lumi_cn_xxx 这类内部 id） */
    return HA.getState(it.entityId) ? HA.friendly(it.entityId) : '';
  }
  const PE = window.PluginEngine;
  const list = (PE && PE.ready) ? (PE.styles(kind) || []) : [];
  const s = it.style ? list.find((x) => x.id === it.style) : null;
  return (s && s.name) || '';   // 门窗样式名（无样式/插件未加载时留空，由调用端只显示类型名）
}

/* ---------------- 项目模型（编辑器与展示大屏共享） ---------------- */
/* 楼层的展示配置骨架: 数据卡/大屏场景/快捷设备按楼层独立（天气实体是项目级的，存 settings） */
function newDisplay() {
  return { dataCards: [], displayScenes: [], quickDevices: [] };
}

function newFloor(name) {
  return { id: uid(), name: name || '一层', height: 2.8, walls: [], doors: [], windows: [], furniture: [], devices: [], display: newDisplay() };
}

/* 项目 settings 的默认骨架（背景插件参数等仍存项目级，在此按需增删） */
function newSettings() {
  return {};
}

/* ---------------- 保存快照: 自上而下重建（脏数据防线） ----------------
 * 每次保存都按当前 schema 重新拼一份新 JSON，只输出认识的字段，所以老版本残留在
 * 数据上的旧键（楼层 bgImage、settings 里的展示配置、家具实例抄的 type/name/w/d/h/color、
 * 门窗的 posEntityId、设备上手填的 name…）永远不会被写回服务器。
 * 服务端只做校验、不参与清洗；以后加字段在这里补一行即可。 */

/* 单层墙包围盒（米）：无墙返回 null。w = 东西向(X)，d = 南北向(Y)。
 * 楼层间户型尺寸可能不一样，2D 长宽徽标 / 3D 背景构图都按「当前层」取。 */
function floorFootprint(fl) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, has = false;
  ((fl && fl.walls) || []).forEach((w) => {
    has = true;
    minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
  });
  return has ? { minX, maxX, minY, maxY, w: maxX - minX, d: maxY - minY } : null;
}

/* 各楼层单独尺寸里的最大长宽（米）：studio 背景占位盒参考。
 * 逐维取所有楼层的最大值（w = 各层最长的东西向、d = 各层最长的南北向），
 * 保证占位盒能容纳任何一层的户型 —— 比并集更贴近实际（并集会被错位楼层撑大）。 */
function maxFloorSize(p) {
  let w = 0, d = 0;
  ((p && p.floors) || []).forEach((fl) => {
    const f = floorFootprint(fl);
    if (f) { w = Math.max(w, f.w); d = Math.max(d, f.d); }
  });
  return (w > 0 && d > 0) ? { w, d } : null;
}

function serializeProject(p) {
  if (!p || !Array.isArray(p.floors) || !p.floors.length) return null;
  /* 保存前再归一一次：老存档里按样式分散的 backgroundFields 合并成插件级 key，
   * 保证写进 data/project.json 的始终是「一个插件一把 key」（fetchProject 读档时也会做）。 */
  if (window.PluginEngine && PluginEngine.migrateProjectBg && p.settings) {
    PluginEngine.migrateProjectBg(p.settings);
  }
  /* 早期版本抄在实例上的展示字段（名称/尺寸/颜色等，现由目录或 HA 解析）——一律不复刻 */
  const LEGACY_KEYS = ['name', 'w', 'd', 'h', 'color'];
  const S = (v) => (typeof v === 'string' ? v : '');
  const N = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
  const optObj = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const o = {};
    Object.keys(v).forEach((k) => { const x = v[k]; if (x != null && x !== '') o[k] = x; });
    return Object.keys(o).length ? o : undefined;
  };

  /* 插件声明的绑定字段键（设备功率/温湿度、门窗开度实体…值都直接存在实例上）。
   * 插件尚未加载时退化为「实例上的其它键原样保留」，宁可带上旧键也不丢绑定。
   * 背景插件的 fields 是「动态实体订阅」声明，值存在 settings.backgroundFields 里、不落在实例上，
   * 所以不进这个白名单（否则会污染设备实例的可保留键集合）。 */
  const PE = window.PluginEngine;
  const fieldKeys = new Set();
  if (PE && Array.isArray(PE.defs)) {
    PE.defs.forEach((d) => {
      if (!d || d.kind === 'background') return;
      (d.fields || []).forEach((f) => { if (f && f.key) fieldKeys.add(f.key); });
    });
  }
  const copyFields = (out, obj) => {
    if (!obj) return;
    if (!PE || !Array.isArray(PE.defs)) {
      /* 插件未加载：除已知旧键外原样保留，宁可带上旧字段也不丢绑定 */
      Object.keys(obj).forEach((k) => { if (!(k in out) && LEGACY_KEYS.indexOf(k) < 0) out[k] = obj[k]; });
      return;
    }
    fieldKeys.forEach((k) => { const v = obj[k]; if (v != null && v !== '') out[k] = v; });
  };

  const wallOut = (w) => ({
    id: S(w.id),
    x1: N(w.x1) || 0, y1: N(w.y1) || 0, x2: N(w.x2) || 0, y2: N(w.y2) || 0,
    t: N(w.t) || 0.24,
  });

  /* 门窗（同构）：洞口的摆放 + 样式 + 绑定实体 + 扩展字段 */
  const openOut = (o) => {
    const r = { id: S(o.id), x: N(o.x) || 0, y: N(o.y) || 0, w: N(o.w) || 1, rot: N(o.rot) || 0 };
    if (S(o.wallId)) r.wallId = S(o.wallId);
    if (S(o.entityId)) r.entityId = S(o.entityId);
    if (S(o.posEntityId)) r.posEntityId = S(o.posEntityId);
    if (S(o.style)) r.style = S(o.style);
    if (N(o.z) != null) r.z = N(o.z);                                 // 窗离地高度（门恒 0，不参与）
    if (N(o.labelOffset) != null) r.labelOffset = N(o.labelOffset);   // 实例级标签抬升覆盖
    if (o.click === true || o.click === false) r.click = o.click;     // 实例级点击控制覆盖
    if (S(o.clickSvc)) r.clickSvc = S(o.clickSvc);                    // 实例级点击动作（下拉选择，优先级最高）
    const so = optObj(o.styleOpts); if (so) r.styleOpts = so;
    copyFields(r, o);
    return r;
  };

  /* 家具实例只存 mid + 摆放参数；type/name/尺寸/颜色由 furnSpec 从目录解析 */
  const furnOut = (f) => {
    const r = { id: S(f.id), mid: S(f.mid), x: N(f.x) || 0, y: N(f.y) || 0, rot: N(f.rot) || 0 };
    if (N(f.z) != null) r.z = N(f.z);
    if (N(f.pct) != null) r.pct = N(f.pct);
    if (N(f.scale) != null) r.scale = N(f.scale);
    if (S(f.model)) r.model = S(f.model);
    return r;
  };

  const devOut = (d) => {
    const r = { id: S(d.id), entityId: S(d.entityId), type: S(d.type), x: N(d.x) || 0, y: N(d.y) || 0 };
    if (N(d.rot) != null) r.rot = N(d.rot);
    if (N(d.z) != null) r.z = N(d.z);
    if (N(d.pct) != null) r.pct = N(d.pct);
    if (S(d.style)) r.style = S(d.style);
    if (N(d.labelOffset) != null) r.labelOffset = N(d.labelOffset);   // 实例级标签抬升覆盖
    if (d.click === true || d.click === false) r.click = d.click;   // 设备级点击控制覆盖
    if (S(d.clickSvc)) r.clickSvc = S(d.clickSvc);                  // 实例级点击动作（下拉选择，优先级最高）
    const so = optObj(d.styleOpts); if (so) r.styleOpts = so;
    copyFields(r, d);
    return r;
  };

  /* 楼层级展示配置（数据卡 + 展示大屏的场景/快捷设备；天气实体在项目级 settings） */
  const displayOut = (v) => {
    const d = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    return {
      dataCards: strList(d.dataCards),
      displayScenes: strList(d.displayScenes),
      quickDevices: strList(d.quickDevices),
    };
  };

  const floorOut = (fl) => ({
    id: S(fl.id),
    name: S(fl.name) || '一层',
    height: N(fl.height) || 2.8,
    wallOpacity: N(fl.wallOpacity) || 45,
    walls: (Array.isArray(fl.walls) ? fl.walls : []).map(wallOut),
    doors: (Array.isArray(fl.doors) ? fl.doors : []).map(openOut),
    windows: (Array.isArray(fl.windows) ? fl.windows : []).map(openOut),
    furniture: (Array.isArray(fl.furniture) ? fl.furniture : []).map(furnOut),
    devices: (Array.isArray(fl.devices) ? fl.devices : []).map(devOut),
    display: displayOut(fl.display),
  });

  const st = p.settings && typeof p.settings === 'object' && !Array.isArray(p.settings) ? p.settings : {};
  const out = {
    name: S(p.name) || '我的家',
    /* rotUnit = 旋转角存储单位（全链统一「度」: 设备/门窗/家具同一口径）。
     * 旧版数据门窗 rot 存弧度，fetchProject 读档时按此标记迁移，写档后即带标记 */
    rotUnit: 'deg',
    floors: p.floors.map(floorOut),
    /* settings = 项目级配置: 背景插件选择/参数/实体绑定 + 全局天气实体 */
    settings: {
      background: S(st.background),
      backgroundOptions: optObj(st.backgroundOptions) || {},
      /* 背景 onData 的实体绑定: { '<插件id>': { 字段key: entityId } } —— 同一插件所有样式共用。
       * 背景参数 backgroundOptions 仍按 '<插件id>:<样式id>' 存（各样式默认值不同）。 */
      backgroundFields: optObj(st.backgroundFields) || {},
      weatherEntity: S(st.weatherEntity),
    },
  };
  /* 户型长宽（米，各楼层单独尺寸取最大，保存时从墙体现算保证不失真）：
   * studio 开背景插件时按这两个值设置占位盒的长/宽（safeW/safeD）。
   * 逐维取最大（而不是全屋并集）：楼层错位布置时并集会比任何一层都大，占位盒虚胖。 */
  const ms = maxFloorSize(p);
  if (ms) {
    out.houseW = Math.round(ms.w * 10) / 10;
    out.houseD = Math.round(ms.d * 10) / 10;
  }
  /* 贴图（项目级，全楼层共用一张）；src 去掉 ?t= 防缓存时间戳，只存干净路径 */
  if (p.bgImage && S(p.bgImage.src)) {
    out.bgImage = {
      src: S(p.bgImage.src).split('?')[0],
      name: S(p.bgImage.name) || '贴图',
      x: N(p.bgImage.x) || 0,
      y: N(p.bgImage.y) || 0,
      w: N(p.bgImage.w) || 10,
      opacity: N(p.bgImage.opacity) != null ? N(p.bgImage.opacity) : 0.35,
      hidden: p.bgImage.hidden === true,
    };
  }
  return out;
}

/* 加载已保存项目（/api/project）。无数据 / 异常返回 null，由调用端回退示例户型。
 * settings 兜底与旧版背景插件 id 迁移两步曾各抄一份，收敛于此。 */
async function fetchProject() {
  try {
    const p = await (await fetch('/api/project')).json();
    if (p && p.floors && p.floors.length) {
      if (!p.settings) p.settings = newSettings();
      if (window.PluginEngine && PluginEngine.migrateProjectBg) PluginEngine.migrateProjectBg(p.settings);
      /* rot 单位迁移: 旧版门窗 rot 存弧度（编辑器沿墙吸附的 atan2 原值）→ 统一为度。
       * 一次性：迁移完写入 rotUnit:'deg'，下次保存后不再进这个分支 */
      if (p.rotUnit !== 'deg') {
        p.floors.forEach((fl) => {
          if (!fl || typeof fl !== 'object') return;
          ['doors', 'windows'].forEach((k) => {
            (Array.isArray(fl[k]) ? fl[k] : []).forEach((o) => {
              if (o && typeof o.rot === 'number') o.rot = Math.round(o.rot * 180 / Math.PI * 10) / 10;
            });
          });
        });
        p.rotUnit = 'deg';
      }
      p.floors.forEach((fl) => {
        if (!fl || typeof fl !== 'object') return;
        if (!fl.display || typeof fl.display !== 'object' || Array.isArray(fl.display)) fl.display = newDisplay();
      });
      return p;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function buildDefaultProject() {
  const p = { name: '我的家', floors: [newFloor('一层')], settings: newSettings() };
  const f = p.floors[0];
  const W = 0.24;
  const wall = (x1, y1, x2, y2) => f.walls.push({ id: uid(), x1, y1, x2, y2, t: W });
  wall(0, 0, 10, 0); wall(10, 0, 10, 8); wall(10, 8, 0, 8); wall(0, 8, 0, 0);
  wall(0, 4.8, 4.6, 4.8); wall(4.6, 8, 4.6, 4.8);
  wall(6.2, 4.8, 10, 4.8); wall(6.2, 4.8, 6.2, 2.2);
  wall(6.2, 2.2, 8, 2.2); wall(8, 0, 8, 2.2);
  const door = (x, y, w, rot) => f.doors.push({ id: uid(), x, y, w, rot });
  door(4.6, 5.6, 0.9, 90); door(6.2, 3.2, 0.85, 90); door(7, 2.2, 0.8, 0); door(2.5, 0, 1.0, 0);
  const win = (x, y, w, rot) => f.windows.push({ id: uid(), x, y, w, rot });
  win(1.5, 0, 1.8, 0); win(5, 8, 1.6, 0); win(10, 3.4, 1.6, 90); win(0, 2.4, 1.6, 90);
  const F = (mid, x, y, rot) => {
    // mid = 形态 id（如 teatable / wardrobe）；实例只存 mid + 摆放参数，
    // type/尺寸/颜色等由 furnSpec 从目录解析（形态条目缺失时跳过）
    if (findFurniture(mid)) f.furniture.push({ id: uid(), mid, x, y, rot: rot || 0 });
  };
  F('sofa', 3.2, 3.9); F('teatable', 3.2, 2.7); F('tvstand', 3.2, 0.35); F('dining', 1.2, 1.4);
  F('bed', 1.6, 6.4, 0); F('nightstand', 3.1, 5.5); F('wardrobe', 3.9, 7.6, Math.PI / 2);
  F('desk', 7.4, 4.2); F('bookshelf', 9.6, 4.3, Math.PI / 2);
  F('toilet', 6.8, 1.5); F('sink', 7.8, 0.5, Math.PI / 2);
  F('cabinet', 8.9, 0.4); F('stove', 9.6, 0.9);
  return p;
}

/* ---------------- 家具图标（数据驱动） ----------------
 * 图标不写在代码里：每个形态在自己的 catalog.json 条目上用 icon 字段声明
 *   icon = 一段 SVG 内部图元（不写 <svg> 外壳），坐标系固定 viewBox="0 0 68 46"
 * 这里只负责按 size 缩放并套上 <svg> 外壳；取不到 icon 时用通用方块兜底。
 * 改图标的形状/配色、新增形态，全部只改 assets/catalog.json，不动代码。
 */
const FURN_ICON_W = 68, FURN_ICON_H = 46;
const FURN_ICON_FALLBACK =
  '<rect x="12" y="10" width="44" height="26" rx="3" fill="none" stroke="#5d6b82" stroke-width="2.5"/>';

/* itemOrId: 形态对象（推荐，直接读 .icon）或形态 id / 固定类型名（目录里查一次） */
function furnIcon(itemOrId, size) {
  const s = size || 1;
  let icon = null;
  if (itemOrId && typeof itemOrId === 'object') {
    icon = itemOrId.icon || null;
  } else if (typeof itemOrId === 'string' && itemOrId) {
    const hit = CATALOG.items.find((x) => x.id === itemOrId) || CATALOG.items.find((x) => x.type === itemOrId);
    if (hit) icon = hit.icon || null;
  }
  const W = FURN_ICON_W * s, H = FURN_ICON_H * s;
  return `<svg viewBox="0 0 ${FURN_ICON_W} ${FURN_ICON_H}" width="${W}" height="${H}">`
    + (icon || FURN_ICON_FALLBACK) + '</svg>';
}
