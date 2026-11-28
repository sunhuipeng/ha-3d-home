/*
 * engine/cards.js — 极简声明式卡片引擎（service 层）
 *
 * 与 plugins.js 同属引擎层：不 import Vue / THREE / Pinia / HA 实例，
 * 由 engine/index.js 统一把 CardEngine 挂到 window 供经典脚本插件与外部脚本使用；
 * 页面侧（composables/useCards.js）直接 ESM import 同一份实例，不走全局。
 *
 * ── 设计原则：引擎零 HA 知识 ────────────────────────────────────────────
 * 插件只声明「有哪些控件、绑哪个 key、点下去发什么服务」，所有 Home Assistant
 * 领域知识（哪个域有什么服务、参数叫什么、选项中文怎么写）都在插件里。
 * 引擎只维护三件事：
 *   1) type   → 用哪个 Vue 组件渲染（COMPONENTS / componentOf）
 *   2) action → 怎么拼 call_service（domain / service / service_data）
 *   3) rows / columns → 怎么排版（每个数组一行，总 4 列，单元素也按 columns 占位）
 *
 * 除此之外的通用规则（读值、key 解析、禁用态、option 解析）都是无领域知识的：
 *   · 有 attr → 读 entity.attributes[attr]；没 attr → 读 entity.state
 *   · key 省略 / 'entity' / 'entityId' → 主实体；带点 → 完整 entity_id；
 *     否则 → 按实例数据的字段取值（fields 绑定的扩展实体）
 *   · type 决定组件：label = 纯显示读数（CardReadonly）、button = 一次性动作（CardButton，
 *     必须配 action）。两者职责固定，引擎不按 action 隐式改派
 *   · 有 action → 可写；没 action → 纯显示（button 没 action 时按钮禁用）
 *   · 取不到 state / unavailable / unknown → 禁用
 *   · 插件没返回 cards()：可点击（有 click / 内置默认）→ 兜底一张单元素 switch 卡（复用插件 click）；
 *     纯展示类型（无可点）→ 不出卡
 *   · 插件写了 cards() 但控件全被过滤（字段一个没绑 / 实体没那些属性）→ 一个元素都没有时
 *     按「单元素」处理，退回同一张兜底卡（不出现空白子卡）
 *
 * ── 插件 cards(ctx) 的返回格式：只返回数组，不再用 type 区分 ──────────
 *   single → [ {…} ]                      一维数组、只有一个控件对象
 *   group  → [ [{…}], [{…}, {…}] ]       二维数组，每个子数组 = 一行
 *   一行多控件也可以偷懒写成一维数组 [ {…}, {…} ]（等价于只有一行的 group）
 * 没有 cards()：可点击 → 引擎兜底一张单元素 switch 卡（点击复用插件 click，见 defaultToggleCard）；
 * 不可点击（纯展示类型）→ 不出卡，由调用方过滤掉。
 *
 * **单元素平铺**：所有 single 卡会被容器层收集起来，与「其它插件返回的单个元素」
 * 统一合并成一个 grid 块、固定放在多控件子卡前面（不分出现顺序）。块内每位占几列
 * 由渲染层 CardDevices 按「本块元素数 + 各自 columns」统一算：整块只有 1 个 → 全宽；
 * 多个 → 显式 columns 优先，未配置的默认占 2 列（半行）。写 columns:1 一行最多 4 个、
 * 写 4 独占一行。
 *
 * 控件字段池（任何 type 都能带，引擎按 type 各取所需）：
 *   type     switch | bool | range | select | choice | label | button
 *            label  = 纯显示读数（CardReadonly），永远不响应点击，写 action 也无效
 *            button = 一次性动作按钮（CardButton），必须配 action
 *            choice = 选项组（CardChoice）：select 的按钮组形态 UI，
 *                     option/options/attr/action/param 语义与 select 完全一致，
 *                     点某个选项 = 把该值带上发服务（区别只是 UI 从下拉换成并排按钮）
 *   key      实体来源（默认 'entity' = 主实体）
 *   attr     读值路径；有则读 attributes[attr]，无则读 state
 *   action   服务名（button / switch / bool / range / select / choice 用它声明点击动作）。
 *            'toggle' = 域取实体前缀；'homeassistant.toggle' = 自带域；
 *            { on:'turn_on', off:'turn_off' } = 按当前态选；
 *            { domain, service, param } = 全显式。不写 = 不可点
 *            ⚠ label 上写 action 无效：要按钮必须显式写 type: 'button'
 *   param    service_data 的键名；缺省依次取 action.param → attr → 'value'
 *   domain   覆盖服务域（action 自带域时以 action 为准）
 *   data     固定附加的 service_data（如 { transition: 1 }）
 *   label / unit                 显示文案 / 单位（可写 'attr:unit_of_measurement'）
 *   columns  占 1~4 列。
 *            · 不写 → 一行直接平分（一行至少 1 个、最多 4 个控件，宽度均分；常见默认每行 2 个各占 2 列）。
 *            · 写 → 严格按指定宽度占列，优先于自动分配。
 *            · 一行里部分写、部分没写 → 写了的按指定宽度，剩下的列由没写的控件平分（每个至少 1 列）。
 *            · single 卡（与其它插件的单元素一起平铺）→ 不写时占列由渲染层按块决定
 *              （块内只有 1 个成全宽、多个默认 2 列）；写 1 = 一行最多 4 个，写 4 = 独占一行。
 *   min / max / step             range 边界。可写死，也可写 'attr:min' / 'attr:max' / 'attr:step'
 *                                从实体属性取（input_number 倒计时滑块就这么写），取不到回退 0 / 100 / 1
 *   option / options             select / choice 选项，4 种写法：[{value,label}] /
 *                               纯值数组 / 对象映射 / 'attr:hvac_modes'（详见 PLUGIN-DEV.md §2.9）；
 *                               label 控件仅在做枚举状态中文映射时才用它（少见）
 *   require  过滤条件，两种口径（先按字段判、再按属性判）：
 *            · 实例字段名（插件 fields 声明的 key，如 'powerEntity'）：**绑了才渲染**；
 *            · 实体属性名（如 'current_position'）：实体没有该属性就不渲染。
 *            用来避免「字段没绑 / 实体没这属性」时出一个点不动的假控件
 *   lock     true：只有「本控件所属设备开启」时才可操作。关机时控件仍渲染、仍显示值，
 *            但 decorate 把 _disabled 置 true → 组件给原生元素（input/select/button）
 *            加 disabled（不派发事件、不可聚焦），actionOf 也拒绝发服务。
 *            判定走 env.isOn(节点 _powerEid，即设备主实体) = HA.deviceIsOn → 插件顶层
 *            isOn，与标题电源开关同口径；⚠ 别标在开机入口（含 off 的模式组、电源 switch）上。
 *   is_on    true：只有「本控件所属设备开启」（插件 isOn 判定）时才渲染该控件；
 *            关机时整行隐藏（decorate 把节点过滤成 null，不是禁用）。判定与 lock 完全
 *            同一口径 env.isOn(节点 _powerEid) = HA.deviceIsOn → 插件顶层 isOn，
 *            且同样放在 decorate 值树里算 → 开关机瞬间即时显隐。缺省 false（不受限）。
 *            ⚠ 别把一张卡的所有控件都标 is_on，否则设备关着时整张卡只剩空标题。
 *   （开 / 关 电源开关不写在 cards() 里：它统一由渲染层画在设备标题右侧，
 *    完全复用插件自身的 isOn 与 click —— 见 CardPowerToggle / HA.toggle。
 *    显隐与 cards() 无关，只看 instanceClickSpec 是否非 null：插件 defaultOn:false
 *    或实例未勾选「点击控制」→ 标题开关不渲染。）
 * 字符串以 'attr:' 开头时，统一去实体 attributes 取值（拿得到 HA schema 就能自适应，
 * 拿不到时插件直接写静态值 / 静态中文选项，两种都能用）。
 */
