/*
 * cardMixins.js — 卡片控件通用片段（审计 2.15）
 *
 * dis() 在 CardRange / CardChoice / CardToggle / CardSelect（+CardButton 的
 * :disabled 同口径）五处同式；relay() 在 CardView / CardDevices / CardGroup /
 * CardPane 四处逐字重复 —— 收敛为两个可组合的 mixin，组件按需引入。
 */
/* 禁用口径（computed dis）：节点显式禁用，或没有可执行的动作配置 */
export const cardDisabled = {
  computed: {
    dis() { return !!(this.node._disabled || !this.node.action); },
  },
};

/* 动作冒泡（method relay）：控件本身不执行，统一向上转给卡片层 */
export const cardRelay = {
  methods: {
    relay(node, value) { this.$emit('act', node, value); },
  },
};
