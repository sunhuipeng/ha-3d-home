/*
 * tests/scene-runner.test.mjs — 展示项执行状态机单测（假时钟）
 *
 * 用可注入的 schedule / now 把「服务 → 回执确认 / 4s 超时 / 冷却 / ✓ 反馈」
 * 整条时间线在 Node 里跑完，锁定场景类重构前逐字一致的时序与文案；
 * 并覆盖 2026-11-15 新增的开关类（toggle 立即确认、300ms 短冷却）与按域分派。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSceneRunner, sceneConfirmed,
  SCENE_COOLDOWN_MS, SCENE_POLL_MS, SCENE_TIMEOUT_MS, SCENE_DONE_MS, TOGGLE_COOLDOWN_MS,
} from '../src/model/sceneRunner.js';

function fakeClock() {
  let t = 0, seq = 0;
  const q = new Map();
  return {
    now: () => t,
    schedule(fn, ms) {
      const id = ++seq;
      q.set(id, { fn, at: t + ms });
      return id;
    },
    unschedule(id) { q.delete(id); },
    get pending() { return q.size; },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, job] of q) {
          if (job.at <= end && (!next || job.at < next.job.at)) next = { id, job };
        }
        if (!next) break;
        q.delete(next.id);
        t = next.job.at;
        next.job.fn();
      }
      t = end;
    },
  };
}

function fakeHa(opt = {}) {
  const st = {
    entity_id: 'scene.movie',
    state: opt.state == null ? '2026-11-14T20:00:00' : opt.state,
    attributes: opt.last == null ? {} : { last_triggered: opt.last },
  };
  const calls = [];
  return {
    demo: !!opt.demo,
    state: st,
    calls,
    getState: () => st,
    friendly: (eid) => (opt.names && opt.names[eid]) || '观影模式',
    callService(domain, service, data) {
      calls.push({ domain, service, data });
      return opt.reject ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true });
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const SCENE = { eid: 'scene.movie', name: '观影模式', type: 'scene' };
const LIGHT = { eid: 'light.kitchen', name: '厨房灯', type: 'light' };

function setup(opt = {}) {
  const clock = fakeClock();
  const ha = fakeHa(opt);
  const toasts = [];
  const state = { busy: {}, done: {} };
  const runner = createSceneRunner({
    ha: () => ha,
    toast: (m) => toasts.push(m),
    state,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
    now: clock.now,
  });
  return { clock, ha, toasts, state, runner };
}

test('常量口径：场景类时序逐字一致，开关类短冷却', () => {
  assert.equal(SCENE_COOLDOWN_MS, 1200);
  assert.equal(SCENE_POLL_MS, 400);
  assert.equal(SCENE_TIMEOUT_MS, 4000);
  assert.equal(SCENE_DONE_MS, 1500);
  assert.equal(TOGGLE_COOLDOWN_MS, 300);
});

test('sceneConfirmed：state 变化 / last_triggered 变化 / 无状态', () => {
  const ha = { getState: () => ({ state: 'b', attributes: { last_triggered: 'L2' } }) };
  assert.equal(sceneConfirmed({ eid: 'x', preState: 'a', preLast: 'L1' }, ha), true);
  assert.equal(sceneConfirmed({ eid: 'x', preState: 'b', preLast: 'L1' }, ha), true);
  assert.equal(sceneConfirmed({ eid: 'x', preState: 'b', preLast: 'L2' }, ha), false);
  assert.equal(sceneConfirmed({ eid: 'x' }, { getState: () => null }), false);
  assert.equal(sceneConfirmed({ eid: 'x' }, null), false);
});

test('演示模式：服务发出后立刻确认，✓ 反馈 1500ms 后消失', async () => {
  const { clock, ha, toasts, state, runner } = setup({ demo: true });
  runner.run(SCENE);
  assert.equal(state.busy[SCENE.eid], true, '按下即进入执行中');
  assert.equal(toasts[0], '正在执行 · 观影模式');
  await tick();
  assert.deepEqual(ha.calls[0], { domain: 'scene', service: 'turn_on', data: { entity_id: 'scene.movie' } });
  assert.equal(state.busy[SCENE.eid], false);
  assert.equal(state.done[SCENE.eid], true);
  assert.equal(toasts[1], '✓ 已执行 · 观影模式');
  clock.advance(SCENE_DONE_MS - 1);
  assert.equal(state.done[SCENE.eid], true);
  clock.advance(1);
  assert.equal(state.done[SCENE.eid], false);
  assert.equal(clock.pending, 0);
});

test('WS 推送确认：check() 比 400ms 轮询更快命中', async () => {
  const { clock, ha, toasts, state, runner } = setup();
  runner.run(SCENE);
  await tick();
  assert.equal(state.busy[SCENE.eid], true);
  ha.state.state = '2026-11-15T08:00:00';       // HA 推送了新状态
  runner.check();
  assert.equal(state.busy[SCENE.eid], false);
  assert.equal(state.done[SCENE.eid], true);
  assert.equal(toasts.at(-1), '✓ 已执行 · 观影模式');
  clock.advance(SCENE_TIMEOUT_MS + 2000);       // 轮询已被摘掉，不会再弹「已发送」
  assert.equal(toasts.at(-1), '✓ 已执行 · 观影模式');
  assert.equal(clock.pending, 0);
});

test('4s 未收到回执：走「已发送（未收到执行回执）」而不是成功', async () => {
  const { clock, toasts, state, runner } = setup();
  runner.run(SCENE);
  await tick();
  clock.advance(SCENE_TIMEOUT_MS);              // 恰好 4000ms：条件 > 4000，尚未超时
  assert.equal(state.busy[SCENE.eid], true);
  clock.advance(SCENE_POLL_MS);                 // 4400ms：超过 4s
  assert.equal(state.busy[SCENE.eid], false);
  assert.equal(state.done[SCENE.eid], undefined);
  assert.equal(toasts.at(-1), '已发送（未收到执行回执）· 观影模式');
  assert.equal(clock.pending, 0);
});

test('防连点 + 1200ms 冷却：冷却期内不再发服务', async () => {
  const { clock, ha, state, runner } = setup({ demo: true });
  runner.run(SCENE);
  runner.run(SCENE);                            // busy 期间忽略
  assert.equal(ha.calls.length, 1);
  await tick();
  runner.run(SCENE);                            // 冷却窗口内忽略
  assert.equal(ha.calls.length, 1);
  assert.equal(state.busy[SCENE.eid], false);
  clock.advance(SCENE_COOLDOWN_MS + 1);
  runner.run(SCENE);
  assert.equal(ha.calls.length, 2);
  await tick();
  assert.equal(state.done[SCENE.eid], true);
});

test('服务失败：撤掉执行中 + 失败提示，不进入回执等待', async () => {
  const { clock, toasts, state, runner } = setup({ reject: true });
  const orig = console.error;
  console.error = () => {};
  try {
    runner.run(SCENE);
    await tick();
  } finally {
    console.error = orig;
  }
  assert.equal(state.busy[SCENE.eid], false);
  assert.equal(toasts.at(-1), '✗ 执行失败 · 观影模式');
  assert.equal(clock.pending, 0);
});

test('automation 域用 trigger 服务', async () => {
  const { ha, runner } = setup({ demo: true });
  runner.run({ eid: 'automation.good_night', name: '晚安', type: 'automation' });
  await tick();
  assert.deepEqual(ha.calls[0], {
    domain: 'automation', service: 'trigger', data: { entity_id: 'automation.good_night' },
  });
});

test('开关类：发 toggle 服务，服务成功即确认，不进入 4s 回执等待', async () => {
  const { clock, ha, toasts, state, runner } = setup({ names: { 'light.kitchen': '厨房灯' } });
  runner.run(LIGHT);
  /* 开关类不进「执行中」态：不点亮 busy（磁贴不转圈）、不弹「正在切换」 */
  assert.equal(state.busy[LIGHT.eid], undefined);
  assert.equal(toasts.length, 0);
  await tick();
  assert.deepEqual(ha.calls[0], { domain: 'light', service: 'toggle', data: { entity_id: 'light.kitchen' } });
  assert.equal(state.busy[LIGHT.eid], false, '全程不进入执行中态');
  assert.equal(state.done[LIGHT.eid], true);
  assert.equal(toasts.at(-1), '✓ 已切换 · 厨房灯');
  clock.advance(SCENE_TIMEOUT_MS + 2000);
  assert.equal(toasts.at(-1), '✓ 已切换 · 厨房灯', '不会弹「已发送（未收到执行回执）」');
  assert.equal(clock.pending, 0, '没有挂起的轮询 / watcher');
});

