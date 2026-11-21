<template>
  <!-- 楼层切换：竖向一列，贴着 3D 可视带下沿（略微探入间隙，离场景行只留一点距离） -->
  <div class="p-floors" id="tv-zone-floors">
    <button v-for="(f, i) in floors" :key="f.id" :class="{ on: i === activeIndex }"
      :title="f.name" v-tap="() => select(i)">{{ f.name }}</button>
  </div>
</template>

<script>
/* 无状态：楼层列表与当前下标由父页给，点击只把下标 emit 回去。
   点按走 v-tap：楼层条贴着 3D 可视带下沿，上滑压缩手势经过时不会误切层。 */
import { vTap } from '../../../composables/useTap.js';

export default {
  name: 'FloorSwitch',
  directives: { tap: vTap },
  props: {
    floors: { type: Array, default: () => [] },
    activeIndex: { type: Number, default: 0 },
  },
  emits: ['select'],
  methods: {
    select(i) { this.$emit('select', i); },
  },
};
</script>

<style scoped>
.p-floors {
  position: absolute; left: 10px; bottom: calc((1 - var(--p-band)) * 100dvh - 4px);
  display: flex; flex-direction: column; align-items: stretch; gap: 2px;
  padding: 3px; border-radius: 11px;
  background: var(--glass-soft); backdrop-filter: blur(10px) saturate(1.1);
  box-shadow: 0 1px 4px rgba(20, 30, 50, .07);
}
.p-floors button {
  flex: 0 0 auto; height: 26px; padding: 0 10px; border-radius: 8px;
  font-size: 12px; color: var(--floor-ink); white-space: nowrap; transition: background .15s, color .15s;
}
.p-floors button:hover { background: var(--glass-hover); color: var(--ink); }
.p-floors button.on { background: var(--card-tile); color: var(--ink); font-weight: 600; box-shadow: 0 1px 3px rgba(20, 30, 50, .12); }

@media (min-width: 1024px), (min-width: 768px) and (min-height: 450px) and (min-aspect-ratio: 13/10) {
  .p-floors { left: 16px; bottom: 16px; }
}
</style>
