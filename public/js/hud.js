/*
 * hud.js — 编辑页顶栏与大屏共用的 HUD 派生数据（纯函数，不持有状态）
 * 输入: HA（ha.js 实例）与 project.settings；输出天气状态 / 温度 / 副行 / 数据卡。
 * app.js 与 display.js 的同名 computed 都委托到这里 —— 这四段曾两页逐字各抄一份，
 * 改天气文案/卡片结构要同步两处，现收敛为唯一实现。
 */
'use strict';

const HUD = {
  /* HA 天气实体的 condition → 中文（未收录的原样显示英文值） */
  condMap: {
    sunny: '晴', cloudy: '多云', partlycloudy: '局部多云', rainy: '雨', snowy: '雪',
    'clear-night': '晴夜', fog: '雾', windy: '大风', hail: '冰雹', lightning: '雷雨',
  },

  /* 天气实体: 项目级 settings.weatherEntity（全楼层共用），未配置时取第一个 weather.* */
  weatherState(HA, settings) {
    const st = settings || {};
    if (st.weatherEntity) return HA.getState(st.weatherEntity);
    return HA.all().find((s) => s.entity_id.startsWith('weather.'));
  },

  /* 主温度（HUD 右上角大字）: '24°' / '--°' */
  hudTemp(we) {
    return we && we.attributes && we.attributes.temperature != null
      ? Math.round(we.attributes.temperature) + '°' : '--°';
  },

  /* 副行: 天气文案 + 温度区间（t ~ t+2）+ 湿度 */
  hudSubs(we) {
    const out = [];
    if (we) {
      if (we.state) out.push(this.condMap[we.state] || we.state);
      const t = we.attributes && we.attributes.temperature;
      const h = we.attributes && we.attributes.humidity;
      if (t != null) out.push(t + '~' + (Math.round(t) + 2) + '°');
      if (h != null) out.push('湿度 ' + h + '%');
    }
    return out;
  },

  /* 数据卡: 楼层 display.dataCards 里的实体 id → { eid, name, value, unit }（实体不存在时跳过） */
  hudCards(HA, settings) {
    const st = settings || {};
    const out = [];
    (st.dataCards || []).forEach((eid) => {
      const s = HA.getState(eid);
      if (!s) return;
      out.push({
        eid,
        name: HA.friendly(eid),
        value: s.state,
        unit: (s.attributes && s.attributes.unit_of_measurement) || '',
      });
    });
    return out;
  },
};

window.HUD = HUD;
