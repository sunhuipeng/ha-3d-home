'use strict';
/*
 * tests/shared-norm.test.mjs — normPathname 回归锁定。
 *
 * 这是 2026-11-20 修过真实安全漏洞的地方：门禁与静态托管都要用解码归一后的
 * 路径做前缀判断 —— new URL().pathname 不解码 %xx，/%63ustom/... 在门禁层
 * 看不到 /custom/ 前缀就会放行私有资产。这里把绕过形态全部固化成回归测试。
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

/* 服务端模块在 require 前必须先设 env（照 automation-proxy.test.mjs 范式） */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-shared-norm-'));
process.env.HA3D_DATA_DIR = tmp;
process.env.HA3D_CUSTOM_DIR = path.join(tmp, 'custom');

const require = createRequire(import.meta.url);
const { normPathname } = require('../server/shared.js');

const norm = (u) => normPathname(new URL(u, 'http://x'));

test('normPathname：%63 编码的 /custom 前缀必须解码归一（2026-11-20 绕过回归）', () => {
  assert.equal(norm('http://x/%63ustom/models/a.glb'), '/custom/models/a.glb');
  assert.equal(norm('http://x/%63ustom/'), '/custom/');
  assert.equal(norm('http://x/%61pi/project'), '/api/project');
});

test('normPathname：%5C 反斜杠折成正斜杠，挡住 \\custom\\x 变体', () => {
  assert.equal(norm('http://x/custom%5Csecret.txt'), '/custom/secret.txt');
  assert.equal(norm('http://x/%5Ccustom%5Cx'), '/custom/x');
});

test('normPathname：.. 逐级归一，根外不再上跳', () => {
  assert.equal(norm('http://x/custom/../package.json'), '/package.json');
  assert.equal(norm('http://x/custom/%2e%2e/package.json'), '/package.json');
  assert.equal(norm('http://x/custom/..%2fpackage.json'), '/package.json');
  assert.equal(norm('http://x/a/b/../../c'), '/c');
  assert.equal(norm('http://x/a/../../b'), '/b');
  assert.equal(norm('http://x/../etc'), '/etc');
});

test('normPathname：非法百分号编码不抛异常，按原样归一', () => {
  assert.equal(norm('http://x/%zzcustom/x'), '/%zzcustom/x');
  assert.equal(norm('http://x/%2'), '/%2');
});

test('normPathname：常规路径不变，查询串不参与', () => {
  assert.equal(norm('http://x/static/app-abc12345.js?v=1'), '/static/app-abc12345.js');
  assert.equal(norm('http://x/'), '/');
  assert.equal(norm('http://x/custom/models/a.glb?v=2'), '/custom/models/a.glb');
});
