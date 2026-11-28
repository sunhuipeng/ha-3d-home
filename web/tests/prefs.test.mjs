/*
 * tests/prefs.test.mjs — services/prefs.js：localStorage 偏好读写防御（P1-4）。
 *
 * prefs.js 在模块加载时捕获 localStorage 引用（LS），所以「带 shim 的进程」与
 * 「无 localStorage 的进程」（tests/prefs-nols.test.mjs）各跑一份——node --test
 * 每个文件独立进程，正好覆盖两条 LS 分支。
 * 本文件带一个可抛异常的内存 shim，覆盖：坏 JSON / 抛异常 / 值类型边界。
 */
const store = new Map();
let broken = false;   // 置 true 后所有操作抛异常（模拟隐私模式 / 配额满）
globalThis.localStorage = {
  getItem: (k) => { if (broken) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => { if (broken) throw new Error('denied'); store.set(k, String(v)); },
  removeItem: (k) => { if (broken) throw new Error('denied'); store.delete(k); },
};

const { prefGet, prefSet, prefBool, prefSetBool, prefInt, prefSetInt, PREF_KEYS } =
  await import('../src/services/prefs.js');
import test from 'node:test';
import assert from 'node:assert/strict';

test('prefGet/prefSet：字符串原样；缺失回默认', () => {
  prefSet(PREF_KEYS.autoRotate, '1');
  assert.equal(prefGet(PREF_KEYS.autoRotate, 'x'), '1');
  assert.equal(prefGet('ha3d.never-set', 'fallback'), 'fallback');
});

test('prefBool：`0` 关、其它字符串一律开（历史值口径）、缺失回默认', () => {
  prefSetBool(PREF_KEYS.nightMode, true);
  assert.equal(prefBool(PREF_KEYS.nightMode, false), true);
  prefSetBool(PREF_KEYS.nightMode, false);
  assert.equal(prefBool(PREF_KEYS.nightMode, true), false, '`0` 视为关');
  prefSet(PREF_KEYS.nightMode, 'garbage');
  assert.equal(prefBool(PREF_KEYS.nightMode, true), true, '非 `0` 一律视为开');
  assert.equal(prefBool('ha3d.never-set', true), true, '缺失回默认');
});

test('prefInt：数字正常；非数字/空串回默认（NaN 会导致白屏）', () => {
  prefSetInt(PREF_KEYS.displayFloor, 2);
  assert.equal(prefInt(PREF_KEYS.displayFloor, 0), 2);
  prefSetInt(PREF_KEYS.displayFloor, 'abc');
  assert.equal(prefInt(PREF_KEYS.displayFloor, 0), 0, 'NaN 写入空串，读回默认');
  prefSet(PREF_KEYS.displayFloor, '');
  assert.equal(prefInt(PREF_KEYS.displayFloor, 7), 7);
  prefSet(PREF_KEYS.displayFloor, '3.9');
  assert.equal(prefInt(PREF_KEYS.displayFloor, 0), 3, 'parseInt 截断小数');
});

test('localStorage 抛异常（隐私模式）：全部回默认且不抛', () => {
  broken = true;
  assert.equal(prefGet(PREF_KEYS.autoRotate, 'd'), 'd');
  assert.equal(prefBool(PREF_KEYS.nightMode, true), true);
  assert.equal(prefInt(PREF_KEYS.displayFloor, 5), 5);
  prefSet(PREF_KEYS.autoRotate, '1');            // 静默
  prefSetBool(PREF_KEYS.nightMode, true);
  prefSetInt(PREF_KEYS.displayFloor, 3);
  broken = false;
  /* 用全新键验证异常期间的写入确实没落盘（既有键在前面的用例里已合法写入过） */
  assert.equal(prefGet('ha3d.privacy-probe', null), null);
});