const COLS = 4;
const TYPES = ['switch', 'bool', 'range', 'select', 'choice', 'label', 'button', 'image'];

/* type → 组件名，一一对应；渲染层（CardGroup / CardDevices）按名字取真实组件。
 * label 恒为只读、button 恒为按钮，渲染时不按 action 改派。
 * choice 与 select 同一套取值 / 带值契约，只是渲染成并排的一组选项（el-button-group）。 */
const COMPONENTS = {
  switch: 'CardToggle',
  bool: 'CardToggle',
  range: 'CardRange',
  select: 'CardSelect',
  choice: 'CardChoice',
  label: 'CardReadonly',
  button: 'CardButton',
  /* 图片（只读）：清扫地图这类 image 实体，读 attributes.entity_picture 显示。
   * 不响应点击、不发服务；URL 由渲染层拼 HA base（token 在 entity_picture 自带）。 */
  image: 'CardImage',
};

function domainOf(eid) { return eid ? String(eid).split('.')[0] : ''; }
/* 实体 id 的可读兜底名（'light.ke_fang' → 'ke fang'）。语义与 services/ha.js 的
 * HA.friendly 尾段回退一致（那边是唯一出处，这里不能 import HA 才本地复刻一份） */
function eidTailName(eid) { return eid ? String(eid).split('.').pop().replace(/_/g, ' ') : ''; }
function clampInt(v, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo; }
/* 任意值 → 数字（非有限数返回 null）。命名刻意区别于插件契约的 ctx.toNum
 * （审计 2.11：同名不同义 —— ctx.toNum 还排除 unknown/unavailable 字符串）。 */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toBool(v) {
  if (typeof v === 'string') return v === 'true' || v === 'on' || v === '1' || v === 'yes';
  return !!v;
}

