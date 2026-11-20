<template>
  <!-- 唯一的卡片组件：全屋 / 房间 / 单设备都走这里，没有第二套壳。
       数据层（useCards + CardEngine）已经统一成 { title, icon, blocks, _single }，
       三者只在「填进哪些设备」上不同：外壳 + 块渲染（多个插件返回的单个元素
       按 columns 在 4 列栅格里平铺，返回二维数组的设备出完整子卡）。
       卡头只有图标 + 标题 —— 不放面积 / 分类统计 /
       设备状态 / 关闭按钮，关闭走页面自己的交互（点空白 / 卡片开关）。 -->
  <!-- HA 实体没就绪（_ready === false）时卡片不渲染正式内容 —— 与设备 label 同一策略：
       等数据加载好再展示，避免先出一张实体 id 名字（ke fang kai guan…）的卡再闪成中文。
       但必须留一行占位：否则 HA 一直连不上时面板里「什么都不出现」，
       外部看起来就是「点房间没反应」，无从判断是加载中还是坏了。 -->
  <div v-if="!ready" class="dc-wait">正在同步设备…</div>
  <section v-else class="dc-shell" :class="{ 'is-preview': preview }">
    <div class="dc-tag" v-if="preview">卡片预览</div>
    <header class="dc-head">
      <!-- 卡头图标三级形态（useCards icoOf：HA icon → style.icon → 类型 emoji）：
           HA 实体的 mdi 图标 → @mdi/font 字体；style.icon 的 SVG → v-html
           （stroke=currentColor 跟随 .dc-ico 颜色）；emoji / 文本 → 原样显示 -->
      <span class="dc-ico">
        <i v-if="ico.svg" class="dc-ico-svg" v-html="ico.svg"></i>
        <i v-else-if="ico.mdi" class="mdi" :class="'mdi-' + ico.mdi"></i>
        <template v-else>{{ ico.emoji }}</template>
      </span>
      <b class="dc-title">{{ node.title || '未命名' }}</b>
      <!-- 单设备视图：电源开关上移到整卡总标题右侧（全屋/房间则上移到每个设备子卡标题，
           由 CardDevices 负责）。完全复用插件自身的 isOn 与 click，见 CardPowerToggle。 -->
      <CardPowerToggle v-if="node._single && singleCard" class="dc-head-right"
        :eid="singleCard._entityId" :type="singleCard._type" :style="singleCard._style"
        :click-flag="singleCard._click" :click-svc="singleCard._clickSvc"
        :dev="singleCard._dev" @act="relay" />
    </header>
    <div class="dc-body">
      <p class="dc-empty" v-if="!blocks.length">{{ emptyText }}</p>
      <CardDevices v-else :blocks="blocks" :single="node._single" @act="relay" />
    </div>
  </section>
</template>

<script>
import CardDevices from './CardDevices.vue';
import CardPowerToggle from './CardPowerToggle.vue';

export default {
  name: 'CardView',
  components: { CardDevices, CardPowerToggle },
  props: {
    node: { type: Object, required: true },
    preview: { type: Boolean, default: false },
  },
  emits: ['act'],
  computed: {
    /* HA 实体就绪才渲染（useCards 建树时写入 _ready；缺省视为就绪，兼容手造节点） */
    ready() { return this.node._ready !== false; },
    /* 卡头图标统一成描述符 { svg | mdi | emoji }：
     * 单设备视图 icon 是 useCards icoOf 的对象；全屋 / 房间还是 emoji 字符串（历史形态），
     * SVG 字符串（旧数据 / 手造节点）也归到 svg 形态，兜底 📦。 */
    ico() {
      const i = this.node.icon;
      if (i && typeof i === 'object') return i;
      if (typeof i === 'string' && /^<svg[\s>]/i.test(i)) return { svg: i };
      return { emoji: i || '📦' };
    },
    /* 容器层已把「单元素平铺块」和「完整设备卡」排好序，这里只按顺序画 */
    blocks() { return this.node.blocks || this.node._cards || []; },
    /* 单设备视图：整卡总标题右侧电源开关取唯一那张设备子卡（它带 _eid/_type/_style） */
    singleCard() {
      if (!this.node._single) return null;
      const b = (this.blocks || [])[0];
      return (b && b.kind === 'card' && b.card) ? b.card : null;
    },
    emptyText() {
      if (this.node._single) return '该设备没有可显示的控件。';
      if (this.node._roomId) return '本房间暂无可控制的设备';
      return '本楼层暂无可控制的设备';
    },
  },
  methods: {
    relay(node, value) { this.$emit('act', node, value); },
  },
};
</script>

<style scoped>
/* 实体未就绪占位：与卡片同宽同圆角，视觉上像「卡片骨架」而不是错误提示 */
.dc-wait {
  background: var(--panel); border-radius: 14px; padding: 12px 14px;
  font-size: 12.5px; color: var(--ink2); text-align: center;
  box-shadow: var(--card-shadow);
}
.dc-shell {
  position: relative; background: var(--panel); border-radius: 14px;
  box-shadow: var(--card-shadow);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
}
.dc-shell.is-preview { border: 1px dashed var(--card-border); box-shadow: 0 8px 22px rgba(20, 30, 50, .14); }
/* 卡头尺度（2026-11-14 统一）：图标徽标 30px、标题 14.5px、预览标签 11px、
   空态 13px —— 与加高后的按钮保持同一视觉重量。⚠ studio 只读版 CardView 同步。 */
.dc-tag {
  position: absolute; top: -1px; left: 10px; transform: translateY(-100%);
  font-size: 11px; line-height: 1; color: var(--tag-ink); background: var(--tag-bg);
  border: 1px dashed var(--card-border); border-bottom: none; border-radius: 6px 6px 0 0;
  padding: 3px 7px;
}
.dc-head {
  display: flex; align-items: center; gap: 9px; padding: 11px 13px 10px;
  border-bottom: 1px solid var(--line); flex: none;
}
.dc-ico {
  width: 30px; height: 30px; border-radius: 9px; background: var(--blue-soft);
  display: flex; align-items: center; justify-content: center; font-size: 15px; flex: none;
  color: var(--blue);
}
/* SVG 形态的 style.icon：ico() 固定产出 22×22，这里统一压到 20px 与徽标留白更匀；
 * 线条用 currentColor，跟随上面的 color（--blue）。v-html 内容需 :deep 穿透。 */
.dc-ico :deep(svg) { width: 20px; height: 20px; display: block; }
.dc-title {
  flex: 1; min-width: 0; font-size: 14.5px; font-weight: 700; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 单设备视图：电源开关推到整卡总标题最右 */
.dc-head-right { margin-left: auto; display: flex; align-items: center; flex: none; }
/* body 铺一层比面板稍深的底色：它既是卡的内边距留白，也是各子卡（group / grid）
 * 之间间隙透出的颜色 —— 子卡都是白色圆角块（见 CardDevices），块间 gap 8px。 */
.dc-body {
  padding: 10px 12px 12px; overflow-y: auto; overscroll-behavior: contain; min-height: 0;
  background: var(--card-body);
}
.dc-empty { font-size: 13px; color: var(--ink2); text-align: center; padding: 14px 0; }
</style>
