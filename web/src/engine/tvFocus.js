/*
 * engine/tvFocus.js — TV / 遥控器焦点导航（大屏展示页专用）
 *
 * 模型（2026-11-17 重写为「四区域 + 区域内真实方向导航」）：
 * 页面划成四个区域（与截图一致），方向键先在「当前区域内」按真实方向移动；
 * 走到区域边界才切到相邻区域。
 *
 *   区域 0 左上信息 .p-head .ph-id / .p-hud   —— 房子图标 / 实时数据卡
 *   区域 1 右上工具 .p-head .ph-tools         —— 旋转 / 标签 / 夜间 / 全屏
 *   区域 2 右侧面板 .p-scenes/.p-rooms/.p-cards —— 场景 / 房间 / 卡片（最大）
 *   区域 3 左下楼层 .p-floors                 —— 一层 / 二层
 *
 * 区域内键位（关键：方向键有真实方向语义，不是线性序列的前后）：
 *   - 右键：同行向右一个；到行尾折到下一行行首 → 于是「一直按右键」能从
 *     左到右、从上到下走完整块区域（用户的比喻）。左键反向，到行首折上一行行尾。
 *   - 下键：在当前区域内找「正下方最近」的元素（几何：主轴向下 + 水平重叠优先），
 *     所以从设备卡右上角「关机」按下键会命中正下方的「设定温度」滑杆，不会跳过。
 *     上键对称。
 *   - 该方向本区已无候选（到达区域边界）才按 ZONE_LINKS 邻接表切到位置相邻的区域；
 *     没有相邻区就原地停住。切区落点走阅读顺序：右/下→目标区第一行第一个，左/上→最后一行最后一个。
 *
 * 不再使用旧的几何最近邻全局评分 / domDistance 分层：那是反复跨区乱跳、跳过滑杆
 * 的根源——设定温度滑杆本身没被禁用，是被分层筛选淘汰的。区域约束已替代「分组」，
 * 不需要再按 DOM 距离猜同组。
 *
 * 键源三条，全部收敛到 handle()：
 *   1) app 壳子的遥控键：Java onKeyDown → evaluateJavascript → window.__tvFocus.key(name)
 *      （MainActivity 转发 DPAD/确认键；BACK/HOME/设置键在 Java 侧有默认实现，不经这里）
 *   2) PC 键盘方向键：仅激活时监听（宽屏 + App 壳，或宽屏 + URL 带 ?tv=1）
 *   3) 触摸/鼠标：pointerdown 即清除焦点环，两种输入方式互不打架
 *
 * 激活条件（2026-11-17 收紧）：必须宽屏（innerWidth>=WIDE_BREAKPOINT），且满足
 * ① App 壳内（遥控键经壳转发）或 ② 浏览器 URL 带 tv=1（桌面调试后门）；其余一律不启用。
 *
 * 与 useTap.js 的兼容：确认键走 el.click()，detail===0 的原生路径，宽屏不进手势
 * 状态机（见 useTap createState.onDown），不会被吞。
 *
 * 滑杆（CardRange）：焦点落在 data-tv-role="slider" 上时，左右键不做寻焦，而是向
 * 元素派发合成的 ArrowLeft/ArrowRight keydown+keyup —— 完全复用组件自己的步进与
 * 提交逻辑。想离开滑杆用上/下键即可（上下键走真实方向寻焦）。
 *
 * 动态元素：卡片随 HA 状态/楼层重建。不做缓存、不挂 MutationObserver，每次按键
 * 实时 querySelectorAll + 可见性过滤（百来个元素的开销可忽略）；焦点元素若被
 * 重建移除，下一次按键自动回落到「离视口中心最近」的元素。
 */

import { WIDE_BREAKPOINT } from '../model/stageLayout.js';

const FOCUS_CLASS = 'tv-focus';
const SEL = '.tv-clickable';

