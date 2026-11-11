/*
 * composables/useHud.js — HUD 派生数据（原 engine/hud.js 的 Vue 化替代）
 *
 * 为什么是 composable 而不是 Pinia getter：
 *   这四个值既依赖 HA 实时实体，又依赖「项目数据」——天气实体在
 *   project.settings.weatherEntity、数据卡在当前楼层 cur.display.dataCards。
 *   编辑页的 project 在 editor store，大屏页的 project 目前还是组件本地 data，
 *   放 store getter 就得先强行把大屏页也接进同一个 store。composable 让两个页面
 *   各自传入自己的取值函数，零改动即可共用同一套实现。
 *
 * 相比旧 engine/hud.js：
 *   - 不再需要两页各写 4 个委托 computed + 8 处 `void this.entVersion` 手动失效缓存；
 *     computed() 直接依赖 ha store 的 entityVersion，HA 一推送就自动重算。
 *   - 不再把 HA 当参数传进纯函数，也不再挂 window.HUD。
 *   - SSR / 单测环境没有 window.HA 时静默返回空值，不抛错。
 *
 * 用法（Options API）：
 *   setup() {
 *     const vm = getCurrentInstance().proxy;
 *     return useHud(() => vm.project && vm.project.settings,
 *                  () => vm.cur && vm.cur.display);
 *   }
 * 返回的 computed ref 会自动 unwrap，模板里仍写 {{ hudTemp }}。
 */
import { computed } from 'vue';
import { useHaStore } from '../stores/ha';

/* HA weather condition → 中文（未收录的原样显示英文值） */
export const COND_MAP = {
  sunny: '晴', cloudy: '多云', partlycloudy: '局部多云', rainy: '雨', snowy: '雪',
  'clear-night': '晴夜', fog: '雾', windy: '大风', hail: '冰雹', lightning: '雷雨',
};

function client() {
  return (typeof window !== 'undefined' && window.HA) ? window.HA : null;
}

export function useHud(settingsGetter, displayGetter) {
  const ha = useHaStore();

  /* 天气实体：项目级 settings.weatherEntity（全楼层共用），未配置时取第一个 weather.* */
  const weatherState = computed(() => {
    void ha.entityVersion;
    const A = client();
    if (!A) return null;
    const st = (typeof settingsGetter === 'function' ? settingsGetter() : null) || {};
    if (st.weatherEntity) return A.getState(st.weatherEntity) || null;
    return A.all().find((s) => s.entity_id && s.entity_id.startsWith('weather.')) || null;
  });

  /* 主温度（HUD 右上角大字）: '24°' / '--°' */
  const hudTemp = computed(() => {
    const we = weatherState.value;
    return we && we.attributes && we.attributes.temperature != null
      ? Math.round(we.attributes.temperature) + '°' : '--°';
  });

  /* 副行: 天气文案 + 温度区间（t ~ t+2）+ 湿度 */
  const hudSubs = computed(() => {
    const we = weatherState.value;
    const out = [];
    if (we) {
      if (we.state) out.push(COND_MAP[we.state] || we.state);
      const t = we.attributes && we.attributes.temperature;
      const h = we.attributes && we.attributes.humidity;
      if (t != null) out.push(t + '~' + (Math.round(t) + 2) + '°');
      if (h != null) out.push('湿度 ' + h + '%');
    }
    return out;
  });

  /* 数据卡: 楼层 display.dataCards 里的实体 id → { eid, name, value, unit } */
  const hudCards = computed(() => {
    void ha.entityVersion;
    const A = client();
    if (!A) return [];
    const disp = (typeof displayGetter === 'function' ? displayGetter() : null) || {};
    const out = [];
    (disp.dataCards || []).forEach((eid) => {
      const s = A.getState(eid);
      if (!s) return;
      out.push({
        eid,
        name: A.friendly(eid),
        value: s.state,
        unit: (s.attributes && s.attributes.unit_of_measurement) || '',
      });
    });
    return out;
  });

  return { weatherState, hudTemp, hudSubs, hudCards };
}
