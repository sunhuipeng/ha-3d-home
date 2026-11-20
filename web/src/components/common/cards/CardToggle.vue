<template>
  <!-- 开关控件：switch（state on/off，action 是一次性服务）与 bool（布尔属性，点一下取反）共用。
       两种位置都用同一个胶囊：左边文字、右边状态圆点，整块就是点击区域。
       · group 内的一行 → 显示 node.label（如「开关」「摆头」）
       · single 平铺的格子 → 由容器层传入设备名（node._title）
       状态由引擎算好的 node._on 给（switch 走 isOn 判定，bool 取 attr 的布尔值）。
       点按统一走 v-tap：窄屏由 pointer 序列判定，滚动后不会误触发（见 useTap.js）。 -->
  <button class="dc-chip" :class="{ on: node._on, dis: dis }"
    :disabled="dis" :title="node._title || caption" v-tap="fire">
    <!-- 设备图标（仅 single 平铺格有 _ico；group 行内开关不显示）。
         优先级：HA mdi 字体图标 → style.icon SVG / emoji，与卡头同一套描述符 -->
    <i v-if="ico.svg" class="dc-chip-ico" v-html="ico.svg"></i>
    <i v-else-if="ico.mdi" class="dc-chip-ico mdi" :class="'mdi-' + ico.mdi"></i>
    <span v-else-if="ico.emoji" class="dc-chip-ico">{{ ico.emoji }}</span>
    <span class="dc-chip-name">{{ caption }}</span>
    <span class="dc-chip-dot"></span>
  </button>
</template>

<script>
import { vTap } from '../../../composables/useTap.js';

export default {
  name: 'CardToggle',
  directives: { tap: vTap },
  props: {
    node: { type: Object, required: true },
    /* 容器层可覆盖显示文字：single 平铺时显示设备名，而不是控件自己的 label */
    text: { type: String, default: '' },
  },
  emits: ['act'],
  computed: {
    caption() { return this.text || this.node.label || '开 / 关'; },
    /* 没写 action 就是纯显示，不给点 */
    dis() { return !!(this.node._disabled || !this.node.action); },
    /* 设备图标描述符（{svg|mdi|emoji}）：只有 solo 平铺格由 buildListCard 挂了 _ico，
     * group 行内的开关节点没有 → 三项全空，不占位 */
    ico() {
      const i = this.node._ico;
      return i && typeof i === 'object' ? i : {};
    },
  },
  methods: {
    fire() {
      if (this.dis) return;
      /* bool 把取反后的值交给引擎写进 service_data；switch 不给值 */
      this.$emit('act', this.node, this.node.type === 'bool' ? !this.node._on : undefined);
    },
  },
};
</script>

<style scoped>
/* 所有 switch / bool 统一成这一枚胶囊：浅底 + 明确描边 + 轻投影 + 右侧状态点。
   统一尺度（2026-11-14）：高 46px、圆角 14px（圆角/高≈0.3，读作「块」而不是细长条）、
   字 13.5px、状态点 10px；边框与投影比旧版加深，避免叠在白色子卡上被「融掉」。
   开态换强调底 + 强调字/点：白天是原来那套蓝，夜间由 --on 系列变量自动换成
   中性深灰底 + 低饱和冷灰蓝（大面积亮蓝底在黑卡片里太跳，2026-11-15 实拍反馈）。
   禁用降透明度并禁止点击。
   ⚠ studio 的只读版 CardToggle 用同一组几何值，改这里要同步过去。 */
.dc-chip {
  display: flex; align-items: center; gap: 8px;
  width: 100%; min-width: 0; height: 46px; padding: 0 15px;
  border: 1px solid var(--card-border); border-radius: 14px; background: var(--card-chip);
  box-shadow: 0 1px 4px rgba(31, 45, 71, .09), 0 1px 0 var(--card-inset) inset;
  text-align: left; transition: background .16s, border-color .16s, box-shadow .16s, transform .12s;
}
.dc-chip:hover:not(.dis) { border-color: var(--card-border); background: var(--card-chip-hover); box-shadow: 0 2px 7px rgba(31, 45, 71, .13); }
.dc-chip:active:not(.dis) { transform: translateY(1px); }
.dc-chip:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
/* 左端设备图标：三形态统一 15px、颜色跟名字（开态随名字变蓝）；SVG 内容 :deep 压尺寸 */
.dc-chip-ico { flex: none; font-size: 15px; line-height: 1; color: var(--ink2); display: inline-flex; align-items: center; }
.dc-chip-ico :deep(svg) { width: 15px; height: 15px; display: block; }
.dc-chip.on .dc-chip-ico { color: var(--on-ink); }
.dc-chip-name {
  flex: 1; min-width: 0; font-size: 13.5px; color: var(--ink2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dc-chip-dot {
  width: 10px; height: 10px; border-radius: 50%; flex: none;
  background: var(--dot-idle); transition: background .16s, box-shadow .16s;
}
.dc-chip.on { background: var(--on-bg); border-color: var(--on-line); box-shadow: 0 2px 8px var(--on-shadow); }
.dc-chip.on:hover:not(.dis) { background: var(--on-bg-hover); border-color: var(--on-line); }
.dc-chip.on .dc-chip-name { color: var(--on-ink); font-weight: 600; }
.dc-chip.on .dc-chip-dot { background: var(--on-ink); box-shadow: 0 0 0 3px var(--on-glow); }
.dc-chip.dis { opacity: .45; cursor: not-allowed; }
</style>
