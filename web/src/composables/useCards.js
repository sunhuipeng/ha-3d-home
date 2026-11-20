/*
 * composables/useCards.js — 卡片树的响应式装配层（容器层）
 *
 * 职责只有三件：决定「哪些设备进卡」、把插件 cards() 交给 CardEngine 建结构、
 * 把 HA 状态推给 CardEngine 装饰值、把控件动作转给 HA.callService。
 * 具体控件长什么样、服务怎么拼、怎么排版全在 engine/cards.js，这里不掺和。
 *
 * 入参全部注入，不自己 useXxxStore()：编辑页与大屏是两个独立 Pinia 实例，
 * 写死任一个，另一边就用不了。
 *
 *   const { view, run } = useCards({
 *     selection: () => store.selection,   // () => ({ kind, id }) | null
 *     floor:     () => store.cur,         // () => floor
 *   });
 *
 * view 是**已装饰**的树（每个节点带 _value / _on / _min / _max / _disabled / _span），
 * 结构只随选中项变化重建，值随 entityVersion 重算。
 */
import { computed } from 'vue';
import { useHaStore } from '../stores/ha';
import { useCatalogStore } from '../stores/catalog';
import { CardEngine } from '../engine/cards.js';
import { roomDevices, DEVICE_TYPES, KIND_ARR } from '../model/catalog';
import { haIconOf } from '../services/haIcon';
import { domainMdiOf } from '../model/displayAction.js';

/* 卡头图标：与设备面板（DevPanel）同一份 DEVICE_TYPES，避免同一设备两个图标；
 * 再补 HA 侧独有的域（面板没有的分类）作为兜底 */
const EXTRA_ICONS = {
  binary_sensor: '📡', door: '🚪', window: '🪟',
  scene: '🎬', automation: '⚙️',
};
function iconOf(type) {
  return (DEVICE_TYPES[type] && DEVICE_TYPES[type].icon) || EXTRA_ICONS[type] || '📦';
}

/* 域级默认 mdi 的清单与解析在 model/displayAction.js（卡片头与展示项磁贴共用一份，
 * 避免同一实体两个图标）。attributes.icon 只有用户在 HA 里显式设置过才有值，
 * HA 界面平时显示的默认图标是**前端**按 domain 补的、不在状态数据里。 */
/* 设备图标四级来源（2026-11-14）：HA 实体 icon（mdi）→ 造型 icon → domain 默认 mdi → 类型 emoji。
 * 返回形态描述符 { svg | mdi | emoji }，渲染层按形态画（SVG 字符串 / mdi 字体 / 文本）。
 * HA 图标读的是本地已订阅的实体状态（attributes.icon），不产生任何额外 HA 查询；
 * 用户在 HA 里显式改过图标的设备，卡头 / 胶囊按钮即时跟随。 */
function icoOf(type, obj, eid, getState) {
  const h = getState ? haIconOf(getState(eid)) : null;
  if (h) return { mdi: h.mdi };
  const pe = PE();
  const s = pe && pe.styleOf ? pe.styleOf(type, obj && obj.style) : null;
  if (s && s.icon) return /^<svg[\s>]/i.test(s.icon) ? { svg: s.icon } : { emoji: s.icon };
  const dm = domainMdiOf(String(eid || '').split('.')[0]);
  if (dm) return { mdi: dm };
  return { emoji: iconOf(type) };
}

function PE() { return (typeof window !== 'undefined' && window.PluginEngine) || null; }
function HA() { return (typeof window !== 'undefined' && window.HA) || null; }