/* require 判定：字段层优先，属性层次之。
 *   · 字符串是实例字段（插件 fields 声明的 key，值 = 绑定的实体 id）→ 看绑没绑；
 *     obj 上就算有这个 key，值空串 / null / false 也算没绑（属性面板清空后写的就是 ''）
 *   · 否则当实体属性名 → 实体暴露了该属性才通过
 * 两种口径都命中不了就丢弃这个控件（与 resolveKey 失败同一条路径，不是运行时报错）。 */
function requireOk(req, env, st) {
  if (!req) return true;
  const obj = env && env.obj;
  if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, req)) {
    const v = obj[req];
    return typeof v === 'string' ? v !== '' : (v != null && v !== false);
  }
  return !!(st && st.attributes && st.attributes[req] !== undefined);
}

/* key → entity_id。'entity' / 'entityId' 都是主实体（door/window 的 fields 键就叫 entityId） */
function resolveKey(key, env) {
  if (!key || key === 'entity' || key === 'entityId') return env.entityId || null;
  if (typeof key !== 'string') return null;
  if (key.indexOf('.') > 0) return key;
  const v = env.obj && env.obj[key];
  return typeof v === 'string' && v ? v : null;
}

/* 通用动态值：'attr:xxx' 去实体 attributes 取，取不到用 fallback */
function dyn(v, st, fallback) {
  if (typeof v === 'string' && v.indexOf('attr:') === 0) {
    const x = st && st.attributes ? st.attributes[v.slice(5)] : undefined;
    return x === undefined || x === null || x === '' ? fallback : x;
  }
  return v === undefined || v === null || v === '' ? fallback : v;
}

/* 插件声明 → { rows, solo }。只认数组：
 *   二维 = group（每个子数组一行）；一维 = 单行，且只有一个对象时是 single。
 * 宽容一个裸控件对象（等价 [obj]），避免插件写错时静默丢整张卡。 */
function toRows(raw) {
  if (!raw) return { rows: [], solo: false };
  if (!Array.isArray(raw)) {
    return { rows: [[raw]], solo: true };
  }
  if (!raw.length) return { rows: [], solo: false };
  if (Array.isArray(raw[0])) {
    return { rows: raw.filter(Array.isArray), solo: false };
  }
  return { rows: [raw], solo: raw.length === 1 };
}

/* 一行内的占列规则（总宽 4 列，渲染层用 grid-column: span N）：
 *   · 一行只有一个控件：没写 columns → 占满全宽 4；写了 → 按指定
 *   · 一行多个控件、全没写 → 直接平分（一行 1~4 个，常见默认每行 2 个各占 2 列）
 *   · 一行里部分写、部分没写 → 写了的按指定宽度，剩下的列由没写的控件平分（每个至少 1）
 * 单行总宽超过 4 列时由 CSS grid 自动折行，不会挤压控件。
 * 注意：这里只管 group（二维数组）的行内排版；single 卡会聚合成网格块，
 * 占列改由渲染层 CardDevices.spanOf 按「块内元素数 + columns」统一决定。 */