/* 四个区域，顺序仅用于 stable 编号；走出区域后去哪里由下面的 ZONE_LINKS 决定。
 * sel 用 el.closest() 匹配元素的所属容器，一律用各容器上的唯一 id（不用 class）：
 * 切层会重建卡片区（:key="cardKey"）与场景/房间条（v-if），class 可能随状态增减，
 * id 稳定挂在常驻容器上，重建不会让区域归类失效。命中多个时以数组靠前者为准。 */
const ZONES = [
  { name: '左上信息', sel: '#tv-zone-home, #tv-zone-hud' },
  { name: '右上工具', sel: '#tv-zone-tools' },
  { name: '右侧面板', sel: '#tv-zone-scenes, #tv-zone-rooms, #tv-zone-cards' },
  /* vert:true = 竖排单列区域：左右键不在区内折行/同行移动，直接走跨区切换。
   * 楼层按钮间距 26+2=28px 恰好等于 ROW_TOL，rowsOf 可能把它们归成同一行，
   * 靠行数/列数猜会失效；用显式标记最可靠。上下键仍走区内 pickVertical（一层↔二层）。 */
  { name: '左下楼层', sel: '#tv-zone-floors', vert: true },
];
const OTHER_ZONE = '其他';

/* 区域邻接表：按屏幕位置，到边界后沿该方向切到哪个区（用户 2026-11-17 定义）。
 * 未列出的方向 = 该边没有相邻区 → 停在边界不动。
 *   左上(0) --右--> 右上(1)   --下--> 楼层(3)
 *   右上(1) --左--> 左上(0)   --右--> 面板(2)
 *   面板(2) --左--> 右上(1)   --右--> 楼层(3)
 *   楼层(3) --右--> 面板(2)   --上--> 左上(0)
 * 注意「面板右→楼层」「楼层右→面板」不互为反向，是用户的真实走法（绕屏一圈）。 */
const ZONE_LINKS = [
  { right: 1, down: 3 },  // 0 左上信息
  { left: 0, right: 2 },  // 1 右上工具
  { left: 1, right: 3 },  // 2 右侧面板
  { right: 2, up: 0 },    // 3 左下楼层
];
/* 阅读顺序分行容差（px）：top 差在容差内算同一行，行内按 left 排 */
const ROW_TOL = 28;
/* 上下寻焦的正交惩罚权重：水平间隙越大越不优先（重叠记 0） */
const ORTH_WEIGHT = 3;
/* 方向判定的最小主轴间距（px）：重叠元素不算「在某个方向上」 */
const MIN_AXIS = 4;

let cur = null;        // 当前焦点元素
let curZoneId = -1;    // 当前焦点所在区域；元素被重建销毁后据此回落，保住邻接关系
let lastZones = [];    // 最近一次按键的区域快照（调试用）
let inited = false;
let _debugTimer = 0;   // debug 覆盖层的 setInterval 句柄（审计 3.7：dispose 成对清除）

/** 监听器卸载出口（审计 3.7）：与 initTvFocus 成对；焦点状态随之复位。
 * MPA 页面级常驻无实害，HMR / 未来 SPA 化会叠加 keydown/pointerdown 监听。 */
export function disposeTvFocus() {
  if (!inited || typeof document === 'undefined') return;
  inited = false;
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('pointerdown', clear, true);
  if (_debugTimer) { window.clearInterval(_debugTimer); _debugTimer = 0; }
}

/** TV 模式判定：app 壳内（存在 AppShell 原生桥）或桌面调试 ?tv=1 */
function active() {
  if (typeof window === 'undefined') return false;
  /* 两条件都要求宽屏：窄屏一律走普通触摸，不启用遥控导航 */
  if (window.innerWidth < WIDE_BREAKPOINT) return false;
  /* 入口① App 壳内（遥控键经壳转发）；入口② 浏览器 URL 带 tv=1（桌面调试后门） */
  if (window.AppShell) return true;
  try { return window.location.search.indexOf('tv=1') >= 0; } catch (_) { return false; }
}

