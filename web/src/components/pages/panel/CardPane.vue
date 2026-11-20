<template>
  <!-- 卡片：全屋 / 房间 / 单设备共用同一个 CardView，容器常驻（窄屏手势要读
       .p-cards-body，整块 v-if 掉会留下失效的 DOM 引用）。
       cardView 为 null = 选中的设备没绑定主实体：统一不出卡，卡片内容整块不渲染，
       只留透明容器，不会露出「该设备没有可显示的控件」的空卡壳。 -->
  <div class="p-cards" id="tv-zone-cards" :class="{ 'is-single': single }">
    <div class="p-cards-head" v-if="cardView">
      <span class="pch-title">
        {{ cardView.title || '全屋' }}<span class="pch-sub"> · {{ scopeOn }} / {{ scopeTotal }} 开启</span>
      </span>
    </div>
    <div class="p-cards-body">
      <card-view v-if="cardView" :key="cardKey" :node="cardView" @act="onCardAct" />
    </div>
  </div>
</template>

<script>
import CardView from '../../common/cards/CardView.vue';

/* 无状态：卡片派生结果 / 统计 / key 全由父页给，卡片动作原样透传。
   .p-cards-body 是窄屏手势的滚动容器，类名与 id 都不能改。 */
export default {
  name: 'CardPane',
  components: { CardView },
  props: {
    cardView: { type: Object, default: null },
    cardKey: { type: String, default: '' },
    scopeOn: { type: Number, default: 0 },
    scopeTotal: { type: Number, default: 0 },
    single: { type: Boolean, default: false },
  },
  emits: ['act'],
  methods: {
    onCardAct(node, value) { this.$emit('act', node, value); },
  },
};
</script>

<style scoped>
.p-cards {
  grid-area: cards; position: relative; z-index: 1;
  min-height: 0; min-width: 0; display: flex; flex-direction: column;
}
.p-cards-head {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 2px 4px 8px; min-width: 0;
}
.pch-title {
  font-size: 13.5px; font-weight: 700; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pch-sub { font-weight: 400; color: var(--ink2); }

.p-cards-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; border-radius: 18px;
  /* 只隐藏滚动条外观，overflow-y:auto 保留 → 触摸/滚轮照常滚动（与场景条、房间条一致） */
  scrollbar-width: none; -ms-overflow-style: none; }
.p-cards-body::-webkit-scrollbar { display: none; }
.p-cards-body :deep(.dc-shell) {
  min-height: 100%;
  background: var(--glass);
  backdrop-filter: blur(22px) saturate(1.12); -webkit-backdrop-filter: blur(22px) saturate(1.12);
  box-shadow: 0 10px 30px rgba(20, 30, 50, .09);
}
/* 卡片头由 .p-cards-head 统一负责（有统计和批量开关）；单设备视图保留自带卡头（带电源键） */
.p-cards:not(.is-single) .p-cards-body :deep(.dc-head) { display: none; }
.p-cards-body :deep(.dc-body) { background: var(--body-soft); }
.p-cards-body :deep(.dc-tile),
.p-cards-body :deep(.dc-dev) { background: var(--tile-soft); }

@media (max-width: 1023px) {
  /* 卡片区通栏贴底；白底由上面那张纸提供，卡片自己不再叠一层白，避免两块白拼出硬边 */
  .p-cards { margin: 0 -10px -10px; }
  .p-cards-head { padding: 2px 12px 8px; }
  .p-cards-body { border-radius: 0; }
  .p-cards-body :deep(.dc-shell) { background: transparent; box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
  .p-cards-body :deep(.dc-body) { background: var(--body-soft); }
}

@media (min-width: 1024px) {
  .p-cards-head { padding: 2px 14px 8px 4px; }
  /* 卡片贴住右侧与底部：圆形/投影/自己那层白全收掉，纸面统一由这块竖栏提供
     （否则「竖栏 0.78 白 + 卡片 0.86 白」两层叠在一起，卡片左沿会露出一条竖台阶） */
  .p-cards-body { border-radius: 0; }
  .p-cards-body :deep(.dc-shell) {
    border-radius: 0; box-shadow: none;
    background: transparent;
    backdrop-filter: none; -webkit-backdrop-filter: none;
  }
  .p-cards-body :deep(.dc-body) { background: var(--body-soft); }
}
</style>
