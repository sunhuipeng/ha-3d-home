<template>
  <template v-if="o.type === 'range'">
    <input type="range" :min="o.min" :max="o.max" :step="o.step || 1" :value="o.value" @input="$emit('set', o.key, parseFloat($event.target.value))">
    <input class="num-s" type="number" :min="o.min" :max="o.max" :step="o.step || 1" :value="o.value" @change="$emit('set', o.key, parseFloat($event.target.value))">
  </template>
  <input v-else-if="o.type === 'number'" type="number" :step="o.step || 1" :value="o.value" @change="$emit('set', o.key, parseFloat($event.target.value))">
  <select v-else-if="o.type === 'select'" :value="o.value" @change="$emit('set', o.key, $event.target.value)">
    <option v-for="c in (o.choices || [])" :key="c.value" :value="c.value">{{ c.label }}</option>
  </select>
  <label class="sp-check" v-else-if="o.type === 'checkbox'">
    <input type="checkbox" :checked="!!o.value" @change="$emit('set', o.key, $event.target.checked)">
    <span>{{ o.tip || '启用' }}</span>
  </label>
  <input v-else :value="o.value" @change="$emit('set', o.key, $event.target.value)">
</template>

<script>
/*
 * option-row — 插件参数控件行（背景参数 / 门窗样式参数等所有 options schema 共用）
 * schema 条目 o（range/number/select/checkbox/text 五类，value 已由调用方合并好默认值）；
 * 改动即 emit('set', key, value)，存哪、怎么触发实时预览由父级决定
 */
export default {
  name: 'OptionRow',
  props: {
    o: { type: Object, required: true },
  },
  emits: ['set'],
};
</script>