/* loose=true 时跳过视口边界判定（只用于「焦点已在此元素上，必须能从它继续导航」的场景）。
 * TV WebView 里 100dvh 与 window.innerHeight 可能不一致，底部锚定的楼层按钮会被严格视口
 * 判定误杀，进而 collect() 收不到楼层区 → 邻接表里所有指向区 3 的切换静默失败。 */
function visible(el, loose) {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = window.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  if (cs.pointerEvents === 'none') return false;
  if (!loose) {
    /* 视口基准取 inner* 与 documentElement.client* 的较大者并留边缘容差，兼容 dvh/innerHeight 差异 */
    const de = document.documentElement;
    const vw = Math.max(window.innerWidth || 0, de ? de.clientWidth : 0);
    const vh = Math.max(window.innerHeight || 0, de ? de.clientHeight : 0);
    const M = 40;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < -M || cy < -M || cx > vw + M || cy > vh + M) return false;
  }
  /* 禁用态不参与：disabled 按钮、aria-disabled（CardRange 的 .dis 滑杆） */
  if (el.disabled === true) return false;
  if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
  return true;
}

function collect() {
  if (!document.querySelectorAll) return [];
  return Array.prototype.filter.call(document.querySelectorAll(SEL), visible);
}

function clear() {
  if (cur) {
    cur.classList.remove(FOCUS_CLASS);
    cur = null;
  }
}

function focusEl(el) {
  clear();
  cur = el;
  curZoneId = zoneOf(el);
  el.classList.add(FOCUS_CLASS);
  /* 焦点在滚动容器（卡片面板）外时滚进去；instant 而非 smooth——遥控连发不能等动画 */
  try { el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); }
  catch (_) { try { el.scrollIntoView(false); } catch (_2) { /* 极老内核忽略 */ } }
}

/** 区域首选入口：右/下→阅读顺序第一行第一个，左/上→最后一行最后一个 */
function zoneEntry(zone, dir) {
  if (!zone || !zone.rows.length) return null;
  if (dir === 'right' || dir === 'down' || dir == null) return zone.rows[0].items[0];
  const last = zone.rows[zone.rows.length - 1].items;
  return last[last.length - 1];
}

/** 跨区兜底：buildZones() 可能因元素时序 / 可见性漏掉某个区（尤其是楼层区），
 *  这时从该区的容器直接查 .tv-clickable，保证邻接表指向的目标一定进得去。
 *  没有这一步时「家按下 / 面板按右 → 楼层」会静默失败（dest 为空直接 return）。 */
function zoneFromDom(zid, dir) {
  if (zid < 0 || zid >= ZONES.length || !document.querySelectorAll) return null;
  const sels = ZONES[zid].sel.split(',').map((s) => s.trim());
  for (const sel of sels) {
    let root = null;
    try { root = document.querySelector(sel); } catch (_) { continue; }
    if (!root || !root.querySelectorAll) continue;
    let list = Array.prototype.filter.call(root.querySelectorAll(SEL), visible);
    /* 切层后容器可能瞬时滚出严格视口；用宽松判定兜底，focusEl 的 scrollIntoView 会把它拉回来 */
    if (!list.length) list = Array.prototype.filter.call(root.querySelectorAll(SEL), (el) => visible(el, true));
    if (!list.length) continue;
    return zoneEntry({ rows: rowsOf(list) }, dir);
  }
  return null;
}

/** 焦点丢失后的回落。切层会重建卡片区（:key="cardKey"），若旧焦点已被销毁，
 *  按视口中心就近（focusFirst）会跳到不相干的区域，看着像邻接关系乱了。
 *  改为优先回到「上次所在区域」的入口，保住用户的区域上下文；该区不存在才退回中心。 */
function refocus(dir) {
  const list = collect();
  if (!list.length) { clear(); return; }
  if (curZoneId >= 0) {
    const zones = buildZones(list);
    const zone = zones.filter((z) => z.zoneId === curZoneId)[0];
    const entry = zoneEntry(zone, dir) || zoneFromDom(curZoneId, dir);
    if (entry) { focusEl(entry); return; }
  }
  focusFirst();
}

