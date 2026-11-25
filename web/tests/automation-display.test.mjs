/*
 * tests/automation-display.test.mjs — 居控中枢动作/场景接入展示页的纯逻辑测试：
 * 服务端代理 fetch 封装、SVG 二次净化、展示项派生、按 kind 走代理触发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAutomationActions, triggerAutomation, safeSvgHtml } from '../src/services/automation.js';
import { displayActionOf } from '../src/model/displayAction.js';
import { displayItemsOf } from '../src/model/displayDerived.js';
import { createSceneRunner } from '../src/model/sceneRunner.js';

const SVG = '<svg viewBox="0 0 64 64"><path d="M8 8h48v48H8z" stroke="currentColor"/></svg>';

function fakeFetch({ ok = true, data = {} } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return { ok, status: ok ? 200 : 400, json: async () => data };
  };
  return { f, calls };
}

test('automation 代理 fetch：列候选与触发都只请求同源 /api/automation/*', async () => {
  const list = fakeFetch({ data: { items: [{ id: 'abc', name: 'A' }] } });
  const items = await fetchAutomationActions(list.f);
  assert.deepEqual(items, [{ id: 'abc', name: 'A' }]);
  assert.equal(list.calls[0].url, '/api/automation/actions');
  assert.equal(list.calls[0].init.method, undefined);

  const trg = fakeFetch({ data: { ok: true, id: 'abc' } });
  await triggerAutomation('abc', trg.f);
  assert.equal(trg.calls[0].url, '/api/automation/trigger/abc');
  assert.equal(trg.calls[0].init.method, 'POST');

  const bad = fakeFetch({ ok: false, data: { error: '没有正式版本' } });
  await assert.rejects(() => triggerAutomation('abc', bad.f), /没有正式版本/);
});

test('safeSvgHtml：剥事件属性 / script / foreignObject / image / use / javascript:', () => {
  assert.equal(safeSvgHtml(SVG), SVG);
  const dirty = '<svg onload="evil()" viewBox="0 0 64 64"><script>alert(1)</script>'
    + '<foreignObject><img/></foreignObject><image href="http://x"/><use href="#x"/>'
    + '<a href="javascript:alert(1)"><path d="M0 0"/></a></svg>';
  const clean = safeSvgHtml(dirty);
  assert.ok(!/onload|script|foreignObject|<image|<use|javascript:/i.test(clean));
  assert.match(clean, /<path/);
  assert.equal(safeSvgHtml('<div>not svg</div>'), '');
  assert.equal(safeSvgHtml('x'.repeat(13000)), '');
});

test('displayActionOf：automation 项按 kind 分派到代理，域不再从短码猜', () => {
  const act = displayActionOf({ eid: 'abc123', kind: 'automation', name: 'X' });
  assert.deepEqual(act, { domain: 'automation', service: 'trigger', toggle: false, proxy: true });
  const ha = displayActionOf({ eid: 'scene.movie' });
  assert.ok(!ha.proxy, 'HA 项不应带 proxy 标记');
  assert.equal(ha.service, 'turn_on');
});

test('displayItemsOf：短码 automation 项保留 name/svg，不套 mdi，也不依赖 HA 实体', () => {
  const fl = { display: { displayItems: [
    { eid: 'abc123', kind: 'automation', name: '测试动作', svg: SVG },
    { eid: 'bad id', kind: 'automation', name: '非法' },
    { eid: 'scene.x', kind: 'scene' },
  ] } };
  const ha = { all: () => [], friendly: (eid) => eid, getState: () => null };
  const items = displayItemsOf(fl, ha);
  assert.equal(items.length, 2);
  assert.equal(items[0].eid, 'abc123');
  assert.equal(items[0].name, '测试动作');
  assert.equal(items[0].svg, SVG);
  assert.equal(items[0].mdi, '');
  assert.equal(items[0].proxy, true);
});

test('sceneRunner：automation 项走代理、不调 HA；失败带明确回执文案', async () => {
  const haCalls = [];
  const ha = {
    demo: false,
    friendly: (eid) => eid,
    getState: () => null,
    callService: (...args) => { haCalls.push(args); return Promise.resolve({}); },
  };
  const trg = fakeFetch({ data: { ok: true, id: 'abc', version: 2 } });
  const toasts = [];
  const state = { busy: {}, done: {} };
  const runner = createSceneRunner({
    ha: () => ha,
    toast: (m) => toasts.push(m),
    fetch: trg.f,
    state,
    schedule: () => 0,
    unschedule: () => {},
  });
  runner.run({ eid: 'abc', kind: 'automation', name: '测试动作' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(trg.calls[0].url, '/api/automation/trigger/abc');
  assert.equal(haCalls.length, 0, 'automation 项不得发 HA callService');
  assert.equal(state.busy.abc, false);
  assert.match(toasts.join('\n'), /✓ 已执行 · 测试动作/);
  assert.equal(toasts[0], '正在执行 · 测试动作');

  const bad = fakeFetch({ ok: false, data: { error: '脚本没有正式版本，无法触发' } });
  const errToasts = [];
  const r2 = createSceneRunner({
    ha: () => ha, toast: (m) => errToasts.push(m), fetch: bad.f,
    state: { busy: {}, done: {} }, schedule: () => 0, unschedule: () => {},
  });
  r2.run({ eid: 'abc', kind: 'automation', name: '测试动作' });
  await new Promise((r) => setImmediate(r));
  assert.match(errToasts.join('\n'), /✗ 执行失败 · 测试动作（脚本没有正式版本，无法触发）/);
});
