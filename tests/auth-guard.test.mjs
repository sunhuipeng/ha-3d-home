'use strict';
/*
 * tests/auth-guard.test.mjs — 登录门禁全链路集成测试（真实 Express app + 临时 data 目录）。
 *
 * 覆盖：
 *   · 门禁绕过防护：/%61pi、/%63ustom 编码路径必须被拦（normPathname 回归的服务端侧）
 *   · 静态托管穿越：/custom/%2e%2e/... 不得泄漏 public 之外的文件
 *   · 白名单语义：/api/catalog 只放 GET/HEAD；OPTIONS 统一 405
 *   · 登录：HttpOnly cookie、失败 401、连续失败 5 次锁定 429
 *   · token 双通道：X-HA3D-Token / Authorization: Bearer 都能过门禁；伪 token 401
 *   · QR 授权链：approve 需要授权方登录 → login 一次性消费
 *   · session 落盘：data/auth-sessions.json 恢复格式 + logout 后消失
 *
 * 注意：锁定测试按 IP 计数，必须放最后（锁 60 秒会污染后续登录用例）。
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha3d-auth-guard-'));
process.env.HA3D_DATA_DIR = tmp;
process.env.HA3D_CUSTOM_DIR = path.join(tmp, 'custom');
process.env.HA3D_AUTH_USER = 'tester';
process.env.HA3D_AUTH_PASS = 'secret-pass';

const require = createRequire(import.meta.url);
const { createApp } = require('../server/index.js');

let home = null;
let base = '';

test.before(async () => {
  home = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => home.once('listening', resolve));
  base = 'http://127.0.0.1:' + home.address().port;
});

test.after(async () => {
  if (home) await new Promise((resolve) => home.close(resolve));
});

const login = async (pass) => fetch(base + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: 'tester', pass }),
});

test('GET /api/auth/me：门禁启用、未登录', async () => {
  const res = await fetch(base + '/api/auth/me');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.enabled, true);
  assert.equal(data.authenticated, false);
});

test('门禁编码绕过：/%61pi 与 /%63ustom 解码后必须被拦', async () => {
  const api = await fetch(base + '/%61pi/project');
  assert.equal(api.status, 401, '编码的 /api 前缀必须 401');
  const j = await api.json();
  assert.equal(j.needLogin, true);

  const custom = await fetch(base + '/%63ustom/models/private.glb');
  assert.equal(custom.status, 401, '编码的 /custom 前缀必须 401');
});

test('门禁大小写绕过：/EDIT.HTML 等大写变体必须按页面拦截（Windows/macOS 回归）', async () => {
  const edit = await fetch(base + '/EDIT.HTML', { redirect: 'manual' });
  assert.equal(edit.status, 302, '大写 /EDIT.HTML 不得当作静态资源放行');
  assert.ok((edit.headers.get('location') || '').startsWith('/login.html?next='));

  const editShort = await fetch(base + '/EDIT', { redirect: 'manual' });
  assert.equal(editShort.status, 302, '大写 /edit 变体同样按页面拦截');

  const customUpper = await fetch(base + '/CUSTOM/models/private.glb');
  assert.equal(customUpper.status, 401, '大写 /custom 前缀同样 401');

  const apiUpper = await fetch(base + '/API/project');
  assert.equal(apiUpper.status, 401, '大写 /api 前缀不得绕过 401');

  const loginUpper = await fetch(base + '/LOGIN.HTML', { redirect: 'manual' });
  assert.equal(loginUpper.status, 404, '/login.html 白名单归一后大写变体交静态层 404，不进页面重定向循环');
});

test('页面导航未登录 → 302 登录页并带 next', async () => {
  const res = await fetch(base + '/edit', { redirect: 'manual' });
  assert.equal(res.status, 302);
  const loc = res.headers.get('location') || '';
  assert.ok(loc.startsWith('/login.html?next='), 'Location 应带 next: ' + loc);
  assert.ok(decodeURIComponent(loc).includes('/edit'));
});

test('白名单语义：/api/catalog 只放 GET，写方法拦截；OPTIONS 统一 405', async () => {
  const get = await fetch(base + '/api/catalog');
  assert.equal(get.status, 200, 'catalog GET 匿名放行（studio 依赖）');
  const post = await fetch(base + '/api/catalog', { method: 'POST' });
  assert.equal(post.status, 401, 'catalog POST 不得匿名穿透');
  const opt = await fetch(base + '/api/project', { method: 'OPTIONS' });
  assert.equal(opt.status, 405);
});

test('静态托管穿越：/custom/%2e%2e/… 不泄漏文件内容', async () => {
  const res = await fetch(base + '/custom/%2e%2e/package.json');
  const body = await res.text();
  assert.ok(!body.includes('ha-3d-home'), '不得泄漏 package.json 内容');
  assert.ok(res.status === 404 || res.status === 403, '应 404/403，实际 ' + res.status);
});

test('登录：错误 401；正确 200 + HttpOnly cookie + token', async () => {
  const bad = await login('wrong-pass');
  assert.equal(bad.status, 401);

  const ok = await login('secret-pass');
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal(data.ok, true);
  assert.ok(data.token, 'body 带 token 供 App 原生持久化');
  const cookie = ok.headers.get('set-cookie') || '';
  assert.ok(cookie.includes('ha3d_session='), '写入 session cookie');
  assert.ok(/httponly/i.test(cookie), 'cookie 必须 HttpOnly');

  const me = await fetch(base + '/api/auth/me', {
    headers: { Cookie: 'ha3d_session=' + data.token },
  });
  assert.equal((await me.json()).authenticated, true);
});

test('token 双通道：X-HA3D-Token 与 Bearer 都过门禁；伪 token 401', async () => {
  const ok = await login('secret-pass');
  const token = (await ok.json()).token;

  const viaHeader = await fetch(base + '/api/project', { headers: { 'X-HA3D-Token': token } });
  assert.equal(viaHeader.status, 200);
  const viaBearer = await fetch(base + '/api/project', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(viaBearer.status, 200);
  const fake = await fetch(base + '/api/project', { headers: { 'X-HA3D-Token': 'f'.repeat(64) } });
  assert.equal(fake.status, 401);
  assert.equal((await fake.json()).needLogin, true);
});

test('session 落盘：写入 data/auth-sessions.json；logout 后条目消失', async () => {
  const ok = await login('secret-pass');
  const token = (await ok.json()).token;

  await new Promise((r) => setTimeout(r, 300));   // 落盘是 200ms 节流合并写
  const file = path.join(tmp, 'auth-sessions.json');
  assert.ok(fs.existsSync(file), 'session 文件应落盘');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(raw) && raw.some(([t]) => t === token), '落盘格式为 [token, exp] 数组');

  await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'X-HA3D-Token': token } });
  await new Promise((r) => setTimeout(r, 300));
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(!after.some(([t]) => t === token), 'logout 后 session 从落盘文件消失');

  const gone = await fetch(base + '/api/project', { headers: { 'X-HA3D-Token': token } });
  assert.equal(gone.status, 401);
});

test('QR 授权链：approve 未登录 401 → 登录后 approve → login 一次性消费 → 二次 400', async () => {
  const qr = await fetch(base + '/api/auth/qr');
  assert.equal(qr.status, 200);
  const { code, payload } = await qr.json();
  assert.ok(code);
  assert.ok(payload.includes('login.html?code='));

  const deny = await fetch(base + '/api/auth/qr-approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(deny.status, 401, '未授权方不得 approve');
  assert.equal((await deny.json()).needLogin, true);

  const st = await fetch(base + '/api/auth/qr-status?code=' + code);
  assert.equal((await st.json()).state, 'pending');

  const ok = await login('secret-pass');
  const token = (await ok.json()).token;
  const approve = await fetch(base + '/api/auth/qr-approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HA3D-Token': token },
    body: JSON.stringify({ code }),
  });
  assert.equal(approve.status, 200);

  const status = await fetch(base + '/api/auth/qr-status?code=' + code);
  assert.equal((await status.json()).state, 'approved');

  const qrLogin = await fetch(base + '/api/auth/qr-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(qrLogin.status, 200);
  assert.ok((qrLogin.headers.get('set-cookie') || '').includes('ha3d_session='));

  const again = await fetch(base + '/api/auth/qr-login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(again.status, 400, '同 code 二次 login 必须拒绝');

  const gone = await fetch(base + '/api/auth/qr-status?code=' + code);
  assert.equal((await gone.json()).state, 'gone', '消费后记录删除');
});

test('登录锁定：同 IP 连续 5 次失败后 429（本文件最后一个登录用例）', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await login('bad-' + i);
    assert.equal(res.status, 401, '第 ' + (i + 1) + ' 次失败应 401');
  }
  const locked = await login('secret-pass');   // 密码正确也得等锁定过
  assert.equal(locked.status, 429);
  assert.match((await locked.json()).error, /尝试过多/);
});