function layoutRow(row) {
  if (!row.length) return;
  if (row.length === 1) {
    row[0]._span = row[0]._explicit ? clampInt(row[0].columns, 1, COLS) : COLS;
    return;
  }
  const spans = row.map((c) => (c._explicit ? clampInt(c.columns, 1, COLS) : 0));
  const used = spans.reduce((a, b) => a + b, 0);
  const auto = [];
  spans.forEach((s, i) => { if (!s) auto.push(i); });
  if (!auto.length) { row.forEach((c, i) => { c._span = spans[i]; }); return; }
  const free = Math.max(auto.length, COLS - used);
  const each = Math.max(1, Math.floor(free / auto.length));
  auto.forEach((i, k) => { spans[i] = k === auto.length - 1 ? Math.max(1, free - each * (auto.length - 1)) : each; });
  row.forEach((c, i) => { c._span = spans[i]; });
}

const KEEP = ['type', 'key', 'attr', 'action', 'param', 'domain', 'data', 'label',
  'unit', 'min', 'max', 'step', 'option', 'options', 'require', 'columns', 'lock', 'is_on'];

function normalizeNode(spec, env) {
  if (!spec || typeof spec !== 'object' || TYPES.indexOf(spec.type) < 0) return null;
  const eid = resolveKey(spec.key, env);
  if (!eid) return null;                          // 绑不到实体 → 这个控件不渲染
  const st = env.getState ? env.getState(eid) : null;
  if (!requireOk(spec.require, env, st)) return null;
  /* lock 要判的是「设备主实体开没开」，不能用本控件的 _eid —— 它可能是 fields 绑的
   * 扩展实体（如湿度 sensor，永远判不出开态）。decorate 阶段的 env 只有
   * { getState, isOn }、没有 entityId，所以趁建树时把主实体 id 存进节点。 */
  const n = { _eid: eid, _powerEid: env.entityId || eid, _explicit: spec.columns !== undefined };
  KEEP.forEach((k) => { if (spec[k] !== undefined) n[k] = spec[k]; });
  n.columns = clampInt(n.columns, 1, COLS);
  /* button 没写 label 时用服务名兜底；label 是纯显示，不参与服务相关处理 */
  if (n.type === 'button' && !n.label) {
    const a = n.action;
    n.label = typeof a === 'string' ? a : ((a && (a.service || a.on)) || '执行');
  }
  return n;
}

/* 选项归一化：数组 [{value,label}] / 纯值数组 / 对象映射 / 'attr:xxx' */
function resolveOptions(raw, st) {
  let v = dyn(raw, st, []);
  if (typeof v === 'string') return [];
  if (!Array.isArray(v)) {
    if (!v || typeof v !== 'object') return [];
    v = Object.keys(v).map((k) => ({ value: k, label: v[k] }));
  }
  return v.map((o) => (o && typeof o === 'object'
    ? { value: o.value, label: o.label == null ? String(o.value) : String(o.label) }
    : { value: o, label: String(o) }));
}

function readValue(node, st) {
  if (!st) return null;
  if (node.attr) {
    const a = st.attributes || {};
    /* 属性没暴露时回退 state：climate 的 hvac_mode 常常只写在 state 上 */
    return a[node.attr] !== undefined ? a[node.attr] : st.state;
  }
  return st.state;
}

