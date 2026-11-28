/*
 * tests/history-series.test.mjs — 数据卡历史曲线纯函数单测
 * 覆盖：HA 原始返回解析（二维 / 蛇形键 / 秒毫秒）、数值 vs 枚举判定、
 * 量程边界（恒定值 / 单点）、阶梯折线拐点、SVG 坐标映射。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHistory, seriesMode, numericPoints, enumPoints,
  seriesBounds, enumBounds, mapPoints, stepPoints, formatClock, formatAxisTimes,
} from '../src/model/historySeries.js';

const ISO = (s) => new Date(s).toISOString();

test('parseHistory：HA 标准二维 [[{s,t}]] → [{t,s}]，按时间升序', () => {
  const raw = { result: [[
    { s: '23', t: ISO('2026-11-22T10:00:00Z') },
    { s: '25', t: ISO('2026-11-22T08:00:00Z') },
    { s: '24', t: ISO('2026-11-22T09:00:00Z') },
  ]] };
  const p = parseHistory(raw);
  assert.deepEqual(p.map((x) => x.s), ['25', '24', '23']);
  assert.equal(p[0].t, Date.parse(ISO('2026-11-22T08:00:00Z')));
});

test('parseHistory：现行 history/history_during_period 的 {eid:[{s,t}]} 字典格式', () => {
  const raw = { 'sensor.hot_water': [
    { s: '44', t: ISO('2026-11-22T09:00:00Z') },
    { s: '46', t: ISO('2026-11-22T10:00:00Z') },
  ] };
  const p = parseHistory(raw);
  assert.deepEqual(p.map((x) => x.s), ['44', '46']);
  assert.equal(p[0].t, Date.parse(ISO('2026-11-22T09:00:00Z')));
});

test('parseHistory：state/last_changed 键、秒级时间戳、空串丢弃、unknown 保留（枚举态）', () => {
  const raw = [[
    { state: 'on', last_changed: 1700000000 },
    { state: '', last_changed: 1700000001 },
    { state: 'unavailable', last_changed: 1700000002 },
  ]];
  const p = parseHistory(raw);
  assert.equal(p.length, 2);                       // 空串被丢
  assert.equal(p[0].t, 1700000000 * 1000);        // 秒 → 毫秒
  assert.equal(p[1].s, 'unavailable');            // 枚举有效态，不丢
});

test('seriesMode：全数值 → number，含非数值 → enum，空 → number', () => {
  assert.equal(seriesMode([{ s: '1' }, { s: '2.5' }]), 'number');
  assert.equal(seriesMode([{ s: 'on' }, { s: 'off' }]), 'enum');
  assert.equal(seriesMode([{ s: '23' }, { s: 'unknown' }]), 'enum');
  assert.equal(seriesMode([]), 'number');
});

test('numericPoints：过滤 unknown/unavailable/非数', () => {
  const raw = [{ t: 1, s: '21' }, { t: 2, s: 'unknown' }, { t: 3, s: '22.5' }, { t: 4, s: 'bad' }];
  assert.deepEqual(numericPoints(raw), [{ t: 1, v: 21 }, { t: 3, v: 22.5 }]);
});

test('enumPoints：档位按首次出现顺序，连续同态压缩到首末', () => {
  const raw = [
    { t: 1, s: 'heating' }, { t: 2, s: 'heating' },
    { t: 3, s: 'eco' }, { t: 4, s: 'off' }, { t: 5, s: 'eco' },
  ];
  const { points, levels } = enumPoints(raw);
  assert.deepEqual(levels.map((l) => l.label), ['heating', 'eco', 'off']);
  assert.deepEqual(points.map((p) => [p.t, p.v, p.label]), [
    [2, 0, 'heating'], [3, 1, 'eco'], [4, 2, 'off'], [5, 1, 'eco'],
  ]);
});

test('seriesBounds：正常量程留 8% 余量；恒定值给 ±5%；0 值给 ±1', () => {
  const b = seriesBounds([{ t: 1, v: 10 }, { t: 2, v: 20 }]);
  /* 8% 余量口径精确锁定（2026-11-28：原恒真断言 `…< 1e-9 || b.span > 10` 拆开） */
  assert.equal(b.rawMin, 10);
  assert.equal(b.rawMax, 20);
  assert.ok(Math.abs(b.min - 9.2) < 1e-9, 'min = 10 - 10*0.08，实际 ' + b.min);
  assert.ok(Math.abs(b.max - 20.8) < 1e-9, 'max = 20 + 20*0.08，实际 ' + b.max);

  const flat = seriesBounds([{ t: 1, v: 20 }, { t: 2, v: 20 }]);
  assert.equal(flat.rawMin, 20);
  assert.equal(flat.rawMax, 20);
  assert.ok(Math.abs(flat.min - 19) < 1e-9, '恒定值 min = 20 - 20*0.05，实际 ' + flat.min);
  assert.ok(Math.abs(flat.max - 21) < 1e-9, '恒定值 max = 20 + 20*0.05，实际 ' + flat.max);

  const zero = seriesBounds([{ t: 1, v: 0 }, { t: 2, v: 0 }]);
  assert.deepEqual([zero.min, zero.max], [-1, 1]);

  assert.equal(seriesBounds([]).empty, true);
});

