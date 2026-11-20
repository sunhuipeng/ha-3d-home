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

/* HA condition → emoji（无 qweather_icon 时的兜底） */
const COND_EMOJI = {
  sunny: '☀️', cloudy: '⛅', partlycloudy: '⛅', rainy: '🌧️', snowy: '🌨️',
  'clear-night': '🌙', fog: '🌫️', windy: '🌬️', hail: '🧊', lightning: '⛈️',
};

/* 和风天气（QWeather）qweather_icon 代码 → emoji，粗分常用桶：
 * 100/150 晴，101~103 / 151~153 多云系，104 阴，300~399 雨（302~303 雷），
 * 400~499 雪，500~599 雾霾。未收录返回空串（不渲染图标）。
 * 参考：weather.qweather_pro_* 实体的 attributes.qweather_icon（如 '104' 阴、'305' 小雨）。 */
export function wxEmoji(code) {
  const n = parseInt(code, 10);
  if (!n) return '';
  if (n === 100 || n === 150) return '☀️';
  if ((n >= 101 && n <= 103) || (n >= 151 && n <= 153)) return '⛅';
  if (n === 104) return '☁️';
  if (n >= 300 && n < 400) return (n >= 301 && n <= 303) ? '⛈️' : '🌧️';
  if (n >= 400 && n < 500) return '🌨️';
  if (n >= 500 && n < 600) return '🌫️';
  return '';
}

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

  /* 天气图标：优先和风天气 qweather_icon（信息最准），没有再按 HA condition 兜底 */
  const hudIcon = computed(() => {
    const we = weatherState.value;
    if (!we) return '';
    const a = we.attributes || {};
    return wxEmoji(a.qweather_icon) || COND_EMOJI[we.state] || '';
  });

  /* 副行: 天气文案 + 真实体感 + 湿度。
   * 2026-11-16 换和风天气（QWeather）集成：attributes 变多，口径同步升级——
   *   · 天气文案优先 condition_cn（和风自带中文，如「阴」），没有再查 COND_MAP；
   *   · 旧版「t~t+2°」区间是编造的假数据，换成真实 apparent_temperature / feels_like
   *     （与整点温度四舍五入相同就不重复展示）。
   * 分钟级降水简报（minutely_summary，同 sensor.*_precipitation_forecast 的文案）
   * 不进副行 —— 太长，窄屏会挤爆天气行；单独拆到 hudBrief 只在宽屏显示。 */
  const hudSubs = computed(() => {
    const we = weatherState.value;
    const out = [];
    if (we) {
      const a = we.attributes || {};
      const cond = a.condition_cn || COND_MAP[we.state] || we.state;
      if (cond) out.push(cond);
      const t = a.temperature;
      const feels = a.apparent_temperature != null ? a.apparent_temperature : a.feels_like;
      if (feels != null && t != null && Math.round(feels) !== Math.round(t)) {
        out.push('体感 ' + Math.round(feels) + '°');
      }
      if (a.humidity != null) out.push('湿度 ' + a.humidity + '%');
    }
    return out;
  });

  /* 降水简报：weather 实体的 minutely_summary（如「60分钟后开始下小雨，75分钟后就停了」）。
   * 只在宽屏顶栏追加（PanelHeader 按 wide 渲染），窄屏手机空间不够、显示不全。 */
  const hudBrief = computed(() => {
    const we = weatherState.value;
    const s = we && we.attributes && we.attributes.minutely_summary;
    return typeof s === 'string' ? s.trim() : '';
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

  return { hudTemp, hudIcon, hudSubs, hudBrief, hudCards };
}
