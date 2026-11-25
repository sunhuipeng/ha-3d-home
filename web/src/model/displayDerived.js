/*
 * model/displayDerived.js — 展示页的「选中范围 / 统计 / 展示项 / 状态」派生纯函数
 *
 * 阶段 2 抽取：原来这些口径分别写在 PanelApp.vue 与 DisplayApp.vue 的 computed 里，
 * 两页各有一份（onCount / scenes / statusText / cardKey 几乎逐字相同），且都靠
 * `void this.entVersion` 手动失效缓存。这里收成零依赖纯函数：
 *   - 不读 window / Vue / Pinia / DOM；HA 客户端、图标解析、插件 isOn 全部注入；
 *   - 可直接在 Node 里单测（tests/display-derived.test.mjs）；
 *   - Vue 侧的响应式包装在 composables/useDisplayDerived.js。
 *
 * 行为口径（2026-11-15 展示项改造后）：
 *   · 展示项以 floor.display.displayItems 为**主表**（配置里写了就一定显示），
 *     HA 状态只用来补充名称 / 图标 / 当前开关态 / 服务分派；HA 里暂时查不到的
 *     实体照样出现在条子上，只是名字回退成 eid、图标走 domain 兜底；
 *   · 上限 MAX_DISPLAY_ITEMS（单行横滚的防御上限），顺序 = 配置数组顺序；
 *   · 全屋统计分母必须跟着选中范围走（房间 / 单设备 / 门窗 / 全屋）；
 *   · scopeDevicesOf 恒返回新数组 —— 直接返回 fl.devices 会因引用不变
 *     导致下游 scopeOn 不重算（历史上表现为「顶栏 2/7、卡片头一直 0/7」）。
 */
import { displayActionOf, domainMdiOf, MAX_DISPLAY_ITEMS } from './displayAction.js';

/* 当前楼层「全部设备」。两页原写法略有差异（PanelApp 带 || [] 兜底，
   DisplayApp 直接 .forEach），统一取带兜底的口径：正常数据下完全等价。 */
export function devicesOf(fl) {
  return (fl && fl.devices) || [];
}

/* 全家设备（顶栏统计分母）：所有楼层的 devices 依次展开成一个新数组。
   floors 为空 / 某层没有 devices 都按空处理；选层不影响分子分母，
   切到任意楼层左上角都显示同一份全家统计。与 devicesOf 一样返回新数组，
   避免下游 computed 因引用不变而不重算。 */
export function allDevicesOf(floors) {
  const out = [];
  (Array.isArray(floors) ? floors : []).forEach((fl) => {
    const devs = (fl && fl.devices) || [];
    for (let i = 0; i < devs.length; i++) out.push(devs[i]);
  });
  return out;
}

/* 选中范围内的设备集合：房间 / 单设备 / 门窗 / 全屋（含 kind 未知、楼层为空） */
export function scopeDevicesOf(fl, sel) {
  if (!fl) return [];
  const s = sel || {};
  if (s.kind === 'room') return (fl.devices || []).filter((d) => d.roomId === s.id);
  if (s.kind === 'device') return (fl.devices || []).filter((d) => d.id === s.id);
  if (s.kind === 'door' || s.kind === 'window') {
    const arr = (s.kind === 'door' ? fl.doors : fl.windows) || [];
    return arr.filter((d) => d.id === s.id);
  }
  return (fl.devices || []).slice();
}

/* 开着的数量：isOn 由调用方注入（HA.deviceIsOn，插件就绪前后判定会变） */
export function countOn(devices, isOn) {
  return (devices || []).filter((d) => !!isOn(d)).length;
}

/* 全屋 / 房间分段控件：房间名 + 「该房间开着几个」角标。
   无状态组件不收函数 prop，所以角标在父层一次性派生好。

   排序口径（2026-11-19）：fl.rooms 的数组顺序 = 编辑页排好的默认顺序；有任一房间
   开着设备时，按 badge 降序重排（打开多的靠前），badge 相同的保持编辑页相对顺序
   （稳定排序，带原下标兜底）；全部房间都是 0 时保持编辑页默认顺序。全屋不在本函数
   里 —— 它是模板里写死的第一个按钮，天然固定第一。 */
export function roomTabsOf(fl, isOn) {
  const list = (fl && fl.rooms) || [];
  const devs = (fl && fl.devices) || [];
  const tabs = list.map((r, index) => ({
    id: r.id,
    name: r.name,
    badge: devs.filter((d) => d.roomId === r.id && !!isOn(d)).length,
    _index: index,
  }));
  if (!tabs.some((t) => t.badge > 0)) return tabs.map(stripIndex);
  return tabs
    .sort((a, b) => (b.badge - a.badge) || (a._index - b._index))
    .map(stripIndex);
}
function stripIndex(t) {
  return { id: t.id, name: t.name, badge: t.badge };
}

