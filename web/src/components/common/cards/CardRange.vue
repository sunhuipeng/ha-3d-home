<template>
  <!-- 自绘 range：不用 <input type="range">。原生控件的「点轨道即跳值」是浏览器内置行为，
       preventDefault 跨浏览器不稳，且 UA 内部的 value 会与 Vue 的 :value 脱钩（圆点跳走、
       数字不动）。自绘后交互完全可控：
       ① 窄屏只有按在椭圆把手上才启动拖动（按轨道其它位置不响应、不改值，防误触）；
          宽屏可直接点击轨道任意位置定位（鼠标是精确指针），按下即跟到手指处；
       ② 拖动中只改本地 draft —— 把手、左段填充与右侧数字实时跟随，**不发任何服务请求**；
       ③ 松手（pointerup / pointercancel）或键盘调完（keyup）才 emit 一次 action；
       ④ 发出后 1.2s 内 draft 优先，避免 HA 回推把值弹回旧值。
       滚轮刻意不拦截（不写 @wheel.stop）：自绘 range 本就不响应 wheel，放行让事件
       冒泡到 PanelApp 的 document 监听，鼠标停在滑条上也能滚右栏卡片。
       没写 action、实体不可用或 lock 未开机时整条禁用。 -->
  <div class="dc-row dc-range" :class="{ dis: dis }">
    <span class="dc-label">{{ node.label || node.attr || '数值' }}</span>
    <span class="dc-val">{{ shownText }}<i v-if="node.unit">{{ node.unit }}</i></span>
    <div ref="slider" class="dc-slider tv-clickable" :class="{ active: dragId != null, dis: dis, jump: !jsGesture && !dis }"
      :data-hit="HIT" role="slider" :tabindex="dis ? -1 : 0" data-tv-role="slider"
      :aria-label="node.label || node.attr || '数值'"
      :aria-valuemin="node._min" :aria-valuemax="node._max" :aria-valuenow="Number(shown)"
      :aria-valuetext="shownText + (node.unit || '')" :aria-disabled="dis ? 'true' : 'false'"
      @pointerdown.stop="onPointerDown" @pointermove="onPointerMove"
      @pointerup="onPointerUp" @pointercancel="onPointerCancel"
      @keydown="onKeyDown" @keyup="onKeyUp">
      <div class="dc-inner">
        <div class="dc-track"></div>
        <div class="dc-fill" :style="fillStyle"></div>
        <div class="dc-thumb" :style="{ left: pct }"></div>
      </div>
    </div>
  </div>
</template>

<script>
import { mapState } from 'pinia';
import { useUiStore } from '../../../stores/ui';
import { cardDisabled } from './cardMixins';

const PAD = 10;   // 滑块半宽：轨道两端各内缩 10px，椭圆把手不会画到卡片外（CSS .dc-inner 同步）
const HIT = 20;   // 命中半径：手指落在把手中心 ±20px 内才启动拖动（窄屏白名单读 data-hit）

