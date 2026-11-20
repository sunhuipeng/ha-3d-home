/**
 * v-tap —— 面板按钮的统一点按语义（Vue 自定义指令，Options API 组件局部注册即可）。
 *
 * 解决的问题见 model/tapGesture.js：窄屏滚动是 JS 手动分发的，浏览器会把「在按钮上
 * 按下 → 滑走 → 松手」照常合成 click，误触发开关 / 场景 / 脚本。这里把点击的判定权
 * 从浏览器的合成 click 收回到应用层的 pointer 序列：
 *
 *   pointerdown  记起点、快照惯性状态，并 preventDefault() 压住兼容性鼠标事件
 *                （含合成 click）、文本选择与长按菜单 —— 这是根治点；
 *   pointermove  相对起点超过 TAP_MOVE_PX 即判「有意滑动」；
 *   pointerup    只有「没滑动 + 页面没判滚动 + 按下时不在惯性中 + 抬手仍在按钮内」
 *                才提交；惯性中的第一下只用来刹停，不执行动作；
 *   click        宽屏 / 鼠标 / 键盘（detail===0）走原生 click；窄屏触摸路径一律吞掉，
 *                防双触发，也防某个 WebView 仍在滚动后补发 click。
 *
 * 不显式 setPointerCapture：触摸自带 implicit capture，pointermove / pointerup 一定会
 * 回到按下时的元素；而且「抬手是否还在按钮内」必须用坐标 + 实时矩形判（见 tapInside）。
 *
 * 与 CardChoice / CardRange 是同一套模型（pointer 自接管 + 阈值 + 松手提交），
 * 那两个组件后续可逐步收敛过来；此处先覆盖所有裸 @click 的按钮。
 */
import { useUiStore } from '../stores/ui.js';
import {
  gestureState, tapExceedsMove, tapInside, tapShouldFire,
} from '../model/tapGesture.js';

/* 极老 WebView 没有 Pointer Events 时不能启用状态机，否则收不到 pointerdown，
   按钮会彻底点不动。此时 onClick 退化为原生 click，宁可偶尔误触也要保住可用。 */
const HAS_POINTER = typeof window !== 'undefined'
  && (typeof window.PointerEvent === 'function' || 'onpointerdown' in window);

/* 合成 click 一定紧随同一次 pointer 序列。超出这个窗口的 click 视为孤立点击
   （上次触摸没派发 click、辅助设备直接触发 click），放行而不是吞掉 ——
   否则一次异常序列会把按钮永久卡在「点不动」。只用于关联事件，不是防误触时间窗。 */
const TAP_CLICK_WINDOW_MS = 700;

/* 版面模式从 ui store 取，与卡片控件 / 手势白名单是同一份真相。
   两个入口都在 mount 前 app.use(pinia)，事件回调执行时 activePinia 已就位；
   读不到（单测 / 独立渲染）时按宽屏处理，行为退化为原生 click。 */
function defaultNarrow() {
  try { return !useUiStore().viewportWide; }
  catch (_) { return false; }
}

