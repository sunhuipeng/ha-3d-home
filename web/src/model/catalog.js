/*
 * model/catalog.js — 家具/设备目录与项目模型的「无 Vue 依赖」领域层
 *
 * 从原引擎目录整体迁来：engine/ 只该放绘制/编辑器/渲染引擎，
 * 这里放的是静态枚举、纯函数、目录数据与项目序列化，没有任何 Vue / Pinia 依赖。
 * engine/editor.js / view3d.js 直接 import 本文件；它们在 2D 绘制、
 * 3D 重建热路径里同步调用 furnSpec() / uid() / itemDisplayName()，因此这些函数必须
 * 保持「不依赖组件实例」的普通 ESM 函数，不能改成 useStore() getter —— 那会把引擎
 * 绑到 Vue 生命周期，SSR 与单测也会崩。
 *
 * 目录的响应式投影在 stores/catalog.js，由它的 loadCatalog() Action 在加载后写入本层；
 * engine/index.js 把本文件的导出挂到 window，供运行时注入的动态插件使用。
 *
 * catalog.js — 家具/设备目录（尺寸单位: 米）
 *
 * 数据模型:
 *   类型（type）: 家具类型 = assets/catalog.json 的 types（前后端共用的唯一出处，运行时下发）；
 *                设备类型 = DEVICE_TYPES（代码内固定，与插件 domain 对应）
 *   形态（id）  : 同类型下的不同模型/样子，全部来自 assets（运行时动态加载）:
 *                 - 家具: /api/catalog = assets/catalog.json + 扫描两处 models/*.glb（自定义家具走 studio 发布的家具包 custom/models/<项目id>/）
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
import { HA } from '../services/ha.js';
import { MAX_DISPLAY_ITEMS, ITEM_KINDS } from './displayAction.js';
import { PluginEngine } from '../engine/plugins.js';

/* 全局唯一 id 生成：编辑页与大屏页都会调 newFloor() / buildDefaultProject()。
 * 以前定义在 editor.js，而大屏页并不引入 editor.js —— 项目文件缺失走到示例户型
 * 时会直接 ReferenceError 整页崩。下沉到两页共用的 catalog.js。 */
export let _uidCounter = 0;
export function uid() { return 'i' + Date.now().toString(36) + (++_uidCounter).toString(36); }

/* 家具类型（左侧库分类页签）
 * **唯一出处是 assets/catalog.json 的 types**，由 /api/catalog 的 types 字段下发，loadCatalog()
 * 时填进这里 —— 前端不再单独维护一份类型表。服务端（server/catalog-import.js）校验家具包的
 * type 也是读同一个文件，所以「加/删一个分类」只改 catalog.json 一行，两端同时生效。
 * 下面这个初始值只是服务端还没响应时的占位（此时目录 items 也为空，页签只剩「全部」）。 */
export let FURNITURE_TYPES = [{ type: 'other', name: '其他' }];

