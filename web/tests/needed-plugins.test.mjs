/**
 * 按需加载插件集合派生单测（零浏览器 / 零 Vue，直接 node 跑）。
 *   node --test tests/needed-plugins.test.mjs
 * 重点: style 反推插件 id、家具插件、门窗、背景 alias、缺省 style 的 type 兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { pluginIdOf, defaultIdForType, neededPluginIds } from '../src/model/neededPlugins.js';

/* 一份模拟的 /api/plugins 清单（覆盖多插件同 type、custom、背景） */
const LIST = [
  { id: 'light', dir: 'light', type: 'light', kind: 'device' },
  { id: 'light_strip', dir: 'light_strip', type: 'light', kind: 'device' },
  { id: 'switch', dir: 'switch', type: 'switch', kind: 'device' },
  { id: 'door', dir: 'door', type: 'door', kind: 'device' },
  { id: 'window', dir: 'window', type: 'window', kind: 'device' },
  { id: 'wardrobe', dir: 'wardrobe', type: 'furniture', kind: 'device' },
  { id: 'myplugin', dir: 'custom_dir', type: 'switch', kind: 'device' },   // id≠dir 的自定义包
  { id: 'background', dir: 'background', type: '', kind: 'background' },
];

test('pluginIdOf：取冒号前插件 id，无冒号整串，空值/alias', () => {
  assert.equal(pluginIdOf('light:bulb'), 'light');
  assert.equal(pluginIdOf('wardrobe:swing'), 'wardrobe');
  assert.equal(pluginIdOf('switch'), 'switch');
  assert.equal(pluginIdOf(''), '');
  assert.equal(pluginIdOf(null), '');
  assert.equal(pluginIdOf(undefined), '');
  assert.equal(pluginIdOf('backdrop_ground:grass'), 'background');   // 旧背景 alias 迁移
});

test('defaultIdForType：id 同名优先，否则该 type 第一个，背景不参与', () => {
  assert.equal(defaultIdForType('light', LIST), 'light');            // 同名优先（不是 light_strip）
  assert.equal(defaultIdForType('switch', LIST), 'switch');          // 同名优先（不是 myplugin）
  assert.equal(defaultIdForType('furniture', LIST), 'wardrobe');
  assert.equal(defaultIdForType('', LIST), '');
  assert.equal(defaultIdForType('no_such_type', LIST), '');
  assert.equal(defaultIdForType('background', LIST), '');            // kind:background 不参与设备兜底
});

test('neededPluginIds：显式 style 反推（设备 + 家具插件 + 门窗）', () => {
  const project = {
    floors: [{
      devices: [
        { type: 'light', style: 'light:bulb' },
        { type: 'furniture', style: 'wardrobe:swing' },              // 家具插件也在 devices
        { type: 'switch', style: 'switch:plug' },
      ],
      doors: [{ style: 'door:single' }],
      windows: [{ style: 'window:slide' }],
    }],
    settings: {},
  };
  const got = neededPluginIds(project, LIST);
  assert.deepEqual([...got].sort(), ['door', 'light', 'switch', 'wardrobe', 'window']);
});

test('neededPluginIds：缺省 style 的 type 兜底（默认项目门窗无 style）', () => {
  const project = {
    floors: [{
      devices: [{ type: 'light' }],                                   // 没写 style
      doors: [{ w: 0.9 }],                                            // 没写 style
      windows: [{ w: 1.2 }],                                          // 没写 style
    }],
    settings: {},
  };
  const got = neededPluginIds(project, LIST);
  assert.ok(got.has('light'), '缺省 light 设备 → 兜底加载 light');
  assert.ok(got.has('door'), '缺省门 → 兜底加载 door');
  assert.ok(got.has('window'), '缺省窗 → 兜底加载 window');
});

test('neededPluginIds：type 兜底不会被自定义插件抢默认（同名优先）', () => {
  const project = { floors: [{ devices: [{ type: 'switch' }] }], settings: {} };
  const got = neededPluginIds(project, LIST);
  assert.ok(got.has('switch'));
  assert.ok(!got.has('myplugin'), '未显式引用的自定义 switch 插件不该被兜底加载');
});

test('neededPluginIds：背景单独取，含旧 alias', () => {
  const project = { floors: [], settings: { background: 'backdrop_ground:grass' } };
  const got = neededPluginIds(project, LIST);
  assert.ok(got.has('background'));
});

test('neededPluginIds：未知插件 id 被过滤（清单里没有的不加载）', () => {
  const project = {
    floors: [{ devices: [{ type: 'light', style: 'ghost_plugin:xxx' }] }],
    settings: {},
  };
  const got = neededPluginIds(project, LIST);
  assert.ok(!got.has('ghost_plugin'));
  assert.ok(got.has('light'), 'type 兜底仍保证 light 可用');
});

test('neededPluginIds：空项目 / 异常输入返回空集', () => {
  assert.equal(neededPluginIds(null, LIST).size, 0);
  assert.equal(neededPluginIds({}, LIST).size, 0);
  assert.equal(neededPluginIds({ floors: [] }, []).size, 0);
  assert.equal(neededPluginIds({ floors: [] }, null).size, 0);
});

test('neededPluginIds：多楼层都扫到', () => {
  const project = {
    floors: [
      { devices: [{ type: 'light', style: 'light:pendant' }] },
      { devices: [{ type: 'switch', style: 'switch:plug' }] },
    ],
    settings: {},
  };
  const got = neededPluginIds(project, LIST);
  assert.ok(got.has('light'));
  assert.ok(got.has('switch'));
});