export function useCards(opts) {
  const haStore = (opts && opts.ha) || useHaStore();
  const catalogStore = (opts && opts.catalog) || useCatalogStore();
  const getSel = (opts && opts.selection) || (() => null);
  const getFloor = (opts && opts.floor) || (() => null);

  /* eid → 实例上下文，供 CardEngine 的 switch 控件还原「插件 isOn」判定。
   * 每次重建 tree 时清空重填；view 依赖 tree，执行顺序天然保证先 tree 后 view。 */
  const ctxOfEid = new Map();

  const readState = (eid) => {
    const ha = HA();
    return ha && ha.getState ? ha.getState(eid) : null;
  };

  /* 实体就绪信号：HA 首次连上（0 → 645）时只变一次，之后的增量推送数量通常不变，
   * 所以 computed 不会反复触发。结构树必须依赖它：卡片标题取 friendly_name，
   * 若 entities 为空时建树，标题会固化成实体 id 的可读形式，之后再修不回来。 */
  const haReady = computed(() => haStore.entityCount > 0);

  const isOnOf = (eid) => {
    const ha = HA();
    if (!ha) return false;
    const ctx = ctxOfEid.get(eid);
    if (ctx && ha.deviceIsOn) {
      // 主实体走插件判定（与 2D 标签 / 3D 标签完全同一套规则）
      if (eid === ctx.entityId) return !!ha.deviceIsOn(ctx.kind === 'device' ? ctx.obj : { entityId: eid, type: ctx.kind });
    }
    return !!(ha.isOn && ha.isOn(eid));
  };

  /* 单实例环境：只把「插件声明」和「读状态的两个函数」交给引擎。
   * 没有 cards() 声明的设备：若插件可点击（clickSpec 非 null），buildCard 会兜底一张
   * 单元素 switch 卡（沿用插件 click）；否则仍判成 null，后面统一过滤掉。 */
  function cardOf(obj, kind) {
    const pe = PE();
    const eid = obj.entityId || '';
    /* 统一口径：主实体没绑定 → 不出卡；只绑了扩展字段（开度/功率…）同样不出卡。
     * 引擎 CardEngine.buildCard 里还有同一道保险（唯一规则出处，见那边注释）。
     * 门窗与设备完全一样：门磁 / 智能门窗 / 窗磁都写在 obj.entityId 上。 */
    if (!eid) return null;
    const type = kind === 'device' ? (obj.type || CardEngine.domainOf(eid)) : kind;
    /* 「能不能点」用实例级门控（与 3D 标签 / 属性面板同一口径）：
     * click:false、插件 defaultOn:false 且未显式开启的设备不算可点 —— 不再出兜底单开关卡 */
    const clickable = !!(pe && pe.instanceClickSpec && pe.instanceClickSpec(obj, type));
    const env = {
      obj, entityId: eid, type, kind,
      style: obj.style,
      cards: pe && pe.cardsOf ? pe.cardsOf(type, obj.style, obj) : null,
      clickable,
      getState: readState,
      isOn: isOnOf,
    };
    ctxOfEid.set(eid, { obj, kind, entityId: eid, type, style: obj.style });
    const card = CardEngine.buildCard(env);
    /* 设备图标描述符（HA icon → 造型 icon → 类型 emoji）挂在卡上：
     * 卡头（单设备视图）与 solo 平铺格（胶囊按钮）共用。buildCard 可能返回 null
     * （绑不到实体 / 不可点击 → 不出卡），必须判空，否则整棵卡片树崩掉。 */
    if (card) {
      card._ico = icoOf(type, obj, eid, readState);
      /* 完整实例引用（含 powerEntity 等 fields 绑定）：标题电源开关
       * （CardPowerToggle）的复合 isOn 判定与点击方向都靠它 —— 只传
       * {entityId,type,style} 的话，插件 isOn 里读 obj.powerEntity 会拿到
       * undefined，复合判定恒 false（表现为「开着但胶囊显示关」）。
       * decorate 的卡节点是 Object.assign 浅拷贝，_dev 会原样带过去。 */
      card._dev = obj;
    }
    return card;
  }

  /* 一个房间 → 该房间的设备卡数组（选中房间时用）。
   * roomDevices 用 filter 保序，所以房内顺序同样跟随 fl.devices = 设备排序权重。
   * 门窗家具不出房间卡：门窗多为状态型、家具没有实体契约。
   * hideCard 的设备（设备排序面板里点了「隐藏」）不出插片。 */
  function roomCards(fl, room) {
    return roomDevices(fl, room.id)
      .filter((d) => !(d && d.hideCard === true))
      .map((d) => cardOf(d, 'device'))
      .filter(Boolean);
  }

  /* 结构树：只随「选中项 / 楼层数据」变化重建。
   * 三种选中态（全屋 / 房间 / 设备）都产出同一种 list 卡，区别只在塞进哪些设备。 */
  const tree = computed(() => {
    void haReady.value;             // 实体从无到有时重建一次（见 haReady 注释）
    void catalogStore.pluginItems;  // 插件注册完成的信号：PluginEngine.loadAll 之后
                                    // refreshPlugins() 会换掉这个数组引用 —— 没有它，
                                    // 树的重建依赖全靠「loadAll 先于 startHA」的时序巧合
                                    //（插件后注册 / 热刷新时会以无插件状态固化）。
    const sel = getSel();
    const fl = getFloor();
    ctxOfEid.clear();
    if (!sel || !fl) return null;

    const ready = haReady.value;
    /* 全屋：整层设备按 **fl.devices 数组顺序** 建卡 —— 这就是「设备排序」面板
     * （DevOrderPanel）排出来的权重，卡片跟着设备走，不再按房间分组拼接。
     * 家具（type:'furniture'，动态家具实例）不出卡，跳过；未绑实体的设备由
     * cardOf 返回 null 后过滤掉（它们本就没有卡片位）。
     * hideCard（排序面板里点「隐藏」）只挡卡片插片：读 d.hideCard 即建立响应依赖，
     * 面板里切换后卡片树立刻重建；2D/3D 场景、标签、点击一律不受影响。 */
    if (sel.kind === 'all') {
      const cards = (fl.devices || [])
        .filter((d) => d && d.type !== 'furniture' && d.hideCard !== true)
        .map((d) => cardOf(d, 'device')).filter(Boolean);
      return CardEngine.buildListCard({ title: '全屋', icon: '🏠', cards, ready });
    }

    if (sel.kind === 'room') {
      const room = ((fl.rooms) || []).find((r) => r.id === sel.id);
      if (!room) return null;
      return CardEngine.buildListCard({
        title: room.name || '未命名房间', icon: '🏠', roomId: room.id,
        cards: roomCards(fl, room), ready,
      });
    }

    const arr = KIND_ARR[sel.kind];
    if (!arr) return null;              // 墙 / 普通家具 / 未知 → 空态
    const it = ((fl[arr]) || []).find((x) => x.id === sel.id);
    if (!it) return null;
    const card = cardOf(it, sel.kind);
    if (!card) return null;             // 该插件没写 cards() → 不出卡
    /* 单设备：同样是一张 list 卡，只放这一台 —— 卡头显示设备名，body 用同一套渲染 */
    const type = sel.kind === 'device' ? (it.type || CardEngine.domainOf(it.entityId)) : sel.kind;
    /* 卡头图标：cardOf 已按「造型 icon → HA icon → 类型 emoji」算好描述符，直接用 */
    return CardEngine.buildListCard({ title: card.title, icon: card._ico, cards: [card], single: true, ready });
  });

  /* 值树：HA 每推一次就重算；节点是浅拷贝，值提成原始类型，
   * 这样 Vue 的 diff 才能发现「引用没变但值变了」（HA 是原地改 entity 对象）。 */
  const view = computed(() => {
    void haStore.entityVersion;
    const t = tree.value;
    if (!t) return null;
    return CardEngine.decorate(t, { getState: readState, isOn: isOnOf });
  });

  /* 执行一个控件动作：{ domain, service, data }，data 已含 entity_id。
   * _defaultToggle 节点（插件没写 cards() 的兜底单开关）不走引擎 actionOf，
   * 直接复用插件 clickSpec 经 HA.toggle 发服务（支持字符串 + 函数两种 click 形态）。 */
  function run(node, value) {
    const ha = HA();
    if (node && node._defaultToggle) {
      if (!ha || !ha.toggle) return Promise.resolve(null);
      const eid = node._eid;
      const type = node._toggleType || CardEngine.domainOf(eid);
      /* 带上实例的 click / clickSvc：HA.toggle 用 instanceClickSpec 统一门控，
       * 面板里显式关掉点击（click:false）或改过动作的设备，卡片点击与 3D 完全一致。
       * 同时带上完整实例（ctxOfEid 里的 obj）：HA.toggle 判方向用的 deviceIsOn
       * 要读 fields 绑定（powerEntity 等），缺了就恒判「关」、点击反发开启。 */
      const ctx = ctxOfEid.get(eid);
      ha.toggle(Object.assign({}, (ctx && ctx.obj) || {}, {
        entityId: eid, type,
        style: node._toggleStyle || (ctx && ctx.obj && ctx.obj.style),
        click: node._click, clickSvc: node._clickSvc,
      }), type);
      /* HA.toggle 没有返回值（失败时它自己 toast「控制失败」）；这里必须回一个
       * 真值，否则上层「!r && node.action」会把占位 action 误判成
       * 「该动作没有可用的服务配置」弹提醒（实际服务已正常发出）。 */
      return Promise.resolve({ toggled: true });
    }
    const a = CardEngine.actionOf(node, { value });
    if (!a) return Promise.resolve(null);
    if (!ha || !ha.callService) return Promise.resolve(null);
    return ha.callService(a.domain, a.service, a.data);
  }

  return { view, run };
}
