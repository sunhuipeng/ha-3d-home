<template>
  <!-- 下拉单选：_options 由引擎归一化成 [{value,label}]（插件可写静态中文表，也可写 'attr:source_list'）。
       用下标做 option 的 value，回传时还原原始值 —— 这样 option 里的布尔 / 数字不会被转成字符串。
       滚轮刻意不拦截（不写 @wheel.stop）：放行冒泡到 PanelApp 的 document 监听，
       鼠标停在下拉框上也能滚右栏卡片；onStageWheel 的 preventDefault 会挡住滚轮误改选项值。 -->
  <div class="dc-row dc-select" :class="{ dis: dis }">
    <span class="dc-label">{{ node.label || node.attr || '选项' }}</span>
    <select class="tv-clickable" :value="selected" :disabled="dis" @change="onChange" @pointerdown.stop>
      <option v-if="selected < 0" value="-1" disabled>--</option>
      <option v-for="(o, i) in node._options" :key="i" :value="i">{{ o.label }}</option>
    </select>
  </div>
</template>

<script>
import { cardDisabled } from './cardMixins';

export default {
  name: 'CardSelect',
  mixins: [cardDisabled],
  props: { node: { type: Object, required: true } },
  emits: ['act'],
  computed: {
    selected() {
      const list = this.node._options || [];
      const v = this.node._value;
      if (v == null) return -1;
      return list.findIndex((o) => String(o.value) === String(v));
    },
  },
  methods: {
    onChange(e) {
      const o = (this.node._options || [])[Number(e.target.value)];
      if (o) this.$emit('act', this.node, o.value);
    },
  },
};
</script>

<style scoped>
.dc-row { min-width: 0; }
.dc-select { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
/* 统一尺度（2026-11-14）：下拉高 36px、字 13px，与动作按钮 / 胶囊同量级。 */
.dc-label { font-size: 13px; color: var(--ink2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
select {
  min-width: 0; max-width: 100%; flex: 1; height: 36px; padding: 0 9px; border-radius: 10px;
  border: 1px solid var(--ctrl-line); background: var(--card-tile); color: var(--ink); font-size: 13px; outline: none;
  box-shadow: 0 1px 3px rgba(31, 45, 71, .07);
}
select:focus { border-color: var(--blue); background: var(--card-tile); }
.dc-select.dis { opacity: .45; }
</style>
