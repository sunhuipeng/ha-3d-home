'use strict';
/*
 * 户型项目结构校验（审计 3.2 从 shared.js 剥离）。
 * shared.js 自称「基础层」，不该内嵌项目域校验规则——改校验规则只动本文件。
 *
 * 保存项目的结构校验 + 补骨架：拦住坏数据覆盖 project.json（一旦写坏，两个页面都起不来）。
 * 通过返回归一后的对象（楼层必要数组补空），不合法返回 null（调用端 400）。
 *
 * 元素级校验（浅白名单 + 数值有限性）：墙/门窗/家具/设备/房间逐个过检，
 * 坏元素**直接丢弃**（比整包 400 更耐脏 —— 前端一次保存拖进来一个脏元素，
 * 不该把整份项目卡在门外）。策略与前端 serializeProject 的输出形态一一对应：
 *   · 必填坐标用 Number() 宽松收数（"1.5" 也认），非有限值/越界才丢；
 *   · 字符串字段一律 String 收口 + 截断，防巨型垃圾入库；
 *   · 楼层层高/透明度收口到安全区间（与前端 DEFAULT_FLOOR_H / 滑杆范围对齐）。
 */

const MAX_LIST = 2000;        // 单楼层单类元素上限（正常户型远够，只挡灌垃圾）
const MAX_PTS = 500;          // 单房间顶点上限
const MAX_COORD = 10000;      // 坐标/尺寸上限（米）—— 1 万米外的家不属于这个项目
const MAX_STR = 128;          // 通用字符串字段截断

const sOf = (v, max) => (typeof v === 'string' ? v.slice(0, max || MAX_STR) : '');
/* 宽松收数：数字直接过，纯数值字符串转一下，其余（对象/数组/1e999）回 null */
const nOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() && v.length <= 32) { const x = Number(v); if (Number.isFinite(x)) return x; }
  return null;
};
const coord = (v) => { const x = nOf(v); return x != null && Math.abs(x) <= MAX_COORD ? x : null; };

/* 各类元素的「最低可渲染条件」：不满足即丢。其余字段（roomId/entityId/styleOpts
 * 及插件扩展 fields）放宽 —— 由前端序列化负责形态，这里只挡渲染热路径会炸的值。 */
const ELEM_CHECKS = {
  walls(w) {
    const x1 = coord(w.x1), y1 = coord(w.y1), x2 = coord(w.x2), y2 = coord(w.y2);
    if (!sOf(w.id) || x1 == null || y1 == null || x2 == null || y2 == null) return null;
    const t = coord(w.t);
    w.x1 = x1; w.y1 = y1; w.x2 = x2; w.y2 = y2;
    w.t = (t != null && t > 0 && t <= 2) ? t : 0.24;
    return w;
  },
  doors(o) { return checkOpening(o); },
  windows(o) { return checkOpening(o); },
  furniture(f) {
    if (!sOf(f.id) || !sOf(f.mid)) return null;
    const x = coord(f.x), y = coord(f.y), z = coord(f.z), rot = nOf(f.rot), sc = nOf(f.scale);
    if (x == null || y == null) return null;
    f.x = x; f.y = y;
    if (z != null) f.z = z; else delete f.z;
    f.rot = (rot != null && Math.abs(rot) <= 100000) ? rot : 0;
    if (sc != null && sc > 0 && sc <= 20) f.scale = sc; else delete f.scale;
    return f;
  },
  devices(d) {
    if (!sOf(d.id)) return null;
    const x = coord(d.x), y = coord(d.y), z = coord(d.z), rot = nOf(d.rot), lo = nOf(d.labelOffset);
    if (x == null || y == null) return null;
    d.type = sOf(d.type);
    d.x = x; d.y = y;
    if (z != null) d.z = z; else delete d.z;
    if (rot != null && Math.abs(rot) <= 100000) d.rot = rot; else delete d.rot;
    if (lo != null && Math.abs(lo) <= 10) d.labelOffset = lo; else delete d.labelOffset;
    return d;
  },
  rooms(r) {
    const pts = Array.isArray(r.pts) ? r.pts.slice(0, MAX_PTS)
      .map((p) => (Array.isArray(p) ? [coord(p[0]), coord(p[1])] : [null, null]))
      .filter((p) => p[0] != null && p[1] != null) : [];
    if (!sOf(r.id) || pts.length < 3) return null;
    r.pts = pts;
    r.name = sOf(r.name) || '房间';
    /* 房间 3D 温湿度标签的实体绑定（可选）。与前端 roomOut 同口径：只留字符串，
     * 非字符串/空串删除，避免异常类型落盘。语义上与设备绑定无关。 */
    ['tempEntity', 'humidityEntity'].forEach((k) => {
      const v = sOf(r[k]);
      if (v) r[k] = v; else delete r[k];
    });
    return r;
  },
};
/* 门/窗同构：id + 摆放（x/y/w/rot）是渲染最低条件；z 是窗离地（门恒 0 可缺省） */
function checkOpening(o) {
  if (!sOf(o.id)) return null;
  const x = coord(o.x), y = coord(o.y), w = coord(o.w), z = coord(o.z), rot = nOf(o.rot);
  if (x == null || y == null) return null;
  o.x = x; o.y = y;
  o.w = (w != null && w > 0 && w <= MAX_COORD) ? w : 1;
  o.rot = (rot != null && Math.abs(rot) <= 100000) ? rot : 0;
  if (z != null) o.z = z; else delete o.z;
  return o;
}

