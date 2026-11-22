/*
 * model/historySeries.js — 数据卡历史曲线的纯函数（不依赖 Vue / HA / DOM）
 *
 * HA 的 `history/period` WS 指令返回 [[{s,t}, ...]]：
 *   外层按实体分组（historyOf 只 filter 一个实体，取 [0]），
 *   内层按时间升序的每个采样点。s=state 字符串，t=ISO 时间戳。
 *
 * 两类实体值都要画：
 *   · 数值（sensor 温度/功率）→ 折线，y 轴是真实数值；
 *   · 枚举（heating/eco/off、sunny/cloudy 等）→ 阶梯线，y 轴是离散档位。
 * 三段（解析 → 模式判定/量程 → SVG 坐标映射）全是纯函数，可单测。
 */

export const HISTORY_HOURS = 24;
export const HISTORY_TTL_MS = 5 * 60 * 1000;

/* 原始解析：兼容三种 HA 返回 ——
 *   ① 现行 WS history/history_during_period：{ "<eid>": [{s,t},...] } 字典；
 *   ② 旧 WS history/period：{ result: [[{s,t},...]] } 二维数组；
 *   ③ 已解包的点数组。
 * 状态键兼容 s/state，时间键兼容 t/last_changed/lu。
 * 只丢空 state（画不出东西），unknown/unavailable 保留 —— 枚举模式下它们是有效状态。
 * 统一返回 [{t(ms), s(string)}]，按时间升序，不修改 HA 原始数据。 */
export function parseHistory(result) {
  let raw = result && Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result;
  /* 字典格式：取第一个值（historyOf 只查一个实体） */
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    const vals = Object.values(raw);
    raw = vals.length && Array.isArray(vals[0]) ? vals[0] : [];
  }
  let arr = Array.isArray(raw) ? raw : [];
  if (arr.length && Array.isArray(arr[0])) arr = arr[0];   // 二维 → 该实体的点数组
  const out = [];
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    const s = p.s !== undefined ? p.s : p.state;
    if (s == null || s === '') continue;
    const tsRaw = p.t !== undefined ? p.t : (p.last_changed !== undefined ? p.last_changed : p.lu);
    let t = NaN;
    if (typeof tsRaw === 'number') t = tsRaw < 1e11 ? tsRaw * 1000 : tsRaw;  // 秒 / 毫秒
    else if (typeof tsRaw === 'string') t = Date.parse(tsRaw);
    if (!Number.isFinite(t)) continue;
    out.push({ t, s: String(s) });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/* 模式判定：所有状态都能转有限数值 → 'number'（折线），否则 'enum'（阶梯线）。
 * 空序列归到 'number'，让调用方走同一个空态渲染。 */
export function seriesMode(raw) {
  if (!raw || !raw.length) return 'number';
  for (const p of raw) {
    const v = Number(p.s);
    if (p.s === '' || !Number.isFinite(v)) return 'enum';
  }
  return 'number';
}

/* 数值点：过滤 unknown/unavailable/非数，返回 [{t, v:number}] */
export function numericPoints(raw) {
  const out = [];
  for (const p of raw || []) {
    if (p.s === 'unknown' || p.s === 'unavailable') continue;
    const v = Number(p.s);
    if (Number.isFinite(v)) out.push({ t: p.t, v });
  }
  return out;
}

/* 枚举点：把每个不同状态映射到一个档位 level（首次出现顺序，index 0 = 最高档 = 最上），
 * 返回 { points:[{t,v:level,label}], levels:[{label,level}] }。
 * 压缩连续重复状态（同一状态连续采样只留首末，阶梯线更干净）。 */
export function enumPoints(raw) {
  const levels = [];
  const idx = new Map();
  const points = [];
  for (const p of raw || []) {
    if (!idx.has(p.s)) {
      idx.set(p.s, levels.length);
      levels.push({ label: p.s, level: levels.length });
    }
    const level = idx.get(p.s);
    const prev = points[points.length - 1];
    if (prev && prev.label === p.s) { prev.t = p.t; continue; }  // 连续同态：只更新结束时间
    points.push({ t: p.t, v: level, label: p.s });
  }
  return { points, levels };
}