function createState(el, handler, isNarrow, hasPointer) {
  const st = {
    handler: typeof handler === 'function' ? handler : () => {},
    armed: false,        // 本轮 pointer 序列已进入 tap 判定
    sawPointer: false,   // 本次 click 之前是否收到过我们的 pointerdown
    lastDownAt: 0,       // 最近一次 tap 模式 pointerdown 的时间（关联合成 click）
    committedAt: 0,      // 最近一次 pointerup 真正提交的时间（紧随的 click 必须吞）
    id: null, x0: 0, y0: 0,
    moved: false, wasFling: false, cancelled: false,

    onDown(e) {
      st.sawPointer = false;
      st.lastDownAt = 0;
      st.committedAt = 0;
      /* 宽屏、鼠标（精确指针）、无 PointerEvent：整段交回浏览器原生 click */
      if (!hasPointer || !isNarrow() || e.pointerType === 'mouse') { st.armed = false; return; }
      /* 多指 / 非主键：直接取消本轮，不重置成第二根手指的状态 */
      if (st.armed && st.id !== e.pointerId) { st.armed = false; return; }
      if (e.isPrimary === false || (e.button != null && e.button !== 0)) { st.armed = false; return; }
      st.armed = true;
      st.sawPointer = true;
      st.lastDownAt = Date.now();
      st.id = e.pointerId;
      st.x0 = e.clientX;
      st.y0 = e.clientY;
      st.moved = false;
      st.cancelled = false;
      /* 按下瞬间快照：pointerdown 早于 touchstart，而 PanelApp 在 touchstart 里
         会 _flingStop()，所以只能在这里读到「按下时惯性还在跑」。 */
      st.wasFling = gestureState.flingRunning;
      /* 压住兼容性鼠标事件（含合成 click）。不阻止 touch 事件本身，
         PanelApp 的 document touchstart / touchmove 照常收到并分发滚动。 */
      if (e.cancelable) e.preventDefault();
    },

    onMove(e) {
      if (!st.armed || e.pointerId !== st.id) return;
      if (tapExceedsMove(st.x0, st.y0, e.clientX, e.clientY)) st.moved = true;
    },

    onUp(e) {
      if (!st.armed || e.pointerId !== st.id) return;
      const inside = tapInside(el.getBoundingClientRect(), e.clientX, e.clientY);
      const fire = tapShouldFire({
        moved: st.moved,
        gestureMoved: gestureState.moved,
        wasFling: st.wasFling,
        cancelled: st.cancelled,
        inside,
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      });
      st.armed = false;
      if (fire) {
        st.committedAt = Date.now();   // 本次点按已提交，紧随的 click 必须吞掉
        st.handler(e);
      }
    },

    onCancel(e) {
      if (!st.armed || e.pointerId !== st.id) return;
      st.cancelled = true;
      st.armed = false;
    },

    onClick(e) {
      const now = Date.now();
      /* 这次 click 是不是刚才那串 pointer 的补发：pointerup 已经判过「该不该提交」，
         所以不管它带什么 detail 都要吞掉，否则一次点按执行两遍。
         以前用 `e.detail === 0` 当「键盘激活」放行 —— 但部分手机浏览器 / WebView
         给合成 click 的 detail 也是 0，于是窄屏触摸每次点按都跑两遍：
         开完立刻关（提示恒为「已关闭」），表现就是「点了没反应」。
         键盘 / 辅助设备 / 上次触摸没派发 click 的孤立点击都没有 pointerdown，
         fromPointer 为假，照常放行，行为零变化。 */
      const justCommitted = st.committedAt > 0 && (now - st.committedAt) < TAP_CLICK_WINDOW_MS;
      const fromPointer = justCommitted
        || (st.sawPointer && st.lastDownAt > 0 && (now - st.lastDownAt) < TAP_CLICK_WINDOW_MS);
      /* 宽屏 / 无 PointerEvent / 鼠标 / 孤立 click：原生 click 照旧 */
      if (!hasPointer || !isNarrow() || !fromPointer) {
        st.committedAt = 0;
        st.handler(e);
        return;
      }
      /* 窄屏触摸：提交与否已由 pointerup 决定，这里一律吞掉（防双触发与误触）。
         消费掉标记，之后若来了孤立 click 仍可正常触发。 */
      st.sawPointer = false;
      st.committedAt = 0;
      e.preventDefault();
      e.stopPropagation();
    },
  };
  return st;
}

/**
 * 工厂：默认实现读 ui store 的 viewportWide；单测可注入 isNarrow / hasPointer，
 * 在零浏览器的 Node 里把整条 pointer 事件流跑一遍（见 tests/v-tap-directive.test.mjs）。
 */
export function createTapDirective(opts = {}) {
  const isNarrow = opts.isNarrow || defaultNarrow;
  const hasPointer = opts.hasPointer == null ? HAS_POINTER : !!opts.hasPointer;
  return {
    mounted(el, binding) {
      const st = createState(el, binding.value, isNarrow, hasPointer);
      el.__tapState = st;
      /* TV 焦点导航标记：engine/tvFocus.js 按 .tv-clickable 收集可聚焦元素。
       * classList 守卫只为单测的假元素桩（真实 DOM 恒有 classList）。 */
      if (el.classList) el.classList.add('tv-clickable');
      el.addEventListener('pointerdown', st.onDown);
      el.addEventListener('pointermove', st.onMove);
      el.addEventListener('pointerup', st.onUp);
      el.addEventListener('pointercancel', st.onCancel);
      el.addEventListener('click', st.onClick);
    },
    /* v-for 里常写 v-tap="() => focus(item)"，每次渲染都是新函数，必须同步 */
    updated(el, binding) {
      const st = el.__tapState;
      /* ★ 关键：把 tv-clickable 补回来★
       * 指令 mounted 时用 classList.add 命令式加的 class 不在 Vue vnode 的 class 记录里。
       * 元素若同时有声明式 :class（楼层按钮 :class="{on: i===activeIndex}"、房间/场景/
       * 工具按钮同理），当那个状态变化触发 Vue patch class 时，Vue 会按自己记录的旧 class
       * 字符串重写 className，把命令式加的 tv-clickable 抹掉（实测：切层后楼层按钮从
       * "on tv-clickable" 变成 "on"，于是 tvFocus.collect() 收不到楼层区 → 进不去楼层）。
       * updated 在每次这类 patch 后都会触发，无条件补回即可根治，且 add 幂等无副作用。 */
      if (el.classList && !el.classList.contains('tv-clickable')) el.classList.add('tv-clickable');
      if (st && binding.value !== st.handler) {
        st.handler = typeof binding.value === 'function' ? binding.value : () => {};
      }
    },
    unmounted(el) {
      const st = el.__tapState;
      if (!st) return;
      if (el.classList) el.classList.remove('tv-clickable');
      el.removeEventListener('pointerdown', st.onDown);
      el.removeEventListener('pointermove', st.onMove);
      el.removeEventListener('pointerup', st.onUp);
      el.removeEventListener('pointercancel', st.onCancel);
      el.removeEventListener('click', st.onClick);
      delete el.__tapState;
    },
  };
}

export const vTap = createTapDirective();
export default vTap;