/* 递归装饰放在模块级函数里，避免外部解构 CardEngine.decorate 后 this 丢失 */
function decorateNode(node, env) {
  if (!node) return null;
  if (node.type === 'list') {
    return Object.assign({}, node, {
      blocks: (node.blocks || []).map((b) => (b.kind === 'grid'
        ? Object.assign({}, b, { items: (b.items || []).map((n) => decorateNode(n, env)).filter(Boolean) })
        : Object.assign({}, b, { card: decorateNode(b.card, env) }))),
    });
  }
  if (node.type === 'card') {
    const rows = (node.rows || []).map((r) => r.map((n) => decorateNode(n, env)).filter(Boolean));
    return Object.assign({}, node, { rows, flat: rows.reduce((a, r) => a.concat(r), []) });
  }

  const st = env && env.getState && node._eid ? env.getState(node._eid) : null;
  /* 原有禁用（实体取不到 / unavailable / unknown）恒生效；lock 只是附加条件：
   * OR 而不是替换 —— HA 掉线时不能反而放开控件。env.isOn 缺失时保守按「关」处理。
   * _powerEid 由 normalizeNode 注入（设备主实体），solo 平铺 / 浅拷贝都会带过来。 */
  const baseDisabled = !st || st.state === 'unavailable' || st.state === 'unknown';
  const powerEid = node._powerEid || node._eid;
  /* is_on：仅当设备主实体「开」（插件 isOn）时才渲染本控件，关机整行隐藏。
   * 与 lock 同用 env.isOn(powerEid) 主实体口径；返回 null 让上层 rows/items 的
   * .filter(Boolean) 丢掉节点。判定放在 decorate（值树随 HA 推送重算）而非建树，
   * 这样开关机瞬间即时显隐。env.isOn 缺失时保守按「关」→ 隐藏（与 lock 同策略）。 */
  if (toBool(node.is_on) && !(env && env.isOn && powerEid ? env.isOn(powerEid) : false)) return null;
  const locked = toBool(node.lock)
    && !(env && env.isOn && powerEid ? env.isOn(powerEid) : false);
  const out = Object.assign({}, node, {
    _has: !!st,
    _disabled: baseDisabled || locked,
    _state: st ? st.state : '',
  });
  const raw = readValue(out, st);
  out._min = numOrNull(dyn(out.min, st, 0));
  out._max = numOrNull(dyn(out.max, st, 100));
  out._step = numOrNull(dyn(out.step, st, 1)) || 1;
  /* unit：插件写了就按 dyn 解析后显示（解析不到则不显示），没写就不显示单位 */
  out.unit = out.unit ? String(dyn(out.unit, st, '') || '') : '';
  out._options = resolveOptions(out.option !== undefined ? out.option : out.options, st);

  if (out.type === 'bool') {
    out._value = toBool(raw);
    out._on = out._value;
  } else if (out.type === 'switch') {
    out._value = raw;
    out._on = env && env.isOn ? !!env.isOn(node._eid) : out._state === 'on';
  } else if (out.type === 'range') {
    out._value = numOrNull(raw);
  } else if (out.type === 'select' || out.type === 'choice') {
    out._value = raw;
  } else {
    /* label / button：读到的状态字符串，option 里查得到就换成中文 / 自定义文案。
     * button 组件只显示 label，这里算出的 _value 不会被用到。 */
    out._value = raw;
    if (out._options.length && typeof raw === 'string') {
      const hit = out._options.filter((x) => String(x.value) === raw)[0];
      if (hit) out._value = hit.label;
    }
  }
  return out;
}