test('enumBounds：档位中心留半格，首尾档有空间画', () => {
  const b = enumBounds([{ label: 'a', level: 0 }, { label: 'b', level: 1 }, { label: 'c', level: 2 }]);
  assert.equal(b.min, -0.5);
  assert.equal(b.max, 2.5);
});

test('mapPoints：y 轴翻转，值越大 y 越小；落在 viewBox 内', () => {
  const b = seriesBounds([{ t: 0, v: 0 }, { t: 100, v: 10 }]);
  const xy = mapPoints([{ t: 0, v: 0 }, { t: 100, v: 10 }], b, 100, 50, 5);
  assert.equal(xy.length, 2);
  assert.ok(xy[0][0] < xy[1][0]);   // 时间从左到右
  assert.ok(xy[0][1] > xy[1][1]);   // 值从低到高，y 从大到小
  assert.ok(xy.every((p) => p[0] >= 5 && p[0] <= 95 && p[1] >= 5 && p[1] <= 45));
});

test('stepPoints：两个档位点生成水平+垂直拐点（共 3 段）', () => {
  const b = { min: -0.5, max: 1.5, t0: 0, t1: 100 };
  const s = stepPoints([{ t: 0, v: 0 }, { t: 100, v: 1 }], b, 100, 50, 5);
  const pts = s.split(' ');
  assert.equal(pts.length, 3);      // 起点 + 水平拐点 + 终点
  /* 量程 -0.5~1.5（span=2），h=50 pad=5：v=0 → y=35，v=1 → y=15 */
  assert.equal(pts[0], '5,35');     // v=0 靠下
  assert.equal(pts[2], '95,15');    // v=1 靠上
  assert.equal(pts[1].split(',')[0], pts[2].split(',')[0]);  // 拐点与终点同一 x（垂直跳）
  assert.equal(pts[1].split(',')[1], pts[0].split(',')[1]);  // 拐点与起点同一 y（水平走）
});

test('formatClock：HH:MM 补零', () => {
  const t = new Date(2026, 0, 1, 9, 5).getTime();
  assert.equal(formatClock(t), '09:05');
});

test('seriesBounds：rawMin/rawMax 是真实极值，绘图量程才带余量', () => {
  const b = seriesBounds([{ t: 1, v: 34 }, { t: 2, v: 65 }]);
  assert.equal(b.rawMin, 34);
  assert.equal(b.rawMax, 65);
  assert.ok(b.min < 34 && b.max > 65);   // 绘图用带余量的
  const flat = seriesBounds([{ t: 1, v: 20 }, { t: 2, v: 20 }]);
  assert.equal(flat.rawMin, 20);
  assert.equal(flat.rawMax, 20);
});

test('formatAxisTimes：同一天只给时钟，跨天带昨/今，跨多天带月-日', () => {
  const local = (y, m, d, h, min) => new Date(y, m, d, h, min).getTime();
  /* 同一天 */
  assert.deepEqual(
    formatAxisTimes(local(2026, 10, 22, 10, 58), local(2026, 10, 22, 11, 10)),
    ['10:58', '11:10']
  );
  /* 跨相邻天（截图里的场景：昨天 11:10 → 今天 10:58） */
  assert.deepEqual(
    formatAxisTimes(local(2026, 10, 21, 11, 10), local(2026, 10, 22, 10, 58)),
    ['昨 11:10', '今 10:58']
  );
  /* 跨多天 */
  assert.deepEqual(
    formatAxisTimes(local(2026, 10, 19, 9, 0), local(2026, 10, 22, 10, 0)),
    ['11-19 09:00', '11-22 10:00']
  );
  /* 非法输入 */
  assert.deepEqual(formatAxisTimes(NaN, 0), ['', '']);
});
