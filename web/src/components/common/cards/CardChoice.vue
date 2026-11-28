<template>
  <!-- 选项组（choice）：select 的按钮组形态 —— option/options、attr、
       action/param 的取值与带值契约和 select 完全一致，只是 UI 从下拉换成
       分段控件（segmented）：浅灰蓝底槽里并排选项，当前值是白色浮起块。
       选项多时整组换行，不挤压标签。原生 button，不依赖 Element Plus。

       防误触（JS 接管滚动时）：原生 button「点即执行」在触屏上太容易蹭到，所以读全局
       jsGesture（窄屏 ∥ app 宽屏 TV 模式）—— 这些场景纵向滚动由 JS 分发，必须把
       点按收成「按住任意位置 → 滑到目标选项 → 松手才提交」；原地轻点 / 划出组外 /
       系统中断一律零请求。浏览器宽屏保持点即切换（鼠标精确，且滚动是浏览器原生）。
       模式来自 Pinia ui store，与 PanelApp 的手势白名单是同一份真相。 -->
  <div class="dc-row dc-choice" :class="{ dis: dis, sliding: dragId != null }"
    :data-slide="slide ? '1' : null">
    <span class="dc-label" v-if="node.label">{{ node.label }}</span>
    <div ref="group" class="seg-group" :class="{ 'is-slide': slide }" role="group"
      :aria-label="slide ? (node.label || '选项') + '：按住滑动到目标选项，松手生效' : null"
      :title="slide ? '按住滑动到目标选项，松手生效' : null"
      @pointerdown.stop="onPointerDown" @pointermove="onPointerMove"
      @pointerup="onPointerUp" @pointercancel="onPointerCancel">
      <button v-for="(o, i) in options" :key="i" type="button"
        class="seg-btn tv-clickable" :class="{ on: isActive(o), pre: isPending(i) }"
        :disabled="dis" @click="onClick(o, $event)">{{ o.label }}</button>
    </div>
  </div>
</template>

<script>
import { mapState } from 'pinia';
import { useUiStore } from '../../../stores/ui';
import { cardDisabled } from './cardMixins';

const MOVE = 8;   // 起滑阈值：位移超过 8px 才算「有意滑动」，否则松手一律不提交

export default {
  name: 'CardChoice',
  mixins: [cardDisabled],
  props: { node: { type: Object, required: true } },
  emits: ['act'],
  data() {
    /* dragId != null = 本轮滑动进行中；pendingIdx = 当前预选中的选项下标 */
    return { dragId: null, startX: 0, startY: 0, moved: false, pendingIdx: -1 };
  },
  computed: {
    ...mapState(useUiStore, ['jsGesture']),
    options() { return this.node._options || []; },
    /* 与 CardSelect 同口径：没 action / 实体不可用都禁用 */
    /* 只有「JS 接管滚动 + 可用」才进滑动模式（窄屏 ∥ app 宽屏 TV 模式）。
       PanelApp.onStageTouchStart 的白名单读 data-slide，与这里同一个判定，
       不会「页面放行手势但组件还在点选」。浏览器宽屏则是点即切换。 */
    slide() { return this.jsGesture && !this.dis; },
    /* 值可能是数字 / 布尔，统一按字符串比对（引擎归一化选项时也是 String） */
    curIdx() {
      return this.options.findIndex((o) => String(o.value) === String(this.node._value));
    },
  },
  watch: {
    /* HA 回推 / 换设备：丢掉未完成的预选，避免残留高亮 */
    'node._value'() { if (this.dragId == null) this.pendingIdx = -1; },
    /* 跨断点时若在拖动中（拖着窗口改宽度），直接清场 */
    slide() { this.resetDrag(); },
  },
  beforeUnmount() { this.resetDrag(); },
  methods: {
    isActive(o) { return String(o.value) === String(this.node._value); },
    isPending(i) {
      return this.dragId != null && this.moved && i === this.pendingIdx && i !== this.curIdx;
    },
    pick(o) {
      if (this.dis) return;
      this.$emit('act', this.node, o.value);
    },
    /* 宽屏：点即切换。窄屏：指针 click 一律不提交（提交只由 onPointerUp 负责）；
       键盘触发的 click（detail === 0）仍保留直点 —— 键盘是离散的有意操作，
       不存在误触，也给外接键盘 / 无障碍留一条路。 */
    onClick(o, e) {
      if (this.dis) return;
      if (this.slide && e && e.detail !== 0) return;
      this.pick(o);
    },

    /* ---------------- 窄屏滑动 ---------------- */
    onPointerDown(e) {
      if (!this.slide) return;
      /* 自愈：万一漏了 pointerup（capture 失败 / 系统吞事件），新的按下先清场，
         不会把控件永久卡在 dragId != null */
      if (this.dragId != null && this.dragId !== e.pointerId) this.resetDrag();
      if (this.dragId != null) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const el = this.$refs.group;
      if (!el) return;
      e.preventDefault();   // 压住文本选择 / 长按菜单 / 焦点，避免补发 click 干扰
      this.dragId = e.pointerId;
      this.startX = e.clientX;
      this.startY = e.clientY;
      this.moved = false;
      this.pendingIdx = this.curIdx;
      /* 一次缓存所有选项的屏幕矩形：选项是 flex-wrap，窄屏可能折成两行，
         命中必须二维算，不能像 range 那样只按 clientX 线性映射 */
      this._rects = Array.from(el.querySelectorAll('.seg-btn')).map((b) => b.getBoundingClientRect());
      this._box = el.getBoundingClientRect();
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* 不支持时仍可靠冒泡拖 */ }
    },
    onPointerMove(e) {
      if (this.dragId == null || this.dragId !== e.pointerId) return;
      if (!this.moved) {
        const dx = e.clientX - this.startX, dy = e.clientY - this.startY;
        if (Math.hypot(dx, dy) <= MOVE) return;   // 阈值内还不算起滑，保持原位
        this.moved = true;
      }
      this.pendingIdx = this.hitIndex(e.clientX, e.clientY);
    },
    onPointerUp(e) {
      if (this.dragId == null || this.dragId !== e.pointerId) return;
      const idx = this.pendingIdx, moved = this.moved;
      this.resetDrag(e.pointerId);
      /* 三个条件缺一不可：确实滑动过、落在某个选项上、且不是当前值。
         原地轻点 / 划出组外 / 滑回当前项 → 一律零请求 */
      if (!moved || idx < 0 || idx === this.curIdx) return;
      const o = this.options[idx];
      if (o) this.pick(o);
    },
    onPointerCancel(e) {
      if (this.dragId == null || this.dragId !== e.pointerId) return;
      this.resetDrag(e.pointerId);   // 系统中断手势：预选还没确认，绝不提交
    },
    resetDrag(id) {
      const el = this.$refs.group;
      const pid = id != null ? id : this.dragId;
      if (el && pid != null && el.hasPointerCapture && el.hasPointerCapture(pid)) {
        el.releasePointerCapture(pid);
      }
      this.dragId = null;
      this.moved = false;
      this.pendingIdx = -1;
      this._rects = null;
      this._box = null;
    },
    /* 二维命中：先找包含点的按钮；落在按钮间隙但仍在整组内时取中心最近的；
       划出整组返回 -1（松手取消）。 */
    hitIndex(x, y) {
      const rs = this._rects || [];
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i];
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
      }
      const b = this._box;
      if (!b || x < b.left || x > b.right || y < b.top || y > b.bottom) return -1;
      let best = -1, dist = Infinity;
      for (let i = 0; i < rs.length; i++) {
        const r = rs[i];
        const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
        if (d < dist) { dist = d; best = i; }
      }
      return best;
    },
  },
};
</script>