/* 量程：数值上下各留 8% 余量；恒定值给 ±5%（绝对值 0 时用 ±1）避免除零。
 * 时间取首末点；空序列回退 { min:0,max:1 } 让调用方画不出线但不崩。
 * min/max = 绘图量程（带余量），rawMin/rawMax = 真实极值（只用于坐标标注）——
 * 两者分开：余量是为了线不贴边，标注要显示真实数据，否则用户对照 HA 原始记录对不上。 */
export function seriesBounds(points) {
  if (!points || !points.length) {
    return { min: 0, max: 1, rawMin: 0, rawMax: 1, t0: 0, t1: 0, span: 1, empty: true };
  }
  let min = Infinity, max = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
    if (p.t < t0) t0 = p.t;
    if (p.t > t1) t1 = p.t;
  }
  const rawMin = min, rawMax = max;
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad; max += pad;
  } else {
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;
  }
  return { min, max, rawMin, rawMax, t0, t1, span: max - min, empty: false };
}

/* 枚举模式的 y 档位：index 0 放最上，逐级往下。level 越大越靠上（与数值一致），
 * 所以直接给每档一个中心数值 level，交给 seriesBounds + mapPoints 即可。 */
export function enumBounds(levels) {
  if (!levels || !levels.length) return seriesBounds([]);
  return { min: -0.5, max: levels.length - 0.5, t0: 0, t1: 0, span: levels.length, empty: false };
}

/* 映射到 SVG viewBox 坐标（y 轴翻转：值越大 y 越小）。
 * 时间跨度可能为 0（只有一个点）→ 用 max(1) 兜底，点落在左边界。 */
export function mapPoints(points, b, w, h, pad) {
  const p = pad || 0;
  const spanT = Math.max(1, b.t1 - b.t0);
  const spanV = Math.max(1e-9, b.max - b.min);
  return points.map((pt) => [
    +(p + ((pt.t - b.t0) / spanT) * (w - 2 * p)).toFixed(2),
    +(h - p - ((pt.v - b.min) / spanV) * (h - 2 * p)).toFixed(2),
  ]);
}

/* 阶梯折线的点串：在相邻两点之间插入「水平到下一个时间点、再垂直跳到新档」的拐点，
 * 用一条 polyline 画出方波效果（枚举状态不变时不斜着爬坡）。 */
export function stepPoints(points, b, w, h, pad) {
  const xy = mapPoints(points, b, w, h, pad);
  if (xy.length < 2) return xy.map((p) => p[0] + ',' + p[1]).join(' ');
  const parts = [xy[0][0] + ',' + xy[0][1]];
  for (let i = 1; i < xy.length; i++) {
    parts.push(xy[i][0] + ',' + xy[i - 1][1]);   // 水平：保持上一档到当前时间
    parts.push(xy[i][0] + ',' + xy[i][1]);       // 垂直：跳到新档
  }
  return parts.join(' ');
}

/* 时间轴短标签 HH:MM（本地时区，与浏览器一致） */
export function formatClock(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 图表横轴两端标签：同一天只给时钟；跨相邻天加「昨 / 今」（否则 11:10→10:58
   看着像时间倒流，其实是 24h 窗口跨了零点）；跨多天给出月-日。 */
export function formatAxisTimes(t0, t1) {
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return ['', ''];
  const d0 = new Date(t0), d1 = new Date(t1);
  const hm = (d) => formatClock(d.getTime());
  /* 用本地年月日归一到 UTC 算天差，避开夏令时导致的 23/25 小时 */
  const day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((day(d1) - day(d0)) / 86400000);
  if (diff === 0) return [hm(d0), hm(d1)];
  if (diff === 1) return ['昨 ' + hm(d0), '今 ' + hm(d1)];
  const md = (d) => (d.getMonth() + 1) + '-' + d.getDate();
  return [md(d0) + ' ' + hm(d0), md(d1) + ' ' + hm(d1)];
}
