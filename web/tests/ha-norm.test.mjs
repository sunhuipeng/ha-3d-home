/*
 * tests/ha-norm.test.mjs — services/ha.js HA.norm：subscribe_entities 三种增量格式归一（P0-12）。
 *
 * HA.norm 是实体渲染数据的唯一入口：WS 全量/增量推送、老 HA 退化 get_states 都汇到这里，
 * 格式归一错了整套设备状态就会错。零依赖模块，Node 可直接 import（不触发连接）。
 *
 * 三种格式（见 HA.norm 注释）：
 *   ① diff 包装：{"+": {s, a, lc, c}}（键变更用 "+" 表示）
 *   ② 全量精简：{s, a, lc, lu, c}（subscribe_entities 首推 / get_states 行）
 *   ③ 属性 diff：{a, lu, c}（状态没变，只有属性/元数据）
 */
/* 避免 ESM 静态 import 提升到全局 shim 之前：ha.js 顶层用 typeof 探测 window，
 * 但保险起见先补齐环境再动态 import。 */
globalThis.window = { __HA_DBG: false };

const { HA } = await import('../src/services/ha.js');
import test from 'node:test';
import assert from 'node:assert/strict';

test('norm：全量精简格式 {s, a, lc} → HA state object', () => {
  const out = HA.norm({ s: 'on', a: { friendly_name: '吸顶灯' }, lc: 1700000000 }, 'light.lamp');
  assert.deepEqual(out, {
    entity_id: 'light.lamp',
    state: 'on',
    attributes: { friendly_name: '吸顶灯' },
    last_changed: new Date(1700000000 * 1000).toISOString(),
  });
});

test('norm：diff 包装 {"+": {...}} → 解包后同精简口径', () => {
  const out = HA.norm({ '+': { s: 'off', a: {}, lc: 1700000060 } }, 'switch.plug');
  assert.equal(out.entity_id, 'switch.plug');
  assert.equal(out.state, 'off');
  assert.deepEqual(out.attributes, {});
  assert.equal(out.last_changed, new Date(1700000060 * 1000).toISOString());
  /* 非对象 "+" 键（如字符串 "+"）不得误走解包分支 */
  const weird = HA.norm({ '+': 'garbage', s: 'on' }, 'light.x');
  assert.equal(weird.state, 'on', '字符串 + 值不解包，仍按精简格式读 s');
});

test('norm：属性 diff（无 s 只有 a）→ 只回 attributes，由 applyMap 与旧状态合并', () => {
  const out = HA.norm({ a: { brightness: 128 }, lu: 1700000100, c: 1 }, 'light.lamp');
  assert.deepEqual(out, { entity_id: 'light.lamp', attributes: { brightness: 128 } });
  assert.ok(!('state' in out), '属性 diff 不得伪造 state 字段');
  assert.ok(!('last_changed' in out), '属性 diff 不带 last_changed');
});

test('norm：只有元数据（lu/c）变化 → 空对象', () => {
  assert.deepEqual(HA.norm({ lu: 1700000200, c: 2 }, 'light.lamp'), {});
});

test('norm：非对象入参原样返回（调用方判空兜底）', () => {
  assert.equal(HA.norm(null, 'x'), null);
  assert.equal(HA.norm(undefined, 'x'), undefined);
  assert.equal(HA.norm('raw-string', 'x'), 'raw-string');
});
