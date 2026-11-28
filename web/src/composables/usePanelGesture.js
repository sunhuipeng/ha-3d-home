/*
 * composables/usePanelGesture.js — 控制面板手势体系（原 PanelApp.vue 的「窄屏手势」方法组）
 *
 * 与 useStageCamera 同一口径：导出方法组对象，根组件摊进 methods，`this` 绑定
 * 到组件实例，纯搬运零行为变化。依赖的组件上下文：this.jsGesture / this.wide /
 * this.inApp（ui store 映射，手势白名单与分区判定共用同一份版面真相）。
 * 事件绑定仍留在根组件 mounted/beforeUnmount（passive 选项与清理在那边成对出现）。
 *
 * 覆盖：3D 可视带高度状态（_stageEnsure / _setStageH / _bandRefocus /
 * syncStageBandForViewport）→ 触摸手势（onStageTouchStart / _sampleMove /
 * onStageTouchMove / _stageGesture / _endStageGesture）→ 惯性（_flingStop /
 * _startFling / _flingFinish）→ 滚轮（onStageWheel）。
 * 纯计算前置在 model/panelGesture.js / model/tapGesture.js（可 Node 单测）。
 */
import { STAGE_BAND_INIT } from '../model/stageLayout.js';
import {
  stageBounds, wheelHScroll,
  splitVerticalGesture, sampleMove, flingVelocity, nextFlingVelocity, flingFrameDt,
} from '../model/panelGesture.js';
/* 窄屏点按判定：滚动是 JS 分发的，浏览器仍会合成 click。这里把「本次手势是否
   已经滚动」「惯性是否还在跑」写成唯一真相，v-tap 在抬手时读它决定要不要提交。 */
import {
  gestureState, beginGesture, markGestureMoved, setFlingRunning, tapExceedsMove,
} from '../model/tapGesture.js';

