/*
 * model/projectIO.js — 项目文件 IO 与示例户型（原 model/catalog.js 的序列化块）
 *
 * 审计 3.9：catalog.js 是「目录/枚举/纯函数」领域层，不该混装项目文件的
 * 序列化 / 读档 / 示例构造（约 250 行，边界含糊）。三者统一收敛到本文件：
 *   serializeProject    保存前白名单清洗（读 /api/project 的反向操作）
 *   fetchProject        读档 + settings 兜底 + 旧版 rot 单位迁移 + 列表键补齐
 *   buildDefaultProject 无存档时的示例户型兜底
 *
 * 与 catalog.js 的循环依赖说明：本文件 import catalog 的领域函数（newFloor /
 * newSettings / maxFloorSize 等），catalog 又 re-export 本文件三个名字以保持
 * window 桥接（engine/index.js 的 Object.assign(window, catalog)）与既有测试
 * 兼容 —— ESM 循环里双方都只在「函数调用期」互访，模块求值期无顶层互调，安全。
 *
 * PluginEngine 的探测保持原样：window.PluginEngine 存在性判断（Node 单测无桥接
 * 时退化为「未知键原样保留」的兜底分支），不能用 ESM import 判断 —— 那会让
 * 单测环境误入白名单分支丢字段。
 */
import { MAX_DISPLAY_ITEMS, ITEM_KINDS } from './displayAction.js';
import {
  DEFAULT_FLOOR_H, FLOOR_LIST_KEYS, newSettings, newDisplay,
  newFloor, uid, findFurniture, maxFloorSize,
} from './catalog.js';

export function serializeProject(p) {
  if (!p || !Array.isArray(p.floors) || !p.floors.length) return null;
  /* 保存前再归一一次：老存档里按样式分散的 backgroundFields 合并成插件级 key，
   * 保证写进 data/project.json 的始终是「一个插件一把 key」（fetchProject 读档时也会做）。 */
  if (window.PluginEngine && window.PluginEngine.migrateProjectBg && p.settings) {
    window.PluginEngine.migrateProjectBg(p.settings);
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
      if (window.PluginEngine && window.PluginEngine.migrateProjectBg) window.PluginEngine.migrateProjectBg(p.settings);
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