export default {
  name: 'CardRange',
  mixins: [cardDisabled],
  props: { node: { type: Object, required: true } },
  emits: ['act'],
  data() {
    /* dirty = 本轮有未提交的值；dragId != null = 拖动进行中；keyKey = 待提交的键盘键 */
    return {
      draft: null, dragging: false, dirty: false, pending: false,
      dragId: null, grabDx: 0, keyKey: null, HIT,
    };
  },
  computed: {
    ...mapState(useUiStore, ['jsGesture']),
    /* 拖动中 / 刚发出还没回推 → 用本地值；否则用服务端值。
     * 注意 draft 可能被 watch 清空，这里必须判 null，否则值会跳到量程中点。 */
    shown() {
      if ((this.dragging || this.pending) && this.draft != null) return this.draft;
      const v = this.node._value;
      return v == null ? this.node._min : v;
    },
    /* 显示精度跟着 step 走（0.5 的温控不能显示成 24.0000001） */
    scalePow() {
      const s = Number(this.node._step) || 1;
      return s < 1 ? 2 : 0;
    },
    shownText() {
      const v = Number(this.shown);
      if (!isFinite(v)) return String(this.shown);
      return String(Number(v.toFixed(this.scalePow)));
    },
    /* 圆点位置：0~1，基于最终显示值（拖动中自然是 draft） */
    ratio() {
      const min = Number(this.node._min), max = Number(this.node._max);
      const v = Number(this.shown);
      if (!isFinite(min) || !isFinite(max) || max <= min || !isFinite(v)) return 0;
      return Math.min(1, Math.max(0, (v - min) / (max - min)));
    },
    pct() { return (this.ratio * 100).toFixed(3) + '%'; },
    /* 左段填充：ratio=0 时整块隐藏，否则 0 宽度的边框会画出一个小竖条 */
    fillStyle() { return { width: this.pct, opacity: this.ratio > 0 ? 1 : 0 }; },
  },
  watch: {
    /* 外部值变了（HA 回推 / 换设备）→ 丢掉本地草稿；pending 窗口内不动 */
    'node._value'() { if (!this.dragging && !this.pending) this.draft = null; },
  },
  beforeUnmount() {
    clearTimeout(this.pendTimer);
    if (this.dragId != null) this.endDrag(this.dragId);
  },
  methods: {
    /* 拖动中只写本地草稿：圆点与右侧数字实时跟随，不发请求 */
    setDraft(v) {
      if (v == null || !isFinite(v)) return;
      this.draft = v;
      this.dragging = true;
      this.dirty = true;
    },
    commit() {
      this.dragging = false;
      this.flush();
    },
    /* 圆点中心的屏幕 X —— 命中判定与 PanelApp 的白名单都按这个位置算 */
    thumbX() {
      const el = this.$refs.slider;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.left + PAD + Math.max(1, r.width - PAD * 2) * this.ratio;
    },
    onPointerDown(e) {
      if (this.dis || this.dragId != null) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const x = this.thumbX();
      /* 落在椭圆把手中心 ±HIT 内 = 按在把手上 */
      const onThumb = x != null && Math.abs(e.clientX - x) <= HIT;
      /* JS 接管滚动时（窄屏 ∥ app 宽屏 TV 模式）：没按在把手上就完全不响应 ——
         不 capture、不写草稿、不提交，手指继续滑动照常走页面手势，不会碰到滑条就改值
         （防误触核心）。浏览器宽屏：放开限制，像原生 range 一样点轨道任意位置直接
         定位 —— 鼠标是精确指针，不存在蹭一下的问题。按下即把值跟到手指处，拖动继续
         跟手，松手才 commit 发一次 action（点一下和按住拖是同一条路径，不会发两次）。 */
      if (!onThumb && this.jsGesture) return;
      e.preventDefault();
      const el = this.$refs.slider;
      this.dragId = e.pointerId;
      this.grabDx = onThumb ? (e.clientX - x) : 0;
      if (!onThumb) this.setDraft(this.valueFromX(e.clientX));   // 点轨道：立刻定位
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* 不支持 capture 时仍可靠冒泡拖 */ }
    },
    onPointerMove(e) {
      if (this.dragId == null || this.dragId !== e.pointerId) return;
      this.setDraft(this.valueFromX(e.clientX - this.grabDx));
    },
    onPointerUp(e) {
      if (this.dragId == null || this.dragId !== e.pointerId) return;
      this.endDrag(e.pointerId);
      this.commit();
    },
    onPointerCancel(e) {
      if (this.dragId == null || this.dragId !== e.pointerId) return;
      this.endDrag(e.pointerId);
      this.commit();          // 系统中断手势也按「结束」提交当前值，避免白拖
    },
    endDrag(id) {
      const el = this.$refs.slider;
      if (el && el.hasPointerCapture && el.hasPointerCapture(id)) el.releasePointerCapture(id);
      this.dragId = null;
    },
    /* 键盘：←→↑↓ ±step、PageUp/PageDown ±10step、Home/End 到端点。
       按住连发只改 draft，keyup 才提交一次，不刷服务请求 */
    onKeyDown(e) {
      if (this.dis) return;
      const step = Number(this.node._step) || 1;
      const min = Number(this.node._min), max = Number(this.node._max);
      if (!isFinite(min) || !isFinite(max) || max <= min) return;
      const cur = Number(this.shown);
      if (!isFinite(cur)) return;
      let v;
      switch (e.key) {
        case 'ArrowLeft': case 'ArrowDown': v = cur - step; break;
        case 'ArrowRight': case 'ArrowUp': v = cur + step; break;
        case 'PageDown': v = cur - step * 10; break;
        case 'PageUp': v = cur + step * 10; break;
        case 'Home': v = min; break;
        case 'End': v = max; break;
        default: return;
      }
      e.preventDefault();
      const snapped = min + Math.round((v - min) / step) * step;
      const nv = Math.min(max, Math.max(min, snapped));
      const digits = (String(step).split('.')[1] || '').length;
      this.setDraft(Number(nv.toFixed(Math.min(6, digits + 1))));
      this.keyKey = e.key;
    },
    onKeyUp(e) {
      if (this.keyKey == null || e.key !== this.keyKey) return;
      this.keyKey = null;
      this.commit();
    },
    /* clientX → 数值：轨道两端内缩 PAD，再按 step 从 min 起对齐 */
    valueFromX(clientX) {
      const el = this.$refs.slider;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const min = Number(this.node._min), max = Number(this.node._max);
      const step = Number(this.node._step) || 1;
      if (!isFinite(min) || !isFinite(max) || max <= min || !isFinite(step) || step <= 0) return null;
      const span = Math.max(1, r.width - PAD * 2);
      const ratio = Math.min(1, Math.max(0, (clientX - r.left - PAD) / span));
      const raw = min + (max - min) * ratio;
      const snapped = min + Math.round((raw - min) / step) * step;
      const v = Math.min(max, Math.max(min, snapped));
      const digits = (String(step).split('.')[1] || '').length;
      return Number(v.toFixed(Math.min(6, digits + 1)));
    },
    flush() {
      if (!this.dirty || this.draft == null || this.dis) return;
      this.dirty = false;    // 一轮拖动只发一次
      this.pending = true;
      this.$emit('act', this.node, Number(this.draft.toFixed(this.scalePow)));
      clearTimeout(this.pendTimer);
      this.pendTimer = setTimeout(() => {
        this.pending = false;
        this.draft = null;   // 交回服务端值；若服务端没接受，会如实跳回
      }, 1200);
    },
  },
};
</script>

