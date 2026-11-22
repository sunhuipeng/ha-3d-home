/*
 * composables/useCardHistory.js — 数据卡历史曲线的取数状态机（Vue 3 Composition API）
 *
 * 职责：输入一个实体 id，输出 { mode, points, levels, loading, error } 供 HistoryChart 画。
 * · 走 HA.historyOf()（现有 WS history/period，服务端透传 + 5 分钟内存缓存）；
 * · 解析统一在 model/historySeries.js：数值→折线，枚举→阶梯线；
 * · 竞争保护：快速划过几张卡时，只认最后一次请求的结果（seq 令牌）；
 * · 演示模式 / 未连接：HA.historyOf 会 reject，这里转成友好 error 态。
 *
 * 用法（Options API 的 setup 里）：
 *   const hist = useCardHistory();
 *   return { ...hist };   // show(eid) / hide() / mode / points / ...
 */

import { ref } from 'vue';
import {
  parseHistory, seriesMode, numericPoints, enumPoints,
} from '../model/historySeries.js';

function client() {
  return (typeof window !== 'undefined' && window.HA) ? window.HA : null;
}

export function useCardHistory(hours = 24) {
  const activeEid = ref('');
  const mode = ref('number');
  const points = ref([]);
  const levels = ref([]);
  const loading = ref(false);
  const error = ref('');
  let seq = 0;   // 竞争令牌：只认最后一次 show() 的结果

  function clear() {
    seq++;
    activeEid.value = '';
    mode.value = 'number';
    points.value = [];
    levels.value = [];
    loading.value = false;
    error.value = '';
  }

  function show(eid) {
    if (!eid) return;
    if (activeEid.value === eid) return;   // 同一张卡不重复取（缓存层还有一道）
    const my = ++seq;
    activeEid.value = eid;
    loading.value = true;
    error.value = '';
    points.value = [];
    levels.value = [];
    const A = client();
    if (!A || typeof A.historyOf !== 'function') {
      if (my === seq) { loading.value = false; error.value = 'HA 未连接'; }
      return;
    }
    A.historyOf(eid, hours).then((raw) => {
      if (my !== seq) return;              // 已被后续 show/hide 取代，丢弃
      const parsed = parseHistory(raw);
      if (!parsed.length) {
        mode.value = 'number'; points.value = []; levels.value = []; loading.value = false;
        return;
      }
      if (seriesMode(parsed) === 'enum') {
        const e = enumPoints(parsed);
        mode.value = 'enum';
        levels.value = e.levels;
        points.value = e.points;
      } else {
        mode.value = 'number';
        levels.value = [];
        points.value = numericPoints(parsed);
      }
      loading.value = false;
    }).catch((e) => {
      if (my !== seq) return;
      loading.value = false;
      error.value = (e && e.message) || '历史数据获取失败';
    });
  }

  return { activeEid, mode, points, levels, loading, error, show, clear };
}