/** 首次按键（无历史焦点）：挑离视口中心最近的元素 */
function focusFirst() {
  const list = collect();
  if (!list.length) return;
  const vw = window.innerWidth / 2, vh = window.innerHeight / 2;
  let best = null, bestD = Infinity;
  list.forEach((el) => {
    const r = el.getBoundingClientRect();
    const dx = r.left + r.width / 2 - vw;
    const dy = r.top + r.height / 2 - vh;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = el; }
  });
  if (best) focusEl(best);
}

/** 元素所属区域下标；不在任何已知区域归到「其他」（排在最后） */
function zoneOf(el) {
  for (let i = 0; i < ZONES.length; i++) {
    try { if (el.closest(ZONES[i].sel)) return i; } catch (_) { /* 老内核选择器不支持 */ }
  }
  return ZONES.length;
}

/** 把元素按 top 分行（容差内同行），行内 left 从左到右，行间从上到下 */
function rowsOf(els) {
  const items = els.map((el) => {
    const r = el.getBoundingClientRect();
    return { el, top: r.top, left: r.left };
  }).sort((a, b) => a.top - b.top || a.left - b.left);
  const rows = [];
  items.forEach((it) => {
    const row = rows[rows.length - 1];
    if (row && Math.abs(it.top - row.top) <= ROW_TOL) row.items.push(it.el);
    else rows.push({ top: it.top, items: [it.el] });
  });
  rows.forEach((row) => row.items.sort((a, b) => {
    return a.getBoundingClientRect().left - b.getBoundingClientRect().left;
  }));
  return rows;
}

/** 把可见元素按区域分组，每组带上分行结构；空区域跳过，保留区域顺序 */
function buildZones(list) {
  const buckets = [];
  list.forEach((el) => {
    const z = zoneOf(el);
    if (!buckets[z]) buckets[z] = [];
    buckets[z].push(el);
  });
  const zones = [];
  for (let z = 0; z <= ZONES.length; z++) {
    if (buckets[z] && buckets[z].length) {
      const rows = rowsOf(buckets[z]);
      zones.push({
        zoneId: z,   // 保留逻辑区编号：空区被跳过时数组下标会错位，不能拿它查邻接表
        name: z === ZONES.length ? OTHER_ZONE : ZONES[z].name,
        els: buckets[z],
        rows,
      });
    }
  }
  return zones;
}

/** 上下寻焦：在给定元素池里找主轴方向最近、且水平重叠优先的候选（同区内部用） */
function pickVertical(from, pool, dir) {
  const r0 = from.getBoundingClientRect();
  const sign = dir === 'down' ? 1 : -1;
  let best = null, bestScore = Infinity;
  pool.forEach((el) => {
    if (el === from) return;
    const r = el.getBoundingClientRect();
    const dy = (r.top + r.height / 2 - (r0.top + r0.height / 2)) * sign;
    if (dy <= MIN_AXIS) return;                       // 不在目标方向上
    /* 水平区间间隙：重叠记 0，分离记边到边距离 */
    const orth = Math.max(0, Math.max(r0.left, r.left) - Math.min(r0.right, r.right));
    const score = dy + orth * ORTH_WEIGHT;
    if (score < bestScore) { bestScore = score; best = el; }
  });
  return best;
}

function labelOf(el) {
  return (el.innerText || el.title || el.tagName || '').trim().replace(/\s+/g, ' ').slice(0, 12);
}