test('三个开关域都是 toggle，且 300ms 短冷却不拖慢连续切换', async () => {
  const { clock, ha, runner } = setup({ names: { 'light.kitchen': '厨房灯' } });
  runner.run({ eid: 'switch.fan', name: '风扇', type: 'switch' });
  runner.run({ eid: 'input_boolean.guest', name: '访客', type: 'input_boolean' });
  await tick();
  assert.deepEqual(ha.calls[0], { domain: 'switch', service: 'toggle', data: { entity_id: 'switch.fan' } });
  assert.deepEqual(ha.calls[1], { domain: 'input_boolean', service: 'toggle', data: { entity_id: 'input_boolean.guest' } });
  runner.run(LIGHT);
  runner.run(LIGHT);                            // busy 期间忽略
  assert.equal(ha.calls.length, 3);
  await tick();
  runner.run(LIGHT);                            // 冷却窗口内忽略
  assert.equal(ha.calls.length, 3);
  clock.advance(TOGGLE_COOLDOWN_MS + 1);
  runner.run(LIGHT);
  assert.equal(ha.calls.length, 4);
  await tick();
});

test('script → turn_on、button → press、项目 action 覆盖', async () => {
  const { ha, runner } = setup({ demo: true });
  runner.run({ eid: 'script.good_night', name: '晚安脚本', type: 'script' });
  runner.run({ eid: 'button.doorbell', name: '门铃', type: 'button' });
  runner.run({ eid: 'light.custom', name: '自定义', type: 'light', action: 'turn_on' });
  await tick();
  assert.deepEqual(ha.calls.map((c) => c.service), ['turn_on', 'press', 'turn_on']);
  assert.deepEqual(ha.calls[0], { domain: 'script', service: 'turn_on', data: { entity_id: 'script.good_night' } });
});

test('开关类服务失败：✗ 切换失败，不留挂起定时器', async () => {
  const { clock, toasts, state, runner } = setup({ reject: true });
  const orig = console.error;
  console.error = () => {};
  try {
    runner.run(LIGHT);
    await tick();
  } finally {
    console.error = orig;
  }
  assert.notEqual(state.busy[LIGHT.eid], true, '开关类不点亮执行中态');
  assert.equal(toasts.at(-1), '✗ 切换失败 · 厨房灯');
  assert.equal(clock.pending, 0);
});

test('dispose：清掉所有挂起定时器，之后不再写状态', async () => {
  const { clock, ha, toasts, state, runner } = setup();
  runner.run(SCENE);
  await tick();
  assert.ok(clock.pending > 0, '轮询已排队');
  runner.dispose();
  assert.equal(clock.pending, 0);
  ha.state.state = 'changed';
  runner.check();                              // dispose 后 watchers 已清空
  clock.advance(SCENE_TIMEOUT_MS + 5000);
  assert.equal(state.busy[SCENE.eid], true, '不再触发 result');
  assert.equal(toasts.length, 1, '只剩「正在执行」一条');
});
