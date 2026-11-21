/*
 * composables/useDisplayDerived.js — 展示页领域派生的 Vue 适配层（PanelApp 使用）
 *
 * 阶段 2 的关键变化：删掉两页各自维护的本地 entVersion 与散落的 `void this.entVersion`。
 * 现在的依赖只有两条，都在这里集中声明：
 *   ① HA 状态推送 → ha store.entityVersion（bridge.js 的 installHaBridge 统一递增，
 *      与页面自己的 HA.on('change') 回调是同一事件，不需要页面再手动 ++ 一次）；
 *   ② 插件就绪 → revision()（bootStage 的 afterPlugins 钩子递增的唯一本地版本号，
 *      因为 HA.deviceIsOn 在插件注册前后判定规则不同，必须强制重算统计）。
 * 其余全部是注入的 getter（floor / selection / ha / haStatus），不读 window 全局状态
 * 之外的东西，也不碰 DOM / THREE。
 *
 * 展示项（displayItems）由 model/displayDerived.js 的 displayItemsOf 派生：
 * 配置是主表，HA 状态只用来补名称 / 图标 / 开关态，所以 HA 每次推送都要重算
 * （entityVersion 已经登记在 deps() 里，开关状态灯会实时跟随）。
 *
 * 用法（Options API 的 setup 里）：
 *   const vm = getCurrentInstance().proxy;
 *   return useDisplayDerived({
 *     floor: () => vm.cur, selection: () => vm.sel,
 *     revision: () => vm.pluginRevision,
 *   });
 * 返回的 computed ref 会自动 unwrap，模板里仍写 {{ onCount }}，methods 里仍可 this.onCount。
 */
import { computed, ref, watch, onScopeDispose } from 'vue';
import { useHaStore } from '../stores/ha';
import { haIconOf } from '../services/haIcon';
import { sceneIcon } from '../model/sceneIcon';
import {
  allDevicesOf, scopeDevicesOf, countOn, roomTabsOf, displayItemsOf,
  statusTextOf, netClassOf, cardKeyOf, isAllOf, activeIdOf,
} from '../model/displayDerived.js';

export function useDisplayDerived(opts = {}) {
  const haStore = opts.haStore || useHaStore();
  const ha = opts.ha || (() => (typeof window !== 'undefined' ? window.HA : null));
  const floor = opts.floor || (() => null);
  const floors = opts.floors || (() => null);
  const selection = opts.selection || (() => null);
  const haStatus = opts.haStatus || (() => haStore.haStatus);
  const revision = opts.revision || (() => 0);

  /* 每次求值都调用一次：把两条失效信号登记为当前 computed 的响应式依赖。
     逐项 computed 而不是「一次算全量」—— 保持和重构前一样的惰性缓存粒度
     （HA 增量推送很频繁，不做无谓全量重算）。 */
  const deps = () => { void haStore.entityVersion; void revision(); };

  const isOn = (d) => {
    const A = ha();
    return !!(A && A.deviceIsOn && A.deviceIsOn(d));
  };

  /* 顶栏统计：全家口径 —— 分母分子都取所有楼层的设备，切层不跟随。
     没注入 floors 时回退到当前楼层一份（兼容旧调用方）。 */
  const allDevices = computed(() => {
    const fs = floors();
    return allDevicesOf(Array.isArray(fs) && fs.length ? fs : [floor()]);
  });
  const onCount = computed(() => {
    deps();
    return countOn(allDevices.value, isOn);
  });
  /* 分母只跟项目数据走，不依赖 HA 推送 */
  const deviceTotal = computed(() => allDevices.value.length);

  const scopeDevices = computed(() => {
    deps();
    return scopeDevicesOf(floor(), selection() || {});
  });
  const scopeTotal = computed(() => scopeDevices.value.length);
  const scopeOn = computed(() => countOn(scopeDevices.value, isOn));

  /* 角标实时派生：HA 一推送就重算 badge + 目标顺序（纯函数里已按 badge 降序）。
     下面再叠一层「位置防抖」，两者数据同源但更新时机不同。 */
  const tabsLive = computed(() => {
    deps();
    return roomTabsOf(floor(), isOn);
  });

  /* 房间条位置防抖（2026-11-19）：
     角标数字实时跟随 HA（用户关灯立刻看到 1→0）；但按钮「换位」延迟 350ms，
     避免开关灯瞬间按钮跳到别处、手指正按在上面时误切了房间。
     实现：shownOrder 存当前渲染的 id 顺序；tabsLive 变化时先按 id 把最新 badge
     贴到现有位置上（角标实时），仅当目标顺序与当前顺序不同才起 350ms 定时器换序。
     房间集合变化（换楼层 / 增删房间）不是重排而是换内容 → 立即就位，不防抖。 */
  const shownOrder = ref([]);
  let orderTimer = null;
  watch(tabsLive, (tabs) => {
    const target = tabs.map((t) => t.id);
    const cur = shownOrder.value;
    const sameSet = cur.length === target.length && target.every((id) => cur.includes(id));
    if (!sameSet) {
      clearTimeout(orderTimer);
      shownOrder.value = target;
      return;
    }
    const reordered = target.some((id, i) => id !== cur[i]);
    if (!reordered) return;            // 只是 badge 变了，位置不用动
    clearTimeout(orderTimer);
    orderTimer = setTimeout(() => { shownOrder.value = target; }, 350);
  }, { immediate: true });
  onScopeDispose(() => clearTimeout(orderTimer));

  /* 渲染用列表：顺序取 shownOrder（防抖后的），badge / name 每次从 tabsLive 现取（实时） */
  const roomTabs = computed(() => {
    const byId = new Map(tabsLive.value.map((t) => [t.id, t]));
    return shownOrder.value.map((id) => byId.get(id)).filter(Boolean);
  });

  const displayItems = computed(() => {
    deps();
    return displayItemsOf(floor(), ha(), { iconOfState: haIconOf, iconOfName: sceneIcon });
  });

  /* 状态文案 / 统计点只依赖 ha store 的 status（响应式），与实体版本无关 */
  const statusText = computed(() => statusTextOf(haStatus()));
  const netClass = computed(() => netClassOf(haStatus()));

  const cardKey = computed(() => cardKeyOf(selection()));
  const isAll = computed(() => isAllOf(selection()));
  const activeId = computed(() => activeIdOf(selection()));

  return {
    onCount, deviceTotal,
    scopeDevices, scopeTotal, scopeOn,
    roomTabs, activeId, isAll,
    displayItems, statusText, netClass, cardKey,
  };
}
