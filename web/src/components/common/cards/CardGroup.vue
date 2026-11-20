<template>
  <!-- 设备卡的控件渲染器：只按 node.rows 排版（每个子数组一行，总 4 列）。
       type → 用哪个组件由 cards/registry.js 统一注册决定，占几列由引擎算好的 _span 决定。
       纯 props + emit act，不读 store、不调 HA —— 服务调用统一由页面壳的 run() 执行。 -->
  <div class="dc-lines">
    <div class="dc-line" v-for="(row, ri) in node.rows" :key="ri">
      <div v-for="(c, ci) in row" :key="key(c, ci)" class="dc-cell"
        :style="{ gridColumn: 'span ' + (c._span || 4) }">
        <component v-if="comp(c)" :is="comp(c)" :node="c" @act="relay" />
      </div>
    </div>
  </div>
</template>

<script>
import { cardComponentOf } from './registry.js';

export default {
  name: 'CardGroup',
  props: {
    node: { type: Object, required: true },
  },
  emits: ['act'],
  methods: {
    relay(node, value) { this.$emit('act', node, value); },
    comp(c) { return cardComponentOf(c); },
    /* key 用「类型 + 实体 + 属性 + 下标」：结构不变时不会因为值变化而重建控件，
     * 否则滑块拖到一半会被卸载，draft 直接丢。 */
    key(c, i) { return (c.type || 'x') + '|' + (c._eid || c.label || '') + '|' + (c.attr || '') + '|' + i; },
  },
};
</script>

<style scoped>
.dc-lines { display: flex; flex-direction: column; gap: 9px; }
.dc-line { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; align-items: center; }
.dc-cell { min-width: 0; }
</style>
