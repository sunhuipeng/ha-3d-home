<template>
  <!-- 卡片 body 的块渲染器（全屋 / 房间 / 单设备共用）：
       · grid 块 = 多个插件返回的「单个元素」聚合，按规则在 4 列栅格里平铺：
         整块只有 1 个元素 → 全宽（含插件没写 cards() 的兜底单开关）；
         多个元素 → 插件显式写了 columns 就按它（1~4），没写默认 2 列（半行，一行两个）。
         一行最少 1 个、最多 4 个，超出自适应折行。占列统一由本组件的 spanOf 决定。
         switch / bool 统一用 CardToggle 的胶囊（与 group 内的开关完全同一套样式），
         胶囊里显示设备名；其它类型带独立设备名小格。
       · card 块 = 插件返回二维数组（group）的设备，出完整子卡。
       所有块都是白色圆角子卡，块与块之间 gap 8px，间隙里露出 body 的浅灰底
       （CardView.dc-body #f2f5fa），卡本身再留一圈内边距。
       容器层（CardEngine.buildListCard）已经把顺序与分块算好，这里只负责画。 -->
  <div class="dc-blocks">
    <template v-for="(b, bi) in blocks" :key="blockKey(b, bi)">
      <div v-if="b.kind === 'grid'" class="dc-grid">
        <div v-for="(c, ci) in b.items" :key="tileKey(c, ci)" class="dc-tile"
          :style="{ gridColumn: 'span ' + spanOf(b.items, c) }">
          <!-- 开关类（switch / bool）统一交给 CardToggle 画胶囊，设备名覆盖掉控件 label -->
          <CardToggle v-if="isToggle(c)" :node="c" :text="c._title || c.label" @act="relay" />
          <template v-else>
            <div class="dc-tile-name" v-if="!single">{{ c._title }}</div>
            <component v-if="comp(c)" :is="comp(c)" :node="c" @act="relay" />
          </template>
        </div>
      </div>

      <div v-else class="dc-dev">
        <div class="dc-dev-head" v-if="!single">
          <b>{{ b.card.title }}</b>
          <!-- 设备子卡标题右侧的电源开关：完全复用插件自身的 isOn 与 click，见 CardPowerToggle -->
          <CardPowerToggle class="dc-head-right"
            :eid="b.card._entityId" :type="b.card._type" :style="b.card._style"
            :click-flag="b.card._click" :click-svc="b.card._clickSvc"
            :dev="b.card._dev" @act="relay" />
        </div>
        <!-- 单设备没有子卡标题行，电源开关上移到 CardView 整卡总标题右侧 -->
        <CardGroup :node="b.card" @act="relay" />
      </div>
    </template>
  </div>
</template>

<script>
import CardGroup from './CardGroup.vue';
import CardPowerToggle from './CardPowerToggle.vue';
import { CARD_COMPONENTS, cardComponentOf } from './registry.js';
import { cardRelay } from './cardMixins';

export default {
  name: 'CardDevices',
  mixins: [cardRelay],
  components: { CardGroup, CardPowerToggle, CardToggle: CARD_COMPONENTS.CardToggle },
  props: {
    /* CardEngine.buildListCard 产出的 blocks（grid / card 两种） */
    blocks: { type: Array, default: () => [] },
    /* 单设备选中态：卡头已有设备名，子卡不再重复那一行 */
    single: { type: Boolean, default: false },
  },
  emits: ['act'],
  methods: {
    comp(c) { return cardComponentOf(c); },
    isToggle(c) { return c.type === 'switch' || c.type === 'bool'; },
    /* 网格块内每位的占列（总 4 列）：
     *   · 整块只有 1 个元素 → 全宽 4（插件没写 cards() 的兜底单开关也走这里，不再半宽）
     *   · 多个元素 → 插件显式写了 columns 就按它（夹到 1~4），没写默认 2 列（半行）
     * 4 列栅格，天然一行 1~4 个；span 之和超 4 时由 CSS grid 自动折行。 */
    spanOf(items, item) {
      if (!items || items.length <= 1) return 4;
      if (!item._explicit) return 2;
      const n = Number(item.columns);
      return Number.isFinite(n) ? Math.min(4, Math.max(1, Math.round(n))) : 2;
    },
    tileKey(c, i) { return (c._eid || '') + '|' + (c.attr || '') + '|' + i; },
    /* 块的稳定标识 key：用设备实体 id（card 块）或聚合的 solo 实体 id（grid 块），
     * 不用下标 bi。这样切换选中设备时每个子卡都是独立身份，Vue 会正确销毁/新建，
     * 不会把上一个房间的子卡 DOM 复用成当前设备的、导致「标题变了内容没变」。 */
    blockKey(b, i) {
      if (b.kind === 'grid') return 'g:' + (b.items || []).map((it) => it._eid || it.label || '').join(',');
      return 'c:' + ((b.card && (b.card._entityId || b.card.title)) || ('x' + i));
    },
  },
};
</script>

<style scoped>
/* 块纵列：gap 就是子卡之间的间隙，底色由 CardView.dc-body 提供 */
.dc-blocks { display: flex; flex-direction: column; gap: 8px; }

/* ---- 白色子卡（grid 与 group 同一外壳） ---- */
.dc-grid, .dc-dev {
  background: var(--card-tile); border-radius: 12px; padding: 10px 12px; min-width: 0;
}

/* ---- grid：4 列栅格，columns 决定占列 ---- */
.dc-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.dc-tile { min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 3px; }
/* 子卡文字尺度（2026-11-14 统一）：设备名 11.5px、子卡标题 13.5px，
   与加高后的按钮同量级。⚠ studio 只读版 CardDevices 同步。 */
.dc-tile-name {
  font-size: 11.5px; color: var(--ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ---- 完整子卡（group 设备）头部 ----
 * 布局：标题靠左；右侧的电源开关（CardPowerToggle，class=dc-head-right）被
 *       margin-left:auto 推到最右，完全复用插件自身的 isOn 与 click。 */
.dc-dev-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.dc-dev-head b { font-size: 13.5px; font-weight: 700; color: var(--ink); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 设备子卡标题右侧的电源开关：推到最右 */
.dc-head-right { margin-left: auto; display: flex; align-items: center; flex: none; }
</style>
