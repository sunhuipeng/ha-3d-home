<template>
  <!-- 全屋 / 房间：分段控件，带「该房间开着几个」角标 -->
  <div class="p-rooms" id="tv-zone-rooms">
    <TransitionGroup name="room" tag="div" class="p-room-track">
      <button key="__all" class="p-room" :class="{ on: allActive }" v-tap="() => focus(null)">全屋</button>
      <button class="p-room" v-for="r in rooms" :key="r.id" :class="{ on: activeId === r.id }"
        :title="r.name" v-tap="() => focus(r.id)">
        <span class="pr-name">{{ r.name }}</span>
        <span class="pr-badge" v-if="r.badge">{{ r.badge }}</span>
      </button>
    </TransitionGroup>
  </div>
</template>

<script>
/* 无状态：房间列表（含亮灯角标数）由父页派生好后传入，选中态只按 allActive / activeId 判断。
   activeId=null 且 allActive=false 表示选中了单个设备 —— 与旧版一样不高亮任何分段。
   点按走 v-tap：房间条横滚后不会误切选中范围。 */
import { vTap } from '../../../composables/useTap.js';

export default {
  name: 'RoomTabs',
  directives: { tap: vTap },
  props: {
    rooms: { type: Array, default: () => [] },          // [{ id, name, badge }]
    allActive: { type: Boolean, default: false },
    activeId: { type: [String, Number], default: null },
  },
  emits: ['focus'],
  methods: {
    focus(id) { this.$emit('focus', id); },
  },
};
</script>

<style scoped>
.p-rooms { grid-area: rooms; position: relative; z-index: 1; min-width: 0; }
.p-room-track {
  display: flex; align-items: center; gap: 4px; padding: 2px;
  background: transparent; border: none; overflow-x: auto; scrollbar-width: none;
  /* 鼠标滚轮在本条上横向滚动时，不让浏览器把滚动链到下面的 .p-cards-body */
  overscroll-behavior: contain;
}
.p-room-track::-webkit-scrollbar { display: none; }
.p-room {
  flex: 0 0 auto; height: 30px; padding: 0 12px; border: 1px solid transparent; border-radius: 9px;
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 13px; color: var(--room-ink); white-space: nowrap;
  transition: background .15s, color .15s, box-shadow .15s;
}
/* 换位用 FLIP 平移（配合 composable 里 350ms 的位置防抖）：只动 transform，
   不触发重排回流；全屋按钮 key="__all" 恒定在首位，不会被动画打乱。 */
.room-move { transition: transform .28s ease; }
@media (prefers-reduced-motion: reduce) { .room-move { transition: none; } }

.p-room:hover { background: var(--glass-soft); color: var(--ink); }
.p-room.on {
  background: var(--glass-hover); color: var(--ink); font-weight: 600;
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  box-shadow: 0 1px 5px rgba(20, 30, 50, .10);
}
.pr-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px;
  background: var(--badge-bg); color: #fff; font-size: 10px; font-weight: 700; line-height: 1;
}

@media (min-width: 1024px), (min-width: 768px) and (min-height: 450px) and (min-aspect-ratio: 13/10) {
  .p-room-track { padding: 2px 14px 2px 2px; }
}
</style>
