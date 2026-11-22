/*
 * tests/room-climate.test.mjs — 房间温湿度 3D 标签文案派生单测
 * 覆盖：有效读数+单位、unknown/unavailable 过滤、只绑一个、都没绑不建标签、无状态兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { climateValue, roomHasClimate, roomClimate } from '../src/model/roomClimate.js';

test('climateValue：读数带单位，保留 HA 原样精度', () => {
  assert.equal(climateValue({ state: '24.6', attributes: { unit_of_measurement: '℃' } }), '24.6 ℃');
  assert.equal(climateValue({ state: '55', attributes: { unit_of_measurement: '%' } }), '55 %');
  assert.equal(climateValue({ state: '23', attributes: {} }), '23');
});

test('climateValue：unknown/unavailable/空/无状态一律空串', () => {
  assert.equal(climateValue(null), '');
  assert.equal(climateValue({}), '');
  assert.equal(climateValue({ state: 'unknown' }), '');
  assert.equal(climateValue({ state: 'unavailable' }), '');
  assert.equal(climateValue({ state: '  ' }), '');
});

test('roomHasClimate：绑任一实体才建标签', () => {
  assert.equal(roomHasClimate({ tempEntity: 'sensor.t' }), true);
  assert.equal(roomHasClimate({ humidityEntity: 'sensor.h' }), true);
  assert.equal(roomHasClimate({}), false);
  assert.equal(roomHasClimate(null), false);
});

test('roomClimate：温度+湿度拼串，房间名在前，中间用 · 分隔', () => {
  const room = { name: '卧室', tempEntity: 'sensor.t', humidityEntity: 'sensor.h' };
  const get = (eid) => eid === 'sensor.t'
    ? { state: '24.6', attributes: { unit_of_measurement: '℃' } }
    : { state: '55', attributes: { unit_of_measurement: '%' } };
  const r = roomClimate(room, get);
  assert.equal(r.name, '卧室');
  assert.equal(r.value, '24.6 ℃ · 55 %');
  assert.equal(r.text, '卧室 24.6 ℃ · 55 %');
});

test('roomClimate：只绑一个 / 实体无数据时只显示取到的部分', () => {
  const onlyT = { name: '书房', tempEntity: 'sensor.t' };
  const r1 = roomClimate(onlyT, () => ({ state: '21', attributes: { unit_of_measurement: '℃' } }));
  assert.equal(r1.value, '21 ℃');
  assert.equal(r1.text, '书房 21 ℃');

  /* 温度 unknown 被过滤，只剩湿度 */
  const both = { name: '客厅', tempEntity: 'sensor.t', humidityEntity: 'sensor.h' };
  const r2 = roomClimate(both, (eid) => eid === 'sensor.t'
    ? { state: 'unknown' }
    : { state: '60', attributes: { unit_of_measurement: '%' } });
  assert.equal(r2.value, '60 %');
});

test('roomClimate：全部无数据 → value 空、text 只有房间名；无名字兜底房间', () => {
  const room = { tempEntity: 'sensor.t', humidityEntity: 'sensor.h' };
  const r = roomClimate(room, () => ({ state: 'unavailable' }));
  assert.equal(r.value, '');
  assert.equal(r.text, '房间');
  /* get 缺失也不崩 */
  assert.equal(roomClimate(room).text, '房间');
});