/** 方向寻焦：先在本区按真实方向找；到边界再按区域顺序切到相邻区 */
function move(dir) {
  let list = collect();
  if (!list.length) { clear(); return; }
  /* 焦点元素被销毁（切层重建卡片区 :key="cardKey"）时，先回落到原区入口，然后
   * ★继续用同一个方向寻焦★——不能像以前那样 refocus 后直接 return 吞掉这次按键：
   * 用户那时正想「从面板按右键切楼层」，却被吞成「焦点回到面板入口」，下一帧还得重按。
   * 回落后 cur 已在原区入口，下面照常走区内/跨区逻辑，这一次方向键就能切出去。 */
  if (!cur || !cur.isConnected) {
    refocus(dir);
    if (!cur || !cur.isConnected) return;   // 回落也失败（区已不存在）才作罢
    list = collect();
  }
  /* 当前焦点虽被严格视口判定过滤（dvh/innerHeight 差异），只要它还连着 DOM 就用宽松判定
   * 把它补回候选集——否则 found 不到自己所在区，直接 focusFirst 乱跳。 */
  if (list.indexOf(cur) < 0 && visible(cur, true)) list.push(cur);

  const zones = buildZones(list);
  lastZones = zones.map((z) => ({ id: z.zoneId, name: z.name, rows: z.rows.map((r) => r.items.map(labelOf)) }));
  if (!zones.length) { clear(); return; }

  let zi = -1;
  for (let z = 0; z < zones.length; z++) {
    if (zones[z].els.indexOf(cur) >= 0) { zi = z; break; }
  }
  if (zi < 0) { focusFirst(); return; }

  const zone = zones[zi];
  const zid = zone.zoneId;                 // 逻辑区编号（数组下标 zi 在空区跳过时会错位）
  const link = zid < ZONE_LINKS.length ? ZONE_LINKS[zid] : null;
  const forward = (dir === 'right' || dir === 'down');
  const horiz = (dir === 'left' || dir === 'right');

  /* ---- 1. 区域内按真实方向找候选 ---- */
  let target = null;
  if (horiz) {
    /* 左右：同行移动；到行尾折到相邻行（右键→下一行行首，左键→上一行行尾）。
     * ⚠ 竖排单列区域（如楼层 .p-floors，每个按钮各占一行）例外：此时「折到下一行」
     *   等价于「跳到下一层」，会把左右键永远困在本区，走不到 ZONE_LINKS 的跨区目标。
     *   所以单列区域左右键直接走跨区（下方 target 保持 null → 落到第 2 步）。
     *   这也是「切层后楼层区不可达」的真因之一：焦点正停在刚点的楼层按钮上，
     *   按右键本应切面板，却被折行拦到下一层。 */
    const rows = zone.rows;
    /* 显式 vert 标记优先；rows 判断作为其它区域的兜底（间距 != ROW_TOL 时可用） */
    const singleColumn = !!(zid >= 0 && zid < ZONES.length && ZONES[zid].vert)
      || (rows.length > 0 && rows.every((r) => r.items.length === 1));
    if (!singleColumn) {
      let ri = -1, ci = -1;
      for (let i = 0; i < rows.length; i++) {
        const k = rows[i].items.indexOf(cur);
        if (k >= 0) { ri = i; ci = k; break; }
      }
      if (ri >= 0) {
        if (dir === 'right') {
          if (ci + 1 < rows[ri].items.length) target = rows[ri].items[ci + 1];
          else if (ri + 1 < rows.length) target = rows[ri + 1].items[0];
        } else {
          if (ci - 1 >= 0) target = rows[ri].items[ci - 1];
          else if (ri - 1 >= 0) {
            const prev = rows[ri - 1].items;
            target = prev[prev.length - 1];
          }
        }
      }
    }
    /* 横向兜底仅在「非单列区域 + 本方向本区根本没有相邻区」时才做：
     * 区内找不到同行/相邻行就停住；单列区域或无跨区目标的区域不在这里向下找，
     * 否则会先跳到同列下一层，切不出去。 */
    if (!target && !singleColumn && (!link || link[dir] === undefined)) {
      target = pickVertical(cur, zone.els, dir === 'right' ? 'down' : 'up');
    }
  } else {
    /* 上下：真几何向下/向上，命中正下方/正上方最近的元素（如设定温度滑杆） */
    target = pickVertical(cur, zone.els, dir);
  }
  if (target) { focusEl(target); return; }

  /* ---- 2. 本区该方向已到边界：按邻接表切到位置相邻的区域 ---- */
  const next = link ? link[dir] : undefined;
  if (next === undefined) return;                 // 该边没有相邻区：停在边界
  /* 入口按阅读顺序：右/下→第一行第一个，左/上→最后一行最后一个。
   * 例：工具右→面板落在第一行第一个「测试」；楼层右→面板同样落「测试」；
   *     面板左→工具落工具行最后一个；家下→楼层落第一层（第一行第一个）。
   * buildZones 没收录目标区时（楼层按钮被视口判定过滤）用 zoneFromDom 直接从容器取兜底。 */
  const dest = zones.filter((z) => z.zoneId === next)[0];
  const entry = (dest && dest.rows.length ? zoneEntry(dest, dir) : null)
    || zoneFromDom(next, dir);
  if (entry) focusEl(entry);
}