export const panelGestureMethods = {
  /* ---------------- 窄屏：3D 可视带可被上滑压缩 ----------------
     初始高度沿用 CSS 的 --p-band(.38)；手指上滑时按 1:1 跟随压缩，压到最小高度后
     剩余手势交给 .p-cards-body 原生滚动；下滑时反向：卡片先滚回顶部，再放开 3D 带。
     高度只改一个 CSS 变量：网格行、白纸羽化起点、楼层按钮、构图(stageMetrics)都读它。 */

  _stageEnsure() {
    const H = window.innerHeight || 1;
    const shell = document.querySelector('.p-shell');
    if (!shell) return false;
    this._shell = shell;
    this._cards = shell.querySelector('.p-cards-body') || null;
    const { max, min } = stageBounds(H);
    if (this._stageMax !== max || this._stageMin !== min) {
      const frac = this._stageFrac || STAGE_BAND_INIT;
      this._stageMax = max;
      this._stageMin = min;
      this._stageH = Math.max(min, Math.min(max, Math.round(H * frac)));
      this._stageFrac = this._stageH / H;   // 视口高度变了也保持 JS 与 CSS 同一个占比
    }
    return true;
  },

  /* 上滑只改 --p-band：白纸羽化层及以下整体上移，3D 画布尺寸不变、不 resize。
     _stageFrac 是上滑量换算出的「剩余可视高度占比」；stageMetrics 据此实测显示区域，
     用代码把房子平移过去并按新的宽高比重取景 —— 全程只动相机。 */
  _setStageH(px, quick) {
    const H = window.innerHeight || 1;
    const h = Math.max(this._stageMin, Math.min(this._stageMax, Math.round(px)));
    if (h === this._stageH) return false;
    this._stageH = h;
    this._stageFrac = h / H;
    if (this._shell) this._shell.style.setProperty('--p-band', String(this._stageFrac));
    this._visH = null;                   // 白纸/场景行位置变了：下一帧重新实测显示区域
    /* quick = 惯性阶段：每帧都 alignStageView + refocus 会在手机上掉帧，
       这里只改 CSS 变量，惯性收尾时由 _flingFinish() 统一补一次构图。 */
    if (quick) { this._bandDirty = true; return true; }
    this._bandRefocus();
    return true;
  },

  /* 重取景统一入口（_bandRaf 防抖：同帧多次改高度只算一次） */
  _bandRefocus() {
    this._bandDirty = false;
    if (this._bandRaf) return;
    this._bandRaf = requestAnimationFrame(() => {
      this._bandRaf = 0;
      this.alignStageView();            // 房子中心 1:1 跟手挪到新的显示区中心
      this.refocus(false, true, true);  // 平滑重取景：保留方向，按新宽高比调填充率
    });
  },

  /* 断点/视口变化：浏览器宽屏清掉内联变量（宽屏布局不用这条带）；
     app 宽屏（TV 模式）虽也清带，但要保留 JS 手势所需的 _cards 引用。 */
  syncStageBandForViewport() {
    this._visH = null;                   // 断点/视口变化：显示区域 DOM 位置要重测
    if (this.wide) {
      this._flingStop();                   // 断点变了：JS 接管的手势/惯性都不再适用
      if (this._shell) this._shell.style.removeProperty('--p-band');
      /* app 宽屏仍由 JS 接管卡片滚动（jsGesture 含 inApp），必须让 _cards 指向
         新的 .p-cards-body，否则滚卡片时容器是 null，表现就是「滑不动」。 */
      if (this.inApp && this._stageEnsure()) return;
      return;
    }
    if (!this._stageEnsure()) return;
    const H = window.innerHeight || 1;
    /* 与 stageMetrics 共用同一个「剩余高度占比」，CSS 白纸位置与相机构图不会各算一套 */
    const frac = (this._stageH || this._stageMax) / H;
    this._stageFrac = frac;
    this._shell.style.setProperty('--p-band', String(frac));
  },

  onStageTouchStart(e) {
    /* 任何新的触摸（包括点按卡片控件）都先打断惯性 —— 原生列表也是「按住即停」 */
    this._flingStop();
    /* 新的一轮触摸：清掉上一次的「已滚动」标记。v-tap 的 pointerdown 早于
       touchstart，它快照的是惯性状态，两处时序互不干扰。 */
    beginGesture();
    if (!this.jsGesture || !e.touches || e.touches.length !== 1) return;
    const shell = (e.target instanceof Element) ? e.target.closest('.p-shell') : null;
    if (!shell) return;
    /* 卡片滑块（CardRange.vue 自绘 range）只放行「按在把手上」的触摸：命中半径读
       .dc-slider 的 data-hit，与组件同一个值。按在轨道其它位置不响应、也不改值，
       仍要交回页面手势滚卡片，所以不能整块放行；禁用态同样交回。 */
    const sl = (e.target instanceof Element) ? e.target.closest('.dc-slider') : null;
    if (sl && sl.getAttribute('aria-disabled') !== 'true') {
      const th = sl.querySelector('.dc-thumb');
      const r = th && th.getBoundingClientRect();
      const t0 = e.touches && e.touches[0];
      const hit = Number(sl.dataset.hit || 20);
      if (r && t0 && Math.abs(t0.clientX - (r.left + r.width / 2)) <= hit) {
        this._gesture = null;
        return;
      }
    }
    /* 卡片选项组（CardChoice.vue 窄屏滑动版）：组件只在「窄屏 + 可用」时给
       .dc-choice 挂 data-slide，命中即代表它已用 pointer 事件接管这一组；
       整块放行，否则横向 touchmove 会被判成场景横滚并 preventDefault，永远滑不动。
       禁用态 / 宽屏没有该属性，触摸照常交回页面手势滚卡片。 */
    if (e.target instanceof Element && e.target.closest('.dc-choice[data-slide]')) {
      this._gesture = null;
      return;
    }
    if (!this._stageEnsure()) return;
    const t = e.touches[0];
    /* 只接管「羽化渐变层及其以下」：羽化层起点 = 3D 带下沿往上 18px
       （与 CSS .p-shell::after 的 top 一致）。上面那块 3D 区完全不接管，
       手指照样交给 OrbitControls 旋转。 */
    this._gesture = null;
    if (this.wide) {
      /* app 宽屏（TV 模式）：3D 铺满左栏、卡片在右竖栏，没有「3D 带下沿」这条线。
         只接管右栏（卡片 / 场景条 / 房间条）上的手势；左栏 3D 照旧交 OrbitControls。
         命中不足时（如点在中缝）宁可不接管，交原生也不出错。 */
      const right = (e.target instanceof Element)
        ? e.target.closest('.p-cards, .p-scenes, .p-rooms') : null;
      if (!right) return;
    } else if (t.clientY - shell.getBoundingClientRect().top < (this._stageH || this._stageMax) - 18) {
      /* 窄屏：羽化渐变层及其以下才接管；起点 = 3D 带下沿往上 18px
         （与 CSS .p-shell::after 的 top 一致），上面的 3D 区交 OrbitControls。 */
      return;
    }
    this._gesture = {
      x0: t.clientX, y0: t.clientY, lastX: t.clientX, lastY: t.clientY,
      mode: '',
      hScroll: e.target.closest('.p-scenes, .p-room-track') || null,
      /* 速度采样：每段位移 + 时间戳，只在抬手时用来算 fling 初速度 */
      samples: [], lastMoveT: 0,
    };
  },

  /* 记录一段位移采样，队列只留最近 FLING_WINDOW_MS（抬手前的减速/停顿能如实反映） */
  _sampleMove(g, move) {
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    g.lastMoveT = sampleMove(g.samples, move, now);
  },

  onStageTouchMove(e) {
    const g = this._gesture;
    if (!g || !this.jsGesture || !e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    /* 与 v-tap 共用同一个 8px 阈值：累计位移越过阈值才把本次触摸写成「滚动」。
       不能用下面 g.mode 的 4/6px 方向判定 —— 那会让轻点时的手抖把按钮一起否决。 */
    if (tapExceedsMove(g.x0, g.y0, t.clientX, t.clientY)) markGestureMoved();
    if (!g.mode) {
      const dx = Math.abs(t.clientX - g.x0), dy = Math.abs(t.clientY - g.y0);
      if (dx > 6 && dx > dy) g.mode = 'h';
      else if (dy > 4) g.mode = 'v';
      else return;
      g.lastX = t.clientX; g.lastY = t.clientY;   // 判定完再计增量，第一下不会突然跳一截
    }
    if (g.mode === 'h') {                          // 横向：展示项 / 房间横滚仍归原生容器（手动分发）
      const dx = g.lastX - t.clientX;
      g.lastX = t.clientX; g.lastY = t.clientY;
      if (g.hScroll) g.hScroll.scrollLeft += dx;
      this._sampleMove(g, dx);
      if (e.cancelable) e.preventDefault();
      return;
    }
    const dy = g.lastY - t.clientY;                // >0 上滑
    g.lastX = t.clientX; g.lastY = t.clientY;
    if (dy) {
      this._stageGesture(dy);
      this._sampleMove(g, dy);
    }
    if (e.cancelable) e.preventDefault();          // touch-action:none 下只是保险，避免系统回弹
  },

  /* 纵向增量分发（同一手势内跨阶段连续）：
     窄屏上滑先压 3D 带，压到最小后把剩余位移喂给卡片滚动；下滑反向。
     app 宽屏（TV 模式）没有可压缩的带（3D 铺满左栏、卡片在右竖栏），
     位移全部直接喂给卡片滚动 —— 否则用户上滑卡片时会去改一个不存在的带，
     卡片纹丝不动（本次修复）。 */
  _stageGesture(dy, quick) {
    const body = this._cards;
    if (this.wide) {
      if (body && dy) body.scrollTop += dy;
      return;
    }
    /* 纯拆分在 model/panelGesture.js（可单测）：算出目标 3D 带高度与 scrollTop，
       这里只负责把结果写回 CSS 变量 / 滚动容器 */
    const r = splitVerticalGesture(dy, {
      stageH: this._stageH, stageMin: this._stageMin, stageMax: this._stageMax,
      scrollTop: body ? body.scrollTop : 0, hasBody: !!body,
    });
    if (r.band !== this._stageH) this._setStageH(r.band, quick);
    if (body && r.scroll !== body.scrollTop) body.scrollTop = r.scroll;
  },

  /* 抬手：按最近一段手势的速度起一段惯性，补回被 touch-action:none 关掉的 momentum。
     touchcancel（来电 / 系统打断手势）不甩。 */
  onStageTouchEnd(e) { this._endStageGesture(true, e); },
  onStageTouchCancel(e) { this._endStageGesture(false, e); },

  _endStageGesture(allowFling, e) {
    const g = this._gesture;
    this._gesture = null;
    /* 过渡保险：确实滚动过的手势，在 touchend 压住浏览器补发的合成 click。
       v-tap 已在 pointerdown 从源头 preventDefault（根治），这里只兜住尚未迁移的
       裸 click 与各 WebView 的兼容性事件差异；正常轻点手势不受影响。
       mounted 里 touchend 必须是 passive:false，否则这里的 preventDefault 无效。 */
    if (e && e.type === 'touchend' && e.cancelable && gestureState.moved) {
      const t = e.target;
      if (t instanceof Element && t.closest('.p-shell')) e.preventDefault();
    }
    if (!allowFling || !this.jsGesture || !g || !g.mode) return;
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    /* 慢慢拖到位、停住再松手 → 不该再滑一段；采样窗口 / 限速 / 阈值都在纯函数里 */
    const v = flingVelocity(g.samples, now, g.lastMoveT);
    if (!v) return;
    this._startFling(g, v);
  },

  _flingStop() {
    if (this._flingRaf) { cancelAnimationFrame(this._flingRaf); this._flingRaf = 0; }
    setFlingRunning(false);
  },

  /* 惯性主体：每帧把「速度 × 帧时长」喂给同一套分发逻辑（3D 带 → 卡片），
     速度指数衰减；到顶/到底立刻停，不回弹。
     纵向走 _stageGesture(..., true)：惯性阶段不逐帧重取景，收尾补一次即可。 */
  _startFling(g, v0) {
    this._flingStop();
    const horizontal = g.mode === 'h';
    const el = horizontal ? g.hScroll : this._cards;
    if (!el) return;
    setFlingRunning(true);
    let v = v0, last = 0;
    const step = (now) => {
      /* 首帧按一整帧时长算，否则 last=0 会算出 dt≈1ms，位移太小被误判成「到边界」 */
      const dt = flingFrameDt(now, last);
      last = now;
      const before = horizontal ? el.scrollLeft : el.scrollTop;
      const h0 = this._stageH;
      const move = v * dt;
      if (horizontal) el.scrollLeft = before + move;
      else this._stageGesture(move, true);
      const moved = horizontal
        ? Math.abs(el.scrollLeft - before)
        : Math.abs((this._cards ? this._cards.scrollTop : 0) - before) + Math.abs(this._stageH - h0);
      if (moved < 0.2) { this._flingFinish(); return; }  // 到边界
      v = nextFlingVelocity(v, dt);
      if (Math.abs(v) < 0.02) { this._flingFinish(); return; }
      this._flingRaf = requestAnimationFrame(step);
    };
    this._flingRaf = requestAnimationFrame(step);
  },

  _flingFinish() {
    this._flingRaf = 0;
    setFlingRunning(false);
    /* 惯性期间若压过 / 放开过 3D 带：跟手阶段是逐帧构图，这里收尾补最后一次 */
    if (this._bandDirty) this._bandRefocus();
  },

  /* 滚轮：宽屏（PC 浏览器 / app TV 模式）与窄屏都主动接管，把纵向滚轮喂给
     卡片滚动 —— 这是 PC 宽屏支持鼠标滚轮的关键（不能像触摸那样按 jsGesture
     把浏览器宽屏放掉，否则滚轮只滚到 .p-shell 的 overflow:hidden 就到头了）。
     与触摸的区别只在判据：触摸交不交原生看 jsGesture，滚轮一律自己来。
     例外：鼠标停在横滚条（展示项 / 房间）上时，纵向滚轮只喂该条的 scrollLeft，
     条有溢出就整段吞掉（滚到边也不落到卡片，否则滚房间时卡片会跟着乱跳），
     放得下的条才回落到卡片。与触摸横滚用同一份元素白名单。 */
  onStageWheel(e) {
    const shell = (e.target instanceof Element) ? e.target.closest('.p-shell') : null;
    if (!shell) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;   // 横向滚轮放行给横滚容器
    /*          横滚条优先：竖向滚轮映射到 scrollLeft；条滚到边（handled=false）再往下走卡片。
       用 scrollWidth/clientWidth 判断真实溢出，元素放得下时不吞滚轮。 */
    if (e.deltaY) {
      const hs = (e.target instanceof Element)
        ? e.target.closest('.p-scenes, .p-room-track') : null;
      if (hs) {
        const r = wheelHScroll(e.deltaY, hs);
        if (r.handled) {
          hs.scrollLeft = r.scrollLeft;
          if (e.cancelable) e.preventDefault();
          return;
        }
      }
    }
    if (!this._stageEnsure()) return;
    if (this.wide) {
      /* app 宽屏：滚轮也只接管右栏（卡片 / 场景 / 房间），左栏留给 OrbitControls */
      const right = (e.target instanceof Element)
        ? e.target.closest('.p-cards, .p-scenes, .p-rooms') : null;
      if (!right) return;
    } else if (e.clientY - shell.getBoundingClientRect().top < (this._stageH || this._stageMax) - 18) {
      /* 窄屏：3D 带内不接管，滚轮留给 OrbitControls 缩放 */
      return;
    }
    if (e.deltaY) this._stageGesture(e.deltaY);
    if (e.cancelable) e.preventDefault();
  },
};