<style scoped>
.dc-row { min-width: 0; }
.dc-choice { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dc-label { font-size: 13px; color: var(--ink2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; }
/* 分段控件外壳：浅灰蓝底槽 + 细边 + 小圆角（12px，与卡片/子卡同尺度，
   不要 999px —— 选项换行时胶囊会被拉成一条怪异的超长圆角条）。
   按钮内边距压紧，6 个两字选项（如空调的 自动/制冷/制热/除湿/送风/关闭）能在
   一排内放下，避免最后一个选项被挤到第二行、看着像独立控件。
   统一尺度（2026-11-14）：选项高 25→30px、槽圆角/内边距同步放大，字号只到 13px
   —— 再大会把 6 个选项挤到第二行。⚠ studio 只读版 CardChoice 用同一组几何值。 */
.seg-group {
  display: flex; flex: 1 1 auto; min-width: 0; flex-wrap: wrap; gap: 2px;
  padding: 4px; border: 1px solid var(--card-border); border-radius: 12px; background: var(--card-body);
}
/* 窄屏滑动态：显式 touch-action:none（不依赖祖先 .p-shell，大屏页 / 编辑页
   预览没有那层也能拖），虚线外框暗示「这一组要滑」，不占任何布局空间 */
.seg-group.is-slide {
  touch-action: none; user-select: none; -webkit-user-select: none;
  border-style: dashed; border-color: var(--seg-slide-line); cursor: grab;
}
.dc-choice.sliding .seg-group { cursor: grabbing; }
.seg-btn {
  flex: 1 1 auto; min-width: 0; height: 30px; padding: 0 7px;
  border: 1px solid transparent; border-radius: 9px;
  background: transparent; color: var(--ink2);
  font-size: 13px; line-height: 1; font-family: inherit; cursor: pointer;
  white-space: nowrap;
  transition: background .15s, color .15s, box-shadow .15s, border-color .15s;
}
.seg-btn:hover { background: var(--card-chip-hover); color: var(--ink); }
/* 选中 = 浮起块 + 强调字（与工具栏/目录选中态同语言），不再用黑色实心。
   强调色走 --on-*：夜间自动降饱和，不会在黑卡片里跳出一块亮蓝。 */
.seg-btn.on { background: var(--card-tile); border-color: var(--on-line); color: var(--on-ink); font-weight: 600; box-shadow: 0 2px 5px rgba(31, 45, 71, .14); }
.seg-btn.on:hover { background: var(--card-tile); }
/* 滑动态下给当前白块右上角加一个极小的双向箭头，纯装饰、不占布局，
   用来提示「从这一组滑动选择」—— 否则用户点不动会以为控件坏了 */
.seg-group.is-slide .seg-btn.on { position: relative; }
.seg-group.is-slide .seg-btn.on::after {
  content: '⇄'; position: absolute; right: 1px; top: -3px;
  font-size: 8px; line-height: 1; font-weight: 400; color: var(--on-ink);
  pointer-events: none;
}
/* 预选：虚线强调框 + 淡底，与「当前值 = 浮起块」明显区分，且不换文案 */
.seg-btn.pre {
  background: var(--seg-pre-bg); border-color: var(--on-line); border-style: dashed;
  color: var(--on-ink); font-weight: 600;
  box-shadow: 0 0 0 1px var(--seg-pre-glow);
}
.seg-btn.pre:hover { background: var(--seg-pre-bg); }
.seg-btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
.seg-btn:disabled { cursor: not-allowed; }
.dc-choice.dis { opacity: .45; }
</style>
