<template>
  <!-- 一次性动作按钮：只由 type: 'button' 的控件渲染（引擎 COMPONENTS 一一对应）。
       服务名 / 参数 / 目标实体全在插件声明里，按钮只负责 emit。
       没写 action 时与 CardToggle 一致禁用，避免出一个点不动的假按钮。
       点按走 v-tap：窄屏滚动后不会被浏览器补发的 click 误触发。 -->
  <button class="dc-btn" :disabled="node._disabled || !node.action" v-tap="fire">
    {{ node.label || '执行' }}
  </button>
</template>

<script>
import { vTap } from '../../../composables/useTap.js';

export default {
  name: 'CardButton',
  directives: { tap: vTap },
  props: { node: { type: Object, required: true } },
  emits: ['act'],
  methods: {
    fire() { this.$emit('act', this.node); },
  },
};
</script>

<style scoped>
/* 统一尺度（2026-11-14）：高 36px、圆角 10px、字 13px，与胶囊同一套描边/投影语言。
   ⚠ studio 只读版 CardButton 用同一组几何值。 */
/* 底色用 --card-tile 而不是 --bg：夜间 --bg(#0a0a0a) 比毛玻璃卡片(#151515)还黑，
   按钮会在卡片里凹成一块黑斑；--card-tile 夜间 #1c1c1e / 白天纯白，
   与分段控件选中块、胶囊同一套浮起语言。 */
.dc-btn {
  display: flex; align-items: center; justify-content: center;
  width: 100%; min-width: 0; height: 36px; padding: 0 8px; border-radius: 10px;
  background: var(--card-tile); border: 1px solid var(--ctrl-line);
  box-shadow: 0 1px 3px rgba(31, 45, 71, .07);
  font-size: 13px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background .14s, border-color .14s;
}
.dc-btn:hover { background: var(--on-bg); border-color: var(--ctrl-hover-line); color: var(--ctrl-hover-ink); }
.dc-btn:active { transform: translateY(1px); }
.dc-btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