<style scoped>
.dc-row { min-width: 0; }
.dc-range { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 2px 8px; }
/* 文字尺度与卡片内其它控件统一（13px）。轨道 20px / 把手 20×30 是上一轮定稿的
   视觉尺寸，本次刻意不动 —— 它与 script 的 PAD=10、HIT=20 强绑定，改了会脱钩。
   ⚠ studio 只读版 CardRange 同步文字尺度。 */
.dc-label { font-size: 13px; color: var(--ink2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dc-val { font-size: 13px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
.dc-val i { font-size: 11px; color: var(--ink2); font-style: normal; margin-left: 1px; }
.dc-slider {
  grid-column: 1 / -1; position: relative; width: 100%; height: 34px; outline: none;
  /* 窄屏 .p-shell 是 touch-action:none，祖先链求交集后浏览器默认手势本来就没有；
     拖动全靠自己的 pointer 事件 + setPointerCapture */
  touch-action: none; user-select: none; -webkit-user-select: none; cursor: default;
}
.dc-slider:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; border-radius: 999px; }
/* 轨道两端内缩 10px（= 滑块半宽 = script 里的 PAD），滑块在端点也不会出卡片 */
.dc-inner { position: absolute; left: 10px; right: 10px; top: 50%; height: 20px; transform: translateY(-50%); }
/* 右半段 / 整条底轨：中性灰。左段的彩色由 .dc-fill 盖在上面 */
.dc-track {
  position: absolute; inset: 0; z-index: 0; box-sizing: border-box;
  border: 1.5px solid var(--range-line); border-radius: 999px;
  background: var(--glass-soft); pointer-events: none;
}
/* 左侧已选段：强调色描边 + 淡色填充，右端被椭圆把手压住，形成层次。
   白天沿用原来的蓝，夜间由 --on-line / --range-fill 换成低饱和冷灰蓝。 */
.dc-fill {
  position: absolute; left: 0; top: 0; bottom: 0; z-index: 1; box-sizing: border-box;
  border: 1.5px solid var(--on-line); border-radius: 999px;
  background: var(--range-fill); pointer-events: none;
}
/* 竖向椭圆把手：比轨道高，卡片底色 + 强调描边，手指更容易瞄准 */
.dc-thumb {
  position: absolute; top: 50%; z-index: 2; box-sizing: border-box;
  width: 20px; height: 30px; border-radius: 999px;
  background: var(--card-tile); border: 2px solid var(--on-line); box-shadow: 0 1px 5px var(--thumb-shadow);
  transform: translate(-50%, -50%); cursor: grab;
  transition: transform .12s, box-shadow .12s;
}
.dc-slider.active .dc-thumb {
  transform: translate(-50%, -50%) scale(1.08); cursor: grabbing;
  box-shadow: 0 2px 10px var(--thumb-shadow-active);
}
/* 宽屏：整条轨道都可点，给个手型提示；窄屏保持 default（只有把手能按） */
.dc-slider.jump { cursor: pointer; }
.dc-slider.dis { cursor: not-allowed; }
.dc-slider.dis .dc-thumb { cursor: not-allowed; }
.dc-range.dis { opacity: .45; }
</style>