export const CardEngine = {
  COLS,
  TYPES,
  COMPONENTS,
  domainOf,

  /* type → Vue 组件名，纯查表：label 恒为只读、button 恒为按钮，无隐式改派 */
  componentOf(node) {
    return node ? (COMPONENTS[node.type] || '') : '';
  },

  /* 实例级可点击判定 —— buildCard 的两个兜底分支（没写 cards / cards 全被过滤）共用。
   * 调用方给了 env.clickable 就以它为准；没给才回退 window.PluginEngine.instanceClickSpec
   * （studio 侧没有该全局，所以 studio 调用 buildCard 必须显式传 clickable）。 */
  _clickable(env) {
    const e = env || {};
    if (e.clickable !== undefined) return !!e.clickable;
    const pe = (typeof window !== 'undefined' && window.PluginEngine);
    if (!pe || typeof pe.instanceClickSpec !== 'function') return false;
    return !!pe.instanceClickSpec(e.obj || { entityId: e.entityId, style: e.style },
      e.type || domainOf(e.entityId || ''));
  },

  /* 单台设备：插件 cards() → 卡片结构。
   * 没声明 cards() 时：
   *   · 插件可点击（有 click / 内置默认 → clickSpec 非 null）→ 兜底一张「单元素 switch」卡，
   *     完全复用插件自身的 click（点击走 HA.toggle，见 useCards.run 的 _defaultToggle 分支）；
   *   · 完全不可点（clickSpec 为 null）→ 不出卡（null，调用方丢弃）。
   * 声明了 cards() 但**控件全被过滤**（字段都没绑 / 实体没那些属性 / 全是电源开关）→ 一个元素都没有：
   * 按「单元素」处理，退回与「没写 cards()」完全相同的默认兜底卡（容器层当 solo 平铺）；
   * 只有不可点击的纯展示类型才保留「标题独卡」（rows 为空，没别的能给它）。 */
  buildCard(env) {
    /* 卡片显示的统一口径：**没绑定主实体就不出卡**，绑定了才显示。
     * 设备 / 门 / 窗一视同仁 —— 插件声明了 cards() 也好、只绑了开度等扩展
     * 实体也好，只要 obj.entityId 为空就不给卡片位（避免空读数 / 假开关的壳）。
     * 全屋 / 房间 / 单设备三条入口都过这里，规则只写一次；容器层 useCards
     * 另有同一道早退，双保险保证绕过容器直接调引擎时也不会漏。 */
    if (!env || !env.entityId) return null;
    const raw = env.cards;
    if (!raw) return this._clickable(env) ? this.defaultToggleCard(env) : null;
    const parsed = toRows(raw);
    const rows = parsed.rows
      .map((r) => r.map((s) => normalizeNode(s, env)).filter(Boolean))
      .filter((r) => r.length);
    rows.forEach(layoutRow);
    const flat = rows.reduce((a, r) => a.concat(r), []);
    /* 单元素（solo）的占列不在这里定：它可能和其它设备的单元素聚合成一个网格块，
     * 具体每位占几列由渲染层 CardDevices 按「本块元素数 + 各自 columns」统一算
     * （1 个 → 全宽；多个 → 显式 columns 优先、未配置默认 2）。这里只保留 _explicit / columns。 */
    if (!flat.length && this._clickable(env)) return this.defaultToggleCard(env);

    const st = env.getState && env.entityId ? env.getState(env.entityId) : null;
    const fn = st && st.attributes && st.attributes.friendly_name;
    const title = fn || (env.obj && env.obj.name) || eidTailName(env.entityId);
    return {
      type: 'card', title, rows, flat, columns: COLS,
      _entityId: env.entityId || '',
      _type: env.type || domainOf(env.entityId || ''),
      _style: env.style || null,
      _kind: env.kind || (env.obj && env.obj.kind) || 'device',
      /* 实例级点击覆盖（属性面板写入）：渲染层标题电源开关要用它走同一套门控
       * PluginEngine.instanceClickSpec，否则 click:false / 默认不可点的设备
       * 会出现「按钮在但点了没反应」 */
      _click: env.obj ? env.obj.click : undefined,
      _clickSvc: (env.obj && env.obj.clickSvc) || '',
      _solo: parsed.solo && flat.length === 1,   // single → 交给容器层统一平铺
    };
  },

  /* 兜底卡：插件没写 cards()、或 cards() 的控件全被过滤（一个元素都不剩）但可点击时，
   * 出一张「单元素 switch」卡。
   * 控件不写真实 action（引擎 actionOf 会因无 action 返回 null、不可点），
   * 改用 _defaultToggle 标记，由渲染层点击时走 HA.toggle 复用插件 clickSpec
   * （字符串 / 函数两种形态都支持，与标题电源开关完全一致）。 */
  defaultToggleCard(env) {
    const eid = env.entityId || '';
    const st = env.getState && eid ? env.getState(eid) : null;
    const fn = st && st.attributes && st.attributes.friendly_name;
    /* 标题取 friendly_name；取不到回退实例 name / 实体 id 可读形式 */
    const title = fn || (env.obj && env.obj.name) || eidTailName(eid);
    const type = env.type || domainOf(eid);
    const node = {
      type: 'switch',
      key: 'entity',
      _eid: eid,
      _explicit: false,
      /* action 仅作「可点」占位：CardToggle 的 dis 判定要求 node.action 存在；
       * 真正发服务由 _defaultToggle 分支走 HA.toggle（plugin 的 clickSpec）。 */
      action: 'toggle',
      _defaultToggle: true,
      _toggleType: type,
      _toggleStyle: env.style || null,
      /* 实例级点击覆盖：兜底开关点击时原样交给 HA.toggle 走 instanceClickSpec */
      _click: env.obj ? env.obj.click : undefined,
      _clickSvc: (env.obj && env.obj.clickSvc) || '',
    };
    const rows = [[node]];
    rows.forEach(layoutRow);
    const flat = rows.reduce((a, r) => a.concat(r), []);
    /* 兜底单开关也是单元素：占列交给渲染层 CardDevices 按网格块统一算，
     * 不要在这里写死宽度 —— 只有它一个设备时会被渲染成全宽（不再半宽）。 */
    return {
      type: 'card', title, rows, flat, columns: COLS,
      _entityId: eid,
      _type: type,
      _style: env.style || null,
      _kind: env.kind || (env.obj && env.obj.kind) || 'device',
      _click: env.obj ? env.obj.click : undefined,
      _clickSvc: (env.obj && env.obj.clickSvc) || '',
      _solo: true,   // 交给容器层与其它单元素一起平铺
    };
  },

  /* 容器层：一个卡头 + 若干块。
   * · 所有插件返回的「单个元素」**不分出现顺序**统一合并成一个 grid 块，固定放在最上面
   *   （兜底单开关 / 单控件设备视觉上是一排胶囊按钮，聚在一处才不会散落在多控件卡之间）；
   *   块内按出现顺序平铺，各占各的 columns。
   * · 多控件设备各自成一张完整子卡，按原顺序排在单元素块后面。
   * 传入的 o.cards 顺序 = 设备顺序（编辑页「设备排序」面板排的就是 fl.devices），
   * 所以两类块内部天然都是「按设备权重排」—— 分组是天然形成的，不需要额外排序参数。 */
  buildListCard(o) {
    const soloItems = [];
    const cardBlocks = [];
    (o.cards || []).filter(Boolean).forEach((card) => {
      if (card._solo) {
        /* _ico：设备图标描述符（useCards.cardOf 挂上，{svg|mdi|emoji}），胶囊按钮左端显示 */
        soloItems.push(Object.assign({}, card.flat[0], { _title: card.title, _entityId: card._entityId, _ico: card._ico }));
      } else {
        cardBlocks.push({ kind: 'card', card });
      }
    });
    const blocks = soloItems.length
      ? [{ kind: 'grid', columns: COLS, items: soloItems }].concat(cardBlocks)
      : cardBlocks;
    return {
      type: 'list',
      title: o.title || '未命名',
      icon: o.icon || '📦',
      _roomId: o.roomId || '',
      _single: !!o.single,          // 单设备选中态：卡头已显示设备名，子卡不再重复
      _ready: o.ready !== false,
      blocks,
    };
  },

  /* 值树：HA 每次推送只重跑这一层。HA 是原地改 entity 对象（引用不变），
   * 所以必须把值提成原始类型的浅拷贝，Vue 才能 diff 出来。 */
  decorate(node, env) { return decorateNode(node, env); },

  /* 控件动作 → { domain, service, data }；data 已含 entity_id，可直接交给 HA.callService。
   * 无 action / 绑不到实体 / 值不可用 → null。引擎不认识任何 HA 域。 */
  actionOf(node, o) {
    if (!node || node._disabled) return null;
    const a = node.action;
    if (!a) return null;
    const eid = node._eid;
    let domain, service;
    if (typeof a === 'string' && a) {
      const dot = a.indexOf('.');
      if (dot > 0) { domain = a.slice(0, dot); service = a.slice(dot + 1); }
      else { domain = node.domain || domainOf(eid); service = a; }
    } else if (a && typeof a === 'object') {
      domain = a.domain || node.domain || domainOf(eid);
      if (a.service) service = a.service;
      else if (a.on || a.off) service = node._on ? a.off : a.on;   // 按当前态选的服务
      else return null;
    } else return null;
    if (!domain || !service) return null;

    const data = Object.assign({}, node.data || {});
    if (eid) data.entity_id = eid;

    /* 只有数值/枚举/布尔类控件带值；switch 与 button 是一次性动作，不带值。
     * 显式写了 param 则一律带值（逃生口，用来覆盖任意服务）。choice 与 select 同为枚举带值。 */
    const carries = node.type === 'range' || node.type === 'select' || node.type === 'choice'
      || node.type === 'bool' || !!node.param;
    if (carries) {
      const key = node.param || (a && a.param) || node.attr || 'value';
      let v = o && o.value !== undefined ? o.value : node._value;
      if (node.type === 'bool') v = (o && o.value !== undefined) ? toBool(o.value) : !toBool(node._value);
      if (node.type === 'range') { const n = numOrNull(v); if (n === null) return null; v = n; }
      if (v === null || v === undefined || v === '') return null;
      data[key] = v;
    }
    return { domain, service, data };
  },
};