/* 用服务端下发的 types 覆盖；兼容字符串写法（"sofa"）与对象写法（{type,name}） */
export function setFurnitureTypes(raw) {
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

export const CATALOG = { items: [] };

export async function loadCatalog() {
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

/* ---- 跨端共享的楼层口径常量（唯一出处；server/shared.js 的 LIST_KEYS 与之同一份清单） ---- */

/* 楼层上的元素列表键：newFloor / 序列化兜底 / 重置楼层等一切「整组清空」的场景都从这里取 */
export const FLOOR_LIST_KEYS = ['walls', 'doors', 'windows', 'furniture', 'devices', 'rooms'];

/* 选中 kind → 楼层数组键（引擎 deleteSelection / store selItem / 卡片收集共用一份） */
export const KIND_ARR = {
  wall: 'walls', door: 'doors', window: 'windows',
  furniture: 'furniture', device: 'devices', room: 'rooms',
};

/* 选中 kind → 中文名（store 的属性面板标题与 2D 悬停提示共用一份） */
export const KIND_NAME = {
  wall: '墙体', door: '门', window: '窗',
  furniture: '家具', device: '设备', room: '房间',
};

/* 缺省层高（新建楼层 / 输入兜底 / 渲染兜底共用） */
export const DEFAULT_FLOOR_H = 2.8;

export const DEVICE_TYPES = {  light:        { label: '灯光',   icon: '💡', domains: ['light'] },
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

export function deviceTypeOf(entityId) {
  const dom = (entityId || '').split('.')[0];
  for (const [k, v] of Object.entries(DEVICE_TYPES)) {
    if (v.domains.includes(dom)) return k;
  }
  return 'other';
}

/* 设备实例的类型: 实例自身声明的 d.type 优先（放置时写入），缺省按实体域推导。
 * d.type 是唯一真源，推导只是兜底 —— 10 处手抄 `d.type || deviceTypeOf(d.entityId)` 收敛于此。 */
export function devTypeOf(d) {
  return d.type || deviceTypeOf(d.entityId);
}

/* 设备面板的分类页签 —— 全部由 DEVICE_TYPES 派生，新增/删除设备类型只改上面那张表，UI 不用动。
 * 顺序: 全部 → 各固定类型（DEVICE_TYPES 声明顺序）→ 其他 → 已添加
 * 全部/其他/已添加 是面板专用视图（不是设备类型），固定保留在两端。 */
export function deviceTabs() {
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
export function devStyleIcon(s) {
  return (s && s.icon) || '⚙️';
}

/* 某设备类型的全部造型（来自插件引擎聚合，未加载插件时为空） */
export function deviceStyles(type) {
  const list = (window.PluginEngine && PluginEngine.ready) ? PluginEngine.styles(type) : [];
  return list.length ? list : null;
}

/* 设备当前造型定义（d.style 优先，否则该类型第一个） */
export function deviceStyleDef(d, type) {
  const list = deviceStyles(type);
  if (!list) return null;
  return (d.style && list.find((s) => s.id === d.style)) || list[0];
}

/* 设备默认锚点离地高度（未手动设置 d.z 时使用；styles 条目漏写 z 也兜住，避免 NaN） */
export function deviceDefaultZ(d, type) {
  const s = deviceStyleDef(d, type);
  return s && s.z != null ? s.z : 1.2;
}

/*
 * 目录读取（数据来自 /api/catalog 动态合并，见 loadCatalog）:
 *   类型 = 有限枚举（FURNITURE_TYPES）；形态 = CATALOG.items（id=形态标识, type=固定类型）
 *   已放置的家具实例只存 mid（形态标识），尺寸/名称等经 furnSpec() 解析
 */

/* 「其他」分类 = type 为 other，或历史数据里枚举外的野值（旧版导入/自动发现的 glb） */
export function isKnownFurnType(t) { return FURNITURE_TYPES.some((c) => c.type === t); }
export function isOtherFurnType(t) { return t === 'other' || !isKnownFurnType(t); }

/* ---------------- 插件家具造型的家具分类（ftype） ----------------
 * 家具插件（kind:'device' + type:'furniture'）在 register / styles[] 里声明 ftype，
 * 值为 assets/catalog.json 的 types 键。引擎只做小写归一化 + 透传（不知道枚举），
 * 枚举校验与显示名都收敛在这里 —— 与目录条目（CATALOG.items[].type）同一套口径。 */

/* 分类键 → 中文名（唯一出处 FURNITURE_TYPES）；未知 / 空 → '' */
export function furnTypeName(t) {
  const k = String(t == null ? '' : t).trim().toLowerCase();
  if (!k) return '';
  const hit = FURNITURE_TYPES.find((c) => c.type === k);
  return hit ? hit.name : '';
}

/* 插件造型的家具分类（styles[].ftype）:
 *   未声明        → ''（UI 回退「家具」）
 *   枚举内的值    → 原样
 *   枚举外的值    → 'other'（与目录野值同口径，归入「其他」页签） */
export function furnTypeOfStyle(s) {
  const k = String((s && s.ftype) || '').trim().toLowerCase();
  if (!k) return '';
  return isOtherFurnType(k) ? 'other' : k;
}

/* 家具实例（device + type:'furniture'）的家具分类：按当前样式解析（无样式回退该类型第一个） */
export function furnTypeOfDevice(d) {
  return furnTypeOfStyle(deviceStyleDef(d, 'furniture'));
}

/* 全部家具形态（只含目录静态 GLB 条目 —— 家具实例的「同类模型」切换只能落在这里，
 * 不能混入插件造型：插件家具没有 mid，换过去会解析不到形态） */
export function allFurniture() { return CATALOG.items; }

/* 插件家具造型 → 家具库条目（与目录条目同形状，供家具面板合并展示）:
 *   { id:'<插件id>:<造型id>', name, type(家具分类，ftype 归一化), icon, custom,
 *     plugin:true, dynamic:true, style:<聚合造型 id>, w, d, color }
 * 与目录条目的本质区别: **没有 mid** —— 放置时创建的是 floors.devices 里的
 * { type:'furniture', style } 实例（插件 model3d 现场建模），不是静态 GLB 家具。
 * w/d/color 只是给 ghost 预览与卡片兜底的估值（插件 def.placeholder），真实外形由插件算。
 * 依赖 PluginEngine.ready：目录 store 的 refreshPlugins() 在 loadAll() 之后调用。 */
export function pluginFurniture() {
  const PE = (typeof window !== 'undefined') ? window.PluginEngine : null;
  if (!PE || !PE.ready || typeof PE.styles !== 'function') return [];
  return (PE.styles('furniture') || []).map((s) => {
    const def = PE.byId && PE.byId[s.plugin];
    const ph = (def && def.placeholder) || {};
    const c = ph.color;
    return {
      id: s.id,
      name: s.name || '家具',
      type: furnTypeOfStyle(s) || 'other',   // ftype 未声明 → 「其他」页签
      icon: s.icon || '',
      custom: !!s.custom,
      plugin: true,
      dynamic: true,
      style: s.id,
      w: ph.w || 1.2,
      d: ph.d || 0.6,
      color: typeof c === 'number' ? '#' + c.toString(16).padStart(6, '0') : '#c9a26e',
    };
  });
}

/* 按形态标识查找 */
export function findFurniture(id) { return CATALOG.items.find((f) => f.id === id); }

/* 家具实例 → 形态定义（mid 优先，其次按 model 匹配 —— 属性面板手改的模型地址反查目录） */
export function furnVariantOf(f) {
  if (f.mid) { const v = findFurniture(f.mid); if (v) return v; }
  if (f.model) { const v = CATALOG.items.find((x) => x.model === f.model); if (v) return v; }
  return null;
}

/* 家具实例的「解析视图」: 尺寸/名称/颜色/模型等一律从目录形态取，
 * 实例上只存 mid + 摆放参数（x/y/z/rot/pct），形态缺失（条目被删）时用默认尺寸兜底。 */
export function furnSpec(f) {
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
export function itemDisplayName(kind, it) {
  if (!it) return '';
  if (kind === 'furniture') return furnSpec(it).name;
  if (kind === 'device') {
    /* 家具插件实例（type:'furniture'）没有 HA 实体：显示当前样式名（插件造型），
     * 无样式/插件未加载时回退「家具」。 */
    if (it.type === 'furniture') {
      const PE = window.PluginEngine;
      const list = (PE && PE.ready) ? (PE.styles('furniture') || []) : [];
      const s = (it.style && list.find((x) => x.id === it.style)) || list[0] || null;
      return (s && s.name) || '家具';
    }
    /* 有 state 才有 friendly_name；HA 还没连上时不拿实体 id 尾段冒充名字（避免闪现 lumi_cn_xxx 这类内部 id） */
    return HA.getState(it.entityId) ? HA.friendly(it.entityId) : '';
  }
  const PE = window.PluginEngine;
  const list = (PE && PE.ready) ? (PE.styles(kind) || []) : [];
  const s = it.style ? list.find((x) => x.id === it.style) : null;
  return (s && s.name) || '';   // 门窗样式名（无样式/插件未加载时留空，由调用端只显示类型名）
}

/* ---------------- 项目模型（编辑器与展示大屏共享） ---------------- */
/* 楼层的展示配置骨架：数据卡 / 展示项按楼层独立（天气实体是项目级的，存 settings）。
 * displayItems = [{ eid, kind, name?, icon?, action? }]，见 model/displayAction.js。
 * 旧字段 displayScenes / quickDevices 已下线，按用户要求不做兼容迁移。 */
export function newDisplay() {
  return { dataCards: [], displayItems: [] };
}

/* ---------------- 房间（2D 地面分区多边形） ----------------
 * floor.rooms = [{ id, name, pts: [[x,y],...], color? }]，与 walls/doors/… 平级。
 * 只存几何 + 名字（颜色可选覆盖），**面积/中心一律实时算**——派生数据不进 JSON，
 * 和家具实例只存 mid、尺寸由 furnSpec 解析是同一个口径（改了点就自动对）。 */
export const ROOM_COLORS = ['#dbe7f3', '#f3e3d3', '#dcecdc', '#f1dde6', '#e6e1f2', '#f4ebd6'];

/* 第 n 间房的默认色（新建时取，落盘后成为实例颜色，之后不再随序号漂移） */
export function roomColor(i) { return ROOM_COLORS[Math.abs(i | 0) % ROOM_COLORS.length]; }

/* 多边形有效性：至少 3 点、每点两个有限数、且面积 > 0（三点共线不算房间） */
export function roomPtsOk(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return false;
  for (const p of pts) {
    if (!Array.isArray(p) || p.length < 2 || !isFinite(p[0]) || !isFinite(p[1])) return false;
  }
  return Math.abs(roomArea(pts)) > 0.01;
}

/* 面积（m²，鞋带公式；返回带符号值，调用处取绝对值/判断顺逆时针都用它） */
export function roomArea(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/* 面积加权重心：给「名称 · 面积」标签和 3D 落点用。
 * 退化（共线/零面积）时回退顶点平均值，保证永远返回一个可用点。 */
export function roomCentroid(pts) {
  if (!Array.isArray(pts) || !pts.length) return [0, 0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    const cross = p[0] * q[1] - q[0] * p[1];
    a += cross; cx += (p[0] + q[0]) * cross; cy += (p[1] + q[1]) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
    return [sx / pts.length, sy / pts.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/* 点在多边形内（射线法）。tol 为「边界外扩容差」（米）：
 * 房间是面，点击判定必须允许贴边点中，否则边界上那一条像素永远选不中 */
export function pointInRoom(pts, x, y, tol) {
  if (!Array.isArray(pts) || pts.length < 3) return false;
  const t = tol || 0;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    /* 先判「到这条边的距离 < tol」——边界命中直接算在内（射线法对边界结果不稳定） */
    if (t > 0) {
      const dx = xj - xi, dy = yj - yi;
      const l2 = dx * dx + dy * dy || 1;
      const k = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / l2));
      if (Math.hypot(x - (xi + dx * k), y - (yi + dy * k)) <= t) return true;
    }
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* 点相对房间的三态判定：'in' 明确落在内部 / 'edge' 贴边 / 'out' 完全在外面。
 * 为什么需要它（而不是直接用 pointInRoom）：
 *   房间**形状变化**（拖顶点、新画一间）后要重算归属，规则是「明确在房内的才更新，
 *   贴边或画在房外的一律保持原归属」—— 墙两侧可能是两间房，几何判定代表不了用户意图。
 *   而 pointInRoom 带 tol 时把「距边 < tol」也算 inside，tol=0 时射线法对边界点结果不稳定，
 *   两态都不足以表达「贴边」。所以先量到各边的最近距离：<= edge 直接判 'edge'，
 *   剩下的点离边足够远，射线法稳定，可以放心分 in / out。 */
export function pointInRoomStrict(pts, x, y, edge) {
  if (!Array.isArray(pts) || pts.length < 3) return 'out';
  const e = edge == null ? 0.15 : edge;   // 0.15 ≈ 半墙厚(0.12) + 余量：压墙线的元素算贴边
  let dmin = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    const dx = xj - xi, dy = yj - yi;
    const l2 = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / l2));
    dmin = Math.min(dmin, Math.hypot(x - (xi + dx * k), y - (yi + dy * k)));
  }
  if (dmin <= e) return 'edge';
  return pointInRoom(pts, x, y, 0) ? 'in' : 'out';
}

/* 新建房间：pts 已是世界坐标；序号只用于默认名与默认色 */
export function newRoom(pts, idx) {
  const i = idx || 0;
  return { id: uid(), name: '房间 ' + (i + 1), pts: pts.map((p) => [p[0], p[1]]), color: roomColor(i) };
}

/* 某房间里的门窗 / 设备 / 家具数量（房间面板统计用）。
 * 只看实例上的 roomId，**不重新做几何判定** —— 用户在面板里手动改过归属，
 * 就以手动值为准，不能被「点不在多边形内」又算回去。
 * 门窗单独计数：它们贴在墙上，用户关心的是「这间房有几个门/窗」，
 * 和落地设备混成一个总数会看不出信息。 */
export function roomCounts(fl, roomId) {
  const n = { doors: 0, windows: 0, devices: 0, furniture: 0 };
  if (!fl || !roomId) return n;
  ((fl.doors) || []).forEach((o) => { if (o && o.roomId === roomId) n.doors++; });
  ((fl.windows) || []).forEach((o) => { if (o && o.roomId === roomId) n.windows++; });
  ((fl.devices) || []).forEach((d) => { if (d && d.roomId === roomId) n.devices++; });
  ((fl.furniture) || []).forEach((f) => { if (f && f.roomId === roomId) n.furniture++; });
  return n;
}

/* 房间里的设备（卡片列表用）：只认实例上的 roomId 且有 entityId，不做几何回算 ——
 * 与 roomCounts 同口径，归属以用户手动值为准。门窗家具不出卡，因此不在此列。 */
export function roomDevices(fl, roomId) {
  if (!fl || !roomId) return [];
  return ((fl.devices) || []).filter((d) => d && d.roomId === roomId && d.entityId);
}

export function newFloor(name) {
  return Object.assign(
    { id: uid(), name: name || '一层', height: DEFAULT_FLOOR_H, display: newDisplay() },
    Object.fromEntries(FLOOR_LIST_KEYS.map((k) => [k, []])),
  );
}

/* 深拷贝整个楼层（楼层设置「复制楼层」）：墙体/房间/门窗/家具/设备/展示配置全量复制。
 * 拷贝件全部换新 id —— 同 id 会跨层串：itemGroups 就地变换按 id 定位、标签/拾取按
 * 设备组找、撤销快照按 id 合并。房间先换 id 建映射，设备/家具的 roomId、展示项的
 * eid（指向本层元素的）跟着映射换；指向 HA 实体的字段（entityId、场景/脚本 eid、
 * 天气实体）原样保留 —— 复制出的层绑定同一批实体，之后可在属性面板里单独改绑。 */
export function cloneFloor(fl, name) {
  const src = fl || {};
  const dst = newFloor(name || ((src.name || '层') + ' 副本'));
  dst.height = src.height || DEFAULT_FLOOR_H;
  if (src.wallOpacity != null) dst.wallOpacity = src.wallOpacity;
  const idMap = new Map();   // 旧元素 id → 新 id
  (src.rooms || []).forEach((r) => {
    if (!r || !r.id) return;
    const nr = JSON.parse(JSON.stringify(r));
    nr.id = uid();
    idMap.set(r.id, nr.id);
    dst.rooms.push(nr);
  });
  ['doors', 'windows', 'furniture', 'devices'].forEach((k) => {
    (src[k] || []).forEach((o) => {
      if (!o) return;
      const no = JSON.parse(JSON.stringify(o));
      if (no.id) { idMap.set(no.id, uid()); no.id = idMap.get(no.id); }
      else no.id = uid();
      if (no.roomId && idMap.has(no.roomId)) no.roomId = idMap.get(no.roomId);
      dst[k].push(no);
    });
  });
  dst.walls = JSON.parse(JSON.stringify(src.walls || []));   // 墙无实例 id，直接深拷贝
  if (src.display) {
    dst.display = JSON.parse(JSON.stringify(src.display));
    (dst.display.displayItems || []).forEach((it) => {
      if (it && it.eid && idMap.has(it.eid)) it.eid = idMap.get(it.eid);   // 实体类 eid 不在映射里，自然跳过
    });
  }
  return dst;
}

/* 项目 settings 的默认骨架（背景插件参数等仍存项目级，在此按需增删） */
export function newSettings() {
  return {};
}

/* ---------------- 保存快照: 自上而下重建（脏数据防线） ----------------
 * 每次保存都按当前 schema 重新拼一份新 JSON，只输出认识的字段，所以老版本残留在
 * 数据上的旧键（楼层 bgImage、settings 里的展示配置、家具实例抄的 type/name/w/d/h/color、
 * 设备上手填的 name…）永远不会被写回服务器。
 * 服务端只做校验、不参与清洗；以后加字段在这里补一行即可。 */

/* 单层墙包围盒（米）：无墙返回 null。w = 东西向(X)，d = 南北向(Y)。
 * 楼层间户型尺寸可能不一样，2D 长宽徽标 / 3D 背景构图都按「当前层」取。 */
export function floorFootprint(fl) {
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
export function maxFloorSize(p) {
  let w = 0, d = 0;
  ((p && p.floors) || []).forEach((fl) => {
    const f = floorFootprint(fl);
    if (f) { w = Math.max(w, f.w); d = Math.max(d, f.d); }
  });
  return (w > 0 && d > 0) ? { w, d } : null;
}

export function serializeProject(p) {
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
    if (S(o.style)) r.style = S(o.style);
    if (S(o.roomId)) r.roomId = S(o.roomId);                           // 归属房间（与设备/家具同一字段名）
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
    if (S(f.roomId)) r.roomId = S(f.roomId);                          // 所属房间（同设备口径）
    if (N(f.z) != null) r.z = N(f.z);
    if (N(f.pct) != null) r.pct = N(f.pct);
    if (N(f.scale) != null) r.scale = N(f.scale);
    if (S(f.model)) r.model = S(f.model);
    return r;
  };

  const devOut = (d) => {
    const r = { id: S(d.id), entityId: S(d.entityId), type: S(d.type), x: N(d.x) || 0, y: N(d.y) || 0 };
    if (S(d.roomId)) r.roomId = S(d.roomId);                          // 所属房间（老数据没有 = 未归属）
    if (N(d.rot) != null) r.rot = N(d.rot);
    if (N(d.z) != null) r.z = N(d.z);
    if (N(d.pct) != null) r.pct = N(d.pct);
    if (S(d.style)) r.style = S(d.style);
    if (N(d.labelOffset) != null) r.labelOffset = N(d.labelOffset);   // 实例级标签抬升覆盖
    if (d.click === true || d.click === false) r.click = d.click;   // 设备级点击控制覆盖
    if (S(d.clickSvc)) r.clickSvc = S(d.clickSvc);                  // 实例级点击动作（下拉选择，优先级最高）
    /* 卡片隐藏标记（DevOrderPanel 的「隐藏」）：只是个布尔，只在 true 时写。
     * 语义**只作用于卡片建树**（useCards 过滤插片），场景 2D/3D / 标签 / 点击全都不受影响。 */
    if (d.hideCard === true) r.hideCard = true;
    const so = optObj(d.styleOpts); if (so) r.styleOpts = so;
    copyFields(r, d);
    return r;
  };

  /* 楼层级展示配置（数据卡 + 展示项；天气实体在项目级 settings）。
   * displayItems 以配置列表为主表，逐项校验：普通项 eid 必须形如 domain.name；
   * kind='automation' 的居控中枢项是短码（无 domain. 前缀），按短码规则放行。
   * kind 只允许 ITEM_KINDS，可选 name / icon / svg / action 原样保留。
   * 旧的 displayScenes / quickDevices 不再写出（不做兼容迁移）。 */
  const itemOut = (it) => {
    const eid = S(it && it.eid);
    const k = S(it.kind);
    const isAuto = k === 'automation';
    if (!eid || (isAuto ? !/^[A-Za-z0-9_-]{1,64}$/.test(eid) : eid.indexOf('.') < 1)) return null;
    const o = { eid, kind: ITEM_KINDS.includes(k) ? k : 'entity' };
    if (S(it.name)) o.name = S(it.name);
    if (S(it.icon)) o.icon = S(it.icon);
    if (S(it.svg)) o.svg = S(it.svg);
    if (S(it.action)) o.action = S(it.action);
    return o;
  };
  const displayOut = (v) => {
    const d = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    return {
      dataCards: strList(d.dataCards),
      displayItems: (Array.isArray(d.displayItems) ? d.displayItems : [])
        .map(itemOut).filter(Boolean).slice(0, MAX_DISPLAY_ITEMS),
    };
  };

  /* 房间：几何 + 名字（可选颜色）+ 可选的温湿度实体绑定。面积/中心是派生值，不进存档；
   * 少于 3 点的残片直接丢弃，保证落盘的每个房间都可渲染、可拾取。
   * tempEntity/humidityEntity 是 HA 实体 id（房间 3D 标签的读数来源，与设备绑定无关），
   * 走 S() 归一化：未绑定 / 非字符串一律不落盘，旧存档没有这两个字段也正常。 */
  const roomOut = (r) => {
    const pts = (Array.isArray(r && r.pts) ? r.pts : [])
      .filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]))
      .map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
    if (pts.length < 3) return null;
    const o = { id: S(r.id), name: S(r.name) || '房间', pts };
    if (S(r.color)) o.color = S(r.color);
    if (S(r.tempEntity)) o.tempEntity = S(r.tempEntity);
    if (S(r.humidityEntity)) o.humidityEntity = S(r.humidityEntity);
    return o;
  };

  const floorOut = (fl) => ({
    id: S(fl.id),
    name: S(fl.name) || '一层',
    height: N(fl.height) || DEFAULT_FLOOR_H,
    wallOpacity: N(fl.wallOpacity) || 45,
    walls: (Array.isArray(fl.walls) ? fl.walls : []).map(wallOut),
    doors: (Array.isArray(fl.doors) ? fl.doors : []).map(openOut),
    windows: (Array.isArray(fl.windows) ? fl.windows : []).map(openOut),
    furniture: (Array.isArray(fl.furniture) ? fl.furniture : []).map(furnOut),
    devices: (Array.isArray(fl.devices) ? fl.devices : []).map(devOut),
    rooms: (Array.isArray(fl.rooms) ? fl.rooms : []).map(roomOut).filter(Boolean),
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
export async function fetchProject() {
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
        /* 展示项列表必须存在（不是兼容旧字段，只是补齐新结构的默认值） */
        if (!Array.isArray(fl.display.displayItems)) fl.display.displayItems = [];
        /* 与服务端 normProject 的 LIST_KEYS 同口径：老存档 / 异常结构缺任一列表键
         * 都补空数组（rooms 是后加的字段尤其常见），下游渲染与拾取不用判空。 */
        FLOOR_LIST_KEYS.forEach((k) => { if (!Array.isArray(fl[k])) fl[k] = []; });
      });
      return p;
    }
  } catch (e) { /* ignore */ }
  return null;
}

export function buildDefaultProject() {
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
export const FURN_ICON_W = 68, FURN_ICON_H = 46;
export const FURN_ICON_FALLBACK =
  '<rect x="12" y="10" width="44" height="26" rx="3" fill="none" stroke="#5d6b82" stroke-width="2.5"/>';

/* itemOrId: 形态对象（推荐，直接读 .icon）或形态 id / 固定类型名（目录里查一次） */
export function furnIcon(itemOrId, size) {
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
