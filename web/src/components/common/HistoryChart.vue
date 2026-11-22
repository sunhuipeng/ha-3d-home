<template>
  <!-- 数据卡历史曲线：单实体 24h 采样，SVG 手画（不引图表库）。
       两种值：数值→折线（真实量程），枚举→阶梯线（离散档位，如 heating/eco/off）。
       四种状态互斥：loading / error / 空 / 有数据，固定尺寸盒避免 hover 时高度跳变。 -->
  <div class="hist-chart">
    <div class="hc-head">
      <span class="hc-title">{{ title }}</span>
      <span v-if="unit" class="hc-unit">{{ unit }}</span>
    </div>

    <div class="hc-body">
      <div v-if="loading" class="hc-msg"><i class="hc-spin"></i>加载历史…</div>
      <div v-else-if="error" class="hc-msg err">{{ error }}</div>
      <div v-else-if="!points || !points.length" class="hc-msg">暂无历史数据</div>
      <template v-else>
        <div class="hc-plot">
          <!-- Y 轴：上大下小，标真实极值（不含绘图余量），带单位 -->
          <div class="hc-yaxis">
            <span>{{ yTop }}</span>
            <span>{{ yBottom }}</span>
          </div>
          <svg class="hc-svg" :viewBox="'0 0 ' + W + ' ' + H" preserveAspectRatio="none" aria-hidden="true">
            <line class="hc-grid" x1="0" :x2="W" y1="6" y2="6" />
            <line class="hc-grid" x1="0" :x2="W" :y1="H / 2" :y2="H / 2" />
            <line class="hc-grid" x1="0" :x2="W" :y1="H - 6" :y2="H - 6" />
            <polyline class="hc-line" fill="none" :points="poly" vector-effect="non-scaling-stroke" />
          </svg>
        </div>
        <!-- X 轴：左端起、右端止；跨天自动带「昨 / 今」，不再看着像时间倒流 -->
        <div class="hc-xaxis"><span>{{ t0 }}</span><span>{{ t1 }}</span></div>
      </template>
    </div>
  </div>
</template>

<script>
/* 无状态展示组件：吃已经解析好的点 —— 数值 [{t,v}] 或 枚举 [{t,v:level,label}] + levels。
   解析 / 模式判定 / 量程 / 映射都在 model/historySeries.js（可单测）。 */
import { seriesBounds, enumBounds, mapPoints, stepPoints, formatAxisTimes } from '../../model/historySeries.js';

export default {
  name: 'HistoryChart',
  props: {
    title: { type: String, default: '' },
    unit: { type: String, default: '' },
    mode: { type: String, default: 'number' },   // 'number' | 'enum'
    points: { type: Array, default: () => [] },
    levels: { type: Array, default: () => [] },  // 枚举档位：[{label, level}]
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
  },
  data() {
    return { W: 260, H: 72, PAD: 6 };   // viewBox 固定，CSS 里按容器缩放
  },
  computed: {
    isEnum() { return this.mode === 'enum'; },
    b() {
      return this.isEnum ? enumBounds(this.levels) : seriesBounds(this.points);
    },
    poly() {
      if (!this.points || !this.points.length) return '';
      return this.isEnum
        ? stepPoints(this.points, this.b, this.W, this.H, this.PAD)
        : mapPoints(this.points, this.b, this.W, this.H, this.PAD)
            .map((p) => p[0] + ',' + p[1]).join(' ');
    },
    /* 横轴两端：跨天带「昨/今」，同一天只给时钟 */
    axisTimes() { return formatAxisTimes(this.b.t0, this.b.t1); },
    t0() { return this.axisTimes[0]; },
    t1() { return this.axisTimes[1]; },
    /* Y 轴上大下小：数值标真实极值 + 单位；枚举标首尾档名（档位多时中间略过） */
    yTop() {
      if (this.isEnum) {
        const l = this.levels;
        return l && l.length ? l[0].label : '';
      }
      return this.b.rawMax.toFixed(1) + this.unit;
    },
    yBottom() {
      if (this.isEnum) {
        const l = this.levels;
        return l && l.length ? l[l.length - 1].label : '';
      }
      return this.b.rawMin.toFixed(1) + this.unit;
    },
  },
};
</script>

<style scoped>
.hist-chart {
  width: 260px;
  padding: 10px 12px 8px;
  border-radius: 12px;
  background: var(--glass, #fff);
  backdrop-filter: blur(16px) saturate(1.05);
  -webkit-backdrop-filter: blur(16px) saturate(1.05);
  box-shadow: 0 8px 22px rgba(20, 30, 50, .14);
}
.hc-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; margin-bottom: 6px; }
.hc-title { font-size: 12px; color: var(--ink2, #6b7280); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-unit { font-size: 10px; color: var(--ink2, #6b7280); opacity: .7; flex: none; }
.hc-body { height: 92px; display: flex; flex-direction: column; justify-content: center; }
.hc-msg { font-size: 12px; color: var(--ink2, #6b7280); display: flex; align-items: center; gap: 6px; }
.hc-msg.err { color: #c0392b; }
.hc-spin { width: 12px; height: 12px; border: 2px solid var(--line, #e5e9f0); border-top-color: var(--blue, #3b82f6);
  border-radius: 50%; animation: hc-spin .7s linear infinite; flex: none; }
@keyframes hc-spin { to { transform: rotate(360deg); } }
.hc-plot { display: flex; align-items: stretch; gap: 5px; }
.hc-yaxis { flex: none; width: 46px; display: flex; flex-direction: column; justify-content: space-between;
  align-items: flex-end; padding: 2px 0 4px; font-size: 10px; color: var(--ink2, #6b7280);
  font-variant-numeric: tabular-nums; text-align: right; }
.hc-yaxis span { max-width: 46px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-svg { flex: 1; min-width: 0; height: 72px; display: block; overflow: visible; }
.hc-grid { stroke: var(--line, #e5e9f0); stroke-width: 1; }
.hc-line { stroke: var(--blue, #3b82f6); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.hc-xaxis { display: flex; justify-content: space-between; margin: 3px 0 0 51px;
  font-size: 10px; color: var(--ink2, #6b7280); font-variant-numeric: tabular-nums; }
.hc-xaxis span { opacity: .75; }
@media (prefers-reduced-motion: reduce) { .hc-spin { animation-duration: 2s; } }
</style>
