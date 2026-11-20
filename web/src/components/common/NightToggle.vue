<template>
  <!-- 全站夜间模式开关：同时切 3D 基础光、房间地面亮度与 DOM 主题 -->
  <button class="night-toggle tv-clickable" :class="{ on: night }"
    :title="night ? '切回白天' : '夜间模式'" @click="toggle">
    <svg v-if="night" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8" />
      <path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"
        fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
    </svg>
    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.5 13.2A8.6 8.6 0 0 1 10.8 3.5 8.6 8.6 0 1 0 20.5 13.2z"
        fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
    </svg>
  </button>
</template>

<script>
/* lighting.js 是模块级单例（不是 Pinia —— 两个 HTML 入口各自 createApp），
 * 所以这里自读状态 + 订阅 ha3d:lighting 事件：零 props / 零 emits，
 * 展示页与编辑页各自把组件丢进顶栏即可，不需要父组件透传。
 * 另一页切换时 lighting.js 的 storage 监听会广播同一个事件，两页按钮同步。
 * 图标用内联 SVG：编辑页不引 MDI 字体，空壳 WebView 的 Unicode 字形也不可靠。 */
import { LIGHTING_EVENT, isNight, setNight } from '../../engine/lighting.js';

export default {
  name: 'NightToggle',
  data() { return { night: false }; },
  created() { this.night = isNight(); },
  mounted() {
    this._onLighting = (ev) => {
      this.night = ev && ev.detail ? !!ev.detail.night : isNight();
    };
    window.addEventListener(LIGHTING_EVENT, this._onLighting);
    this.night = isNight();   // 启动序列可能晚于挂载才 initLighting，再读一次
  },
  beforeUnmount() { window.removeEventListener(LIGHTING_EVENT, this._onLighting); },
  methods: {
    toggle() { setNight(!this.night); this.night = isNight(); },
  },
};
</script>

<style scoped>
.night-toggle {
  width: 34px; height: 34px; flex: none; border-radius: 12px;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ink2); background: var(--glass-soft);
  border: 1px solid var(--line); cursor: pointer;
  touch-action: manipulation; -webkit-tap-highlight-color: transparent;
  transition: background .16s, color .16s, border-color .16s;
}
.night-toggle:hover { background: var(--glass-hover); color: var(--ink); }
/* 只在展示页出现（编辑页已移除入口）；开态用 --on 系列，夜间不刺眼 */
.night-toggle.on { color: var(--on-ink); background: var(--on-bg); border-color: var(--on-line); }
.night-toggle svg { width: 17px; height: 17px; display: block; }
</style>