function normProject(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (!Array.isArray(p.floors) || !p.floors.length || p.floors.length > 50) return null;
  /* rooms = 2D 地面分区多边形（后加字段：老客户端不传时补空数组） */
  const LIST_KEYS = ['walls', 'doors', 'windows', 'furniture', 'devices', 'rooms'];
  let dropped = 0;
  const kept = [];
  for (const fl of p.floors) {
    if (!fl || typeof fl !== 'object' || Array.isArray(fl)) return null;
    if (typeof fl.name !== 'string' || !fl.name.trim()) return null;
    /* 楼层 id 是锚点 / 选中引用的主键：没有它这层就是孤儿，直接丢层 */
    if (!sOf(fl.id)) { dropped++; continue; }
    /* 楼层的展示配置（天气/数据卡/大屏场景）必须为对象，缺失时兜底空骨架 */
    if (fl.display == null) fl.display = {};
    if (typeof fl.display !== 'object' || Array.isArray(fl.display)) return null;
    /* 层高 / 2D 墙体透明度收口（与前端 DEFAULT_FLOOR_H=2.8、透明度滑杆 0..100 对齐） */
    const h = nOf(fl.height);
    fl.height = (h != null && h > 0 && h <= 20) ? h : 2.8;
    const wo = nOf(fl.wallOpacity);
    fl.wallOpacity = (wo != null && wo >= 0 && wo <= 100) ? wo : 45;
    for (const k of LIST_KEYS) {
      if (fl[k] == null) { fl[k] = []; continue; }   // 缺省补空数组，老版本客户端少字段也能存
      if (!Array.isArray(fl[k])) return null;
      if (fl[k].length > MAX_LIST) fl[k] = fl[k].slice(0, MAX_LIST);
      const check = ELEM_CHECKS[k];
      /* 逐元素过检：坏元素丢弃、好元素就地归一（数字收口），而不是整包拒绝 */
      const before = fl[k].length;
      fl[k] = fl[k].filter((x) => {
        if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
        return !!(check && check(x));
      });
      dropped += before - fl[k].length;
    }
    kept.push(fl);
  }
  p.floors = kept;
  /* 丢弃只记日志（生产静默），不阻断保存 —— 用户不该为一条脏墙线丢整份户型。
   * 调用时才 require（避免与 shared.js 顶层互 require 成环）。 */
  if (dropped) require('./shared').log('[normProject] 丢弃非法元素/楼层:', dropped);
  if (!p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings)) p.settings = {};
  if (typeof p.name !== 'string' || !p.name.trim()) p.name = '我的家';
  return p;
}

module.exports = { normProject, ELEM_CHECKS, checkOpening };
