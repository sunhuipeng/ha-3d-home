/*
 * tests/prefs-nols.test.mjs — prefs.js 的「无 localStorage」分支（P1-4 补充）。
 *
 * LS 在模块加载时定为 null（Node 环境没有 localStorage），所有读写都应静默回默认。
 * node --test 每文件独立进程，这里刻意不定义 localStorage 全局。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

assert.equal(typeof localStorage, 'undefined', '本文件必须在无 localStorage 的环境跑');

const prefs = await import('../src/services/prefs.js');
const { prefGet, prefSet, prefBool, prefSetBool, prefInt, prefSetInt } = prefs;

test('无 localStorage（LS=null）：读回默认、写静默不抛', () => {
  assert.equal(prefGet('ha3d.x', 'def'), 'def');
  assert.equal(prefBool('ha3d.x', true), true);
  assert.equal(prefInt('ha3d.x', 9), 9);
  prefSet('ha3d.x', '1');                    // 全部静默
  prefSetBool('ha3d.x', true);
  prefSetInt('ha3d.x', 3);
});