/** 确认键：原生 click（detail=0 宽屏路径，v-tap 不拦截） */
function confirm() {
  if (cur && cur.isConnected) {
    try { cur.click(); } catch (_) { /* 忽略 */ }
  }
}

/** 焦点在滑杆上时，左右键转成组件自己的键盘步进（keydown + keyup 触发提交） */
function sliderStep(key) {
  if (!cur || !cur.isConnected) return;
  try {
    const opts = { key, bubbles: true, cancelable: true };
    cur.dispatchEvent(new KeyboardEvent('keydown', opts));
    cur.dispatchEvent(new KeyboardEvent('keyup', opts));
  } catch (_) { /* 极老内核无 KeyboardEvent 构造器则忽略 */ }
}

/* 最近按键轨迹（诊断用）：记录每次方向键前后的焦点，右上角浮层实时显示 */
const keyTrace = [];
function trace(before, after, dir) {
  if (!debugEnabled()) return;   // 仅 debug=1 时记录，默认零开销
  keyTrace.push(`${dir}: ${before}→${after}`);
  if (keyTrace.length > 6) keyTrace.shift();
}

/** 遥控/键盘统一入口。name: up/down/left/right/ok。返回是否已消费。 */
function handle(name) {
  if (!active()) return false;
  const before = cur ? labelOf(cur) : '-';
  if (name === 'ok') {
    if (!cur || !cur.isConnected || !visible(cur, true)) refocus(null);
    confirm();
    return true;
  }
  /* 滑杆焦点 + 左右键 = 步进，不寻焦（离开滑杆用上/下键） */
  if ((name === 'left' || name === 'right') && cur && cur.isConnected
    && cur.getAttribute && cur.getAttribute('data-tv-role') === 'slider') {
    sliderStep(name === 'left' ? 'ArrowLeft' : 'ArrowRight');
    trace(before, cur ? labelOf(cur) : '-', name + '(slider)');
    return true;
  }
  move(name);
  trace(before, cur ? labelOf(cur) : '-', name);
  updateDebugOverlay();
  return true;
}

/* ---- 页面内诊断浮层：URL 带 debug=1 时在右上角显示焦点状态（默认关闭，不影响生产大屏） ----
 * 用途：真机/浏览器里不方便开控制台时，切层后直接截图即可看到焦点落在哪个区、
 * 四个区域各自的候选数，以及最近几次按键的焦点轨迹，用于定位「进不去楼层」卡在哪一步。 */
