<template>
  <!-- 纯显示：只由 type: 'label' 的控件渲染（引擎 COMPONENTS 一一对应）。
       没 attr 读实体 state，有 attr 读属性值；option 可把枚举映射成中文。
       引擎已把 unit（插件声明或实体 unit_of_measurement）算好。
       ⚠ label 永远不响应点击；要按钮请写 type: 'button'。 -->
  <div class="dc-row dc-ro" :class="{ dis: node._disabled }">
    <span class="dc-label">{{ node.label || node.attr || '读数' }}</span>
    <span class="dc-v">
      <template v-if="node._value == null || node._value === ''">--</template>
      <template v-else>{{ node._value }}</template>
      <i v-if="node.unit">{{ node.unit }}</i>
    </span>
  </div>
</template>

<script>
export default {
  name: 'CardReadonly',
  props: { node: { type: Object, required: true } },
};
</script>

<style scoped>
.dc-row { min-width: 0; }
.dc-ro { display: flex; align-items: center; justify-content: space-between; gap: 5px; flex-wrap: wrap; }
/* 统一尺度（2026-11-14）：读数 13.5px / 标签 13px / 单位 11px。 */
.dc-label { font-size: 13px; color: var(--ink2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dc-v { font-size: 13.5px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
.dc-v i { font-size: 11px; color: var(--ink2); font-style: normal; margin-left: 1px; }
.dc-ro.dis { opacity: .5; }
</style>