/* 展示项列表（配置主表 + HA 增强）：
 *   iconOfState(s) → { mdi } | null   （HA 实体 attributes.icon，只认 mdi: 前缀）
 *   iconOfName(name) → emoji          （按中文名关键词猜；无 mdi 时兜底）
 * 图标优先级：HA attributes.icon → 项目自定义 icon → domain 默认 mdi → 名称 emoji。
 * 服务分派与开/关态都由 model/displayAction.js 按域决定，执行层读同一份结论。 */
export function displayItemsOf(fl, ha, { iconOfState, iconOfName } = {}) {
  const A = ha || {};
  const all = typeof A.all === 'function' ? A.all() : [];
  const byEid = new Map();
  (all || []).forEach((s) => { if (s && s.entity_id) byEid.set(s.entity_id, s); });
  /* 不能把 HA.friendly / getState 提成裸函数：它们是对象方法，内部要用 this，
     解绑后 this === undefined（ESM 严格模式）会抛
     "Cannot read properties of undefined (reading 'entities')" 之类错误，
     整条展示项 computed 直接挂掉。这里一律用成员调用包一层。 */
  const friendly = typeof A.friendly === 'function' ? (eid) => A.friendly(eid) : (eid) => eid;
  const getState = typeof A.getState === 'function' ? (eid) => A.getState(eid) : () => null;
  const iconState = iconOfState || (() => null);
  const iconName = iconOfName || (() => '🎬');
  const cfg = (fl && fl.display && fl.display.displayItems) || [];
  return (Array.isArray(cfg) ? cfg : [])
    /* automation 项 eid 是居控中枢短码（无 domain. 前缀），按 kind 单独放行；
     * 其余仍只接受 HA 实体 id，避免脏配置把任意字符串塞进展示条。 */
    .filter((it) => it && typeof it.eid === 'string' && (
      it.kind === 'automation' ? /^[A-Za-z0-9_-]{1,64}$/.test(it.eid) : it.eid.indexOf('.') > 0
    ))
    .slice(0, MAX_DISPLAY_ITEMS)
    .map((it) => {
      const eid = it.eid;
      const type = eid.split('.')[0];
      const st = byEid.get(eid) || getState(eid) || null;
      const name = it.name || friendly(eid);
      const h = iconState(st);
      /* automation 的 icon 是从居控中枢同步过来的 SVG 源码（validIcon 已净化），
       * 单独走 <img> 渲染；有 SVG 时不再套 mdi / emoji。 */
      const svg = it.kind === 'automation' && typeof it.svg === 'string' ? it.svg : '';
      const mdi = svg ? '' : ((h ? h.mdi : '') || it.icon || domainMdiOf(type));
      const act = displayActionOf({ eid, type, kind: it.kind, action: it.action });
      return {
        eid, name, type,
        kind: it.kind || 'entity',
        icon: !mdi && type === 'script' ? '📜' : iconName(name),
        mdi, svg,
        service: act.service,
        action: it.action || '',
        toggle: act.toggle,
        proxy: act.proxy,
        on: !!(st && st.state === 'on'),
        state: st ? String(st.state) : '',
      };
    });
}

/* 顶栏连接状态文案（两页原文案完全一致） */
export function statusTextOf(haStatus) {
  const s = (haStatus || {}).status;
  if (s === 'connected') return 'Home Assistant 已连接 · 实时同步中';
  if (s === 'demo') return '演示模式（未配置 Home Assistant）';
  if (s === 'connecting') return (haStatus && haStatus.message) || '连接中…';
  if (s === 'error') return (haStatus && haStatus.message) || '连接失败';
  return '未连接';
}

/* 顶栏统计点：在线绿 / 演示橙 / 其它灰（仅面板页使用） */
export function netClassOf(haStatus) {
  const s = (haStatus || {}).status;
  return { on: s === 'connected', demo: s === 'demo', off: s !== 'connected' && s !== 'demo' };
}

/* 卡片 key：切换设备 / 房间 / 全屋时整张卡重建，避免按索引复用 DOM */
export function cardKeyOf(sel) {
  return 'card:' + (sel ? (sel.kind + ':' + (sel.id || '')) : 'all');
}

export function isAllOf(sel) {
  return !!(sel && sel.kind === 'all');
}

/* 选中房间时分段控件高亮；选中单设备时为 null（不高亮任何分段） */
export function activeIdOf(sel) {
  return sel && sel.kind === 'room' ? sel.id : null;
}
