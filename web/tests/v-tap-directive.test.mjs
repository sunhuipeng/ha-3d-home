/**
 * v-tap 指令的 pointer 事件流单测（零浏览器：mock DOM + 注入窄屏判定）。
 * 只验证「事件 → 是否提交」这条状态机，不涉及 Vue 挂载 / 真实设备。
 * 覆盖最关键的两条：轻点必须能触发；滚动后浏览器补发的 click 必须被吞掉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTapDirective } from '../src/composables/useTap.js';
import {
  gestureState, beginGesture, markGestureMoved, setFlingRunning,
} from '../src/model/tapGesture.js';

function mockEl(opts = {}) {
  const listeners = new Map();
  return {
    disabled: !!opts.disabled,
    __listeners: listeners,
    addEventListener(t, fn) {
      if (!listeners.has(t)) listeners.set(t, []);
      listeners.get(t).push(fn);
    },
    removeEventListener(t, fn) {
      const a = listeners.get(t) || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    getAttribute() { return opts.ariaDisabled ? 'true' : null; },
    getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 46 }; },
    fire(type, props = {}) {
      const e = {
        type, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0,
        clientX: 50, clientY: 23, detail: 1, cancelable: true,
        defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...props,
      };
      (listeners.get(type) || []).slice().forEach((fn) => fn(e));
      return e;
    },
  };
}

function mount(opts = {}) {
  beginGesture();
  setFlingRunning(false);
  const el = mockEl(opts.el);
  let calls = 0, lastCalls = 0;
  const handler = () => { calls++; };
  const dir = createTapDirective({
    isNarrow: () => opts.narrow !== false,
    hasPointer: opts.hasPointer !== false,
  });
  dir.mounted(el, { value: handler });
  return {
    el, dir, handler,
    calls: () => calls,
    delta: () => { const d = calls - lastCalls; lastCalls = calls; return d; },
  };
}

const PN = 'pointerdown', PM = 'pointermove', PU = 'pointerup', PC = 'pointercancel', CL = 'click';

test('宽屏：完全保持浏览器原生 click，pointerdown 不做任何拦截', () => {
  const m = mount({ narrow: false });
  const down = m.el.fire(PN);
  assert.equal(down.defaultPrevented, false);
  m.el.fire(PU);
  m.el.fire(CL);
  assert.equal(m.calls(), 1);
});

test('窄屏轻点：pointerdown 压住合成 click，pointerup 提交恰好一次', () => {
  const m = mount();
  const down = m.el.fire(PN);
  assert.equal(down.defaultPrevented, true, '根治点：从源头阻止兼容性 mouse/click 事件');
  m.el.fire(PU);
  assert.equal(m.calls(), 1, '抬手即提交，不等浏览器的 click');
  const click = m.el.fire(CL);
  assert.equal(m.calls(), 1, '补发的 click 被吞，不双触发');
  assert.equal(click.propagationStopped, true);
  assert.equal(click.defaultPrevented, true);
});

test('窄屏合成 click 带 detail=0：仍然只提交一次（手机浏览器/WebView 回归）', () => {
  /* 曾经的 bug：把 `detail === 0` 当成「键盘激活」放行，但部分手机浏览器给触摸
     合成 click 的 detail 也是 0 —— 一次点按跑两遍，开完立刻关，用户看到的是
     「点了没反应，提示恒为已关闭」。现在只认「是不是刚才那串 pointer 的补发」。 */
  const m = mount();
  m.el.fire(PN);
  m.el.fire(PU);
  assert.equal(m.calls(), 1, 'pointerup 提交一次');
  const click = m.el.fire(CL, { detail: 0 });
  assert.equal(m.calls(), 1, 'detail=0 的合成 click 也必须吞掉');
  assert.equal(click.defaultPrevented, true);
});

test('窄屏滚动（组件测到位移）：不提交，补发的 click 也不提交', () => {
  const m = mount();
  m.el.fire(PN);
  m.el.fire(PM, { clientX: 50, clientY: 60 });   // 竖向 37px，越过 8px
  m.el.fire(PU, { clientX: 50, clientY: 23 });   // 抬手又落回按钮上
  m.el.fire(CL);
  assert.equal(m.calls(), 0, '滚动后抬手，即使回到按钮也不能触发');
});

test('窄屏滚动（只有页面手势判到）：gestureState.moved 兜住漏收的 pointermove', () => {
  const m = mount();
  m.el.fire(PN);
  markGestureMoved();                              // 模拟 PanelApp 的 touchmove
  m.el.fire(PU);
  m.el.fire(CL);
  assert.equal(m.calls(), 0);
});