let dbgEl = null;
function debugEnabled() {
  try { return /(?:\\?|&)debug=1(?:&|$)/.test(window.location.search); } catch (_) { return false; }
}
function updateDebugOverlay() {
  if (!debugEnabled()) return;
  if (typeof document === 'undefined' || !document.body) return;
  if (!dbgEl) {
    dbgEl = document.createElement('div');
    dbgEl.id = 'tv-focus-debug';
    dbgEl.style.cssText = 'position:fixed;top:4px;right:4px;z-index:99999;max-width:52vw;'
      + 'padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.82);color:#7f7;'
      + 'font:11px/1.4 monospace;white-space:pre-wrap;pointer-events:none;';
    document.body.appendChild(dbgEl);
  }
  const d = window.__tvFocus && window.__tvFocus.debug ? window.__tvFocus.debug() : null;
  if (!d) return;
  const lines = [
    `focus=${d.focus} zone=${d.focusZoneId} conn=${d.focusConnected}`,
    `vis=${d.focusVisible ? (d.focusVisible.strict ? 'S' : '-') + (d.focusVisible.loose ? 'L' : '-') : '-'} curZone=${d.curZoneId}`,
  ];
  (d.counts || []).forEach((c) => lines.push(`${c.name}: ${c.strict}/${c.loose}`));
  if (keyTrace.length) lines.push('--trace--', ...keyTrace);
  dbgEl.textContent = lines.join('\n');
}

/** debug=1 时定时刷新（切层重建卡片后 DOM 变化不经过按键，也要能反映出来） */
function startDebugOverlay() {
  if (typeof window === 'undefined' || !debugEnabled()) return;
  updateDebugOverlay();
  /* 审计 3.7：记录句柄，disposeTvFocus() 成对清除（此前 interval 永不停止） */
  _debugTimer = window.setInterval(updateDebugOverlay, 600);
}

function onKeyDown(e) {
  if (!active()) return;
  const t = e.target;
  /* 正在输入/操作原生控件时交还给浏览器：select 展开态、文本输入、以及滑杆自己的
   * 键盘处理（PC 键盘直接 focus 到滑杆时事件原生到达，避免这里再合成一次造成双步进） */
  if (t && t.matches && t.matches('input, textarea, select, [data-tv-role="slider"]')) return;
  const map = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Enter: 'ok', ' ': 'ok',
  };
  const name = map[e.key];
  if (!name) return;
  e.preventDefault();
  handle(name);
}

/** 大屏页挂载后调用一次；幂等。 */
export function initTvFocus() {
  if (inited || typeof document === 'undefined') return;
  inited = true;
  document.addEventListener('keydown', onKeyDown);
  /* 触摸/鼠标按下即放弃焦点环（capture 先于 v-tap 等业务 handler） */
  document.addEventListener('pointerdown', clear, true);
  startDebugOverlay();
  /* Java 壳子经 evaluateJavascript 调这里；挂到 window 供壳与调试台使用 */
  window.__tvFocus = {
    key: handle, clear, focusFirst,
    /* 调试：当前焦点 + 四区各自的分行（真机可在控制台输出）
     * 用法：__tvFocus.debug() → { focus, zones: [{name, rows:[...]}] } */
    debug: () => ({
      focus: cur ? labelOf(cur) : null,
      focusZoneId: cur ? zoneOf(cur) : -1,
      focusConnected: cur ? !!cur.isConnected : false,
      focusVisible: cur ? { strict: visible(cur), loose: visible(cur, true) } : null,
      curZoneId,
      zones: lastZones,
      /* 每个区域候选元素的实时数量（含「严格可见」与「宽松可见」两种口径），
       * 用来定位「家下/面板右进不去楼层」：若楼层区 strict=0 loose>0，
       * 说明是视口判定把楼层按钮过滤了；若两者都 0，说明 collect 收不到楼层按钮。 */
      counts: ZONES.map((z) => {
        let root = null;
        try { root = document.querySelector(z.sel.split(',')[0].trim()); } catch (_) { /* 忽略 */ }
        if (!root || !root.querySelectorAll) return { name: z.name, strict: 0, loose: 0 };
        const els = Array.prototype.slice.call(root.querySelectorAll(SEL));
        return {
          name: z.name,
          strict: els.filter((el) => visible(el)).length,
          loose: els.filter((el) => visible(el, true)).length,
        };
      }),
    }),
  };
}