test('惯性中轻点只刹停；惯性停稳后立刻恢复可点（状态而非时间窗）', () => {
  const m = mount();
  setFlingRunning(true);
  m.el.fire(PN);                                   // pointerdown 快照到 flingRunning
  setFlingRunning(false);                          // touchstart 里 _flingStop()
  m.el.fire(PU);
  m.el.fire(CL);
  assert.equal(m.calls(), 0, '惯性中第一下不执行动作');

  beginGesture();
  m.el.fire(PN);
  m.el.fire(PU);
  assert.equal(m.calls(), 1, '惯性停了立即能点，不等 300ms');
});

test('抬手滑出按钮 / pointercancel / 禁用态都不提交', () => {
  const a = mount();
  a.el.fire(PN);
  a.el.fire(PU, { clientX: 160, clientY: 23 });   // 落在 rect 外
  a.el.fire(CL);
  assert.equal(a.calls(), 0);

  const b = mount();
  b.el.fire(PN);
  b.el.fire(PC);
  b.el.fire(CL);
  assert.equal(b.calls(), 0, '来电 / 系统中断手势');

  const c = mount({ el: { disabled: true } });
  c.el.fire(PN);
  c.el.fire(PU);
  assert.equal(c.calls(), 0, '按下后 HA 回推把按钮置灰');
});

test('鼠标 / 键盘 / 无 PointerEvent 的 WebView：都退回原生 click，按钮点得动', () => {
  const mouse = mount();
  mouse.el.fire(PN, { pointerType: 'mouse' });
  assert.equal(mouse.el.__tapState.armed, false);
  mouse.el.fire(PU, { pointerType: 'mouse' });
  mouse.el.fire(CL);
  assert.equal(mouse.calls(), 1, '窄窗口里用鼠标调试仍可点');

  const keyboard = mount();
  keyboard.el.fire(CL, { detail: 0 });
  assert.equal(keyboard.calls(), 1, '键盘 Enter/Space 与无障碍路径');

  const legacy = mount({ hasPointer: false });
  legacy.el.fire(PN);
  legacy.el.fire(PU);
  legacy.el.fire(CL);
  assert.equal(legacy.calls(), 1, '极老 WebView 没有 pointer 事件，不能让按钮点不动');
});

test('updated 换 handler / unmounted 摘监听', () => {
  const m = mount();
  let newer = 0;
  m.dir.updated(m.el, { value: () => { newer++; } });
  m.el.fire(PN); m.el.fire(PU);
  assert.equal(m.calls(), 0, '旧 handler 不再被调用');
  assert.equal(newer, 1, 'v-for 重渲染后的新 handler 生效');

  m.dir.unmounted(m.el);
  m.el.fire(PN); m.el.fire(PU); m.el.fire(CL);
  assert.equal(newer, 1, '卸载后所有监听已摘除');
  assert.equal(m.el.__listeners.get(CL).length, 0);
});

test('吞过一次 click 后标记被消费：孤立 click 仍放行，按钮不会永久点不动', () => {
  const a = mount();
  a.el.fire(PN); a.el.fire(PU); a.el.fire(CL);   // 轻点提交一次，补发的 click 被吞
  assert.equal(a.calls(), 1);
  a.el.fire(CL);                                  // 同一次手势后的孤立 click
  assert.equal(a.calls(), 2);

  const b = mount();
  b.el.fire(PN); b.el.fire(PU);                   // 轻点提交，但这次压根没派发 click
  assert.equal(b.calls(), 1);
  /* 模拟时间流逝：关联窗口内的「补发 click」两个时间戳都要过期。
     真实场景里 700ms 后来的 click 基本不可能还是同一次手势的补发。 */
  b.el.__tapState.lastDownAt = Date.now() - 5000;
  b.el.__tapState.committedAt = Date.now() - 5000;
  b.el.fire(CL);
  assert.equal(b.calls(), 2, '上次触摸没有 click 时，后续孤立 click 不能一直被吞');
});

test('gestureState 是模块单例：指令读到的就是 PanelApp 写的那份', () => {
  const m = mount();
  beginGesture();
  assert.equal(gestureState.moved, false);
  assert.equal(m.el.__tapState.wasFling, false, '按下前还没快照（初值 false）');
  markGestureMoved();
  m.el.fire(PN);
  m.el.fire(PU);
  assert.equal(m.calls(), 0);
});
