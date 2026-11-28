'use strict';
/*
 * HA 3D Home — 可选的单账号登录门禁（server/auth.js）
 *
 * 设计目标：内网部署零感知；外网穿透（jmlink 等）时用环境变量开一个账号即可。
 *   · 不启用：HA3D_AUTH_USER / HA3D_AUTH_PASS 只要有一个没配 → 全部放行，行为与过去完全一致
 *   · 启用：账号密码登录写 HttpOnly session cookie；一次性二维码供 App 扫码登录
 *   · 无用户管理、无数据库：二维码放内存（60 秒短命）；session 落盘 data/auth-sessions.json，
 *     重启自动恢复（多设备各持独立 token，重启免重登）
 *
 * 环境变量：
 *   HA3D_AUTH_USER        账号（明文）
 *   HA3D_AUTH_PASS        密码（明文）
 *   HA3D_AUTH_PASS_HASH   密码哈希，优先于明文，格式 scrypt:<saltHex>:<hashHex>
 *                         生成：node -e "const c=require('crypto'),s=c.randomBytes(16).toString('hex');" \
 *                              "console.log('scrypt:'+s+':'+c.scryptSync('你的密码',s,32).toString('hex'))"
 *   HA3D_SESSION_DAYS     session 有效期天数（默认 7）；**滑动续期**：剩余不足一半时，
 *                         任何一次通过门禁的请求都会把有效期续满并重发 cookie，
 *                         常用设备永不掉登录、闲置超过该天数才过期
 *
 * 接口（全部挂在 /api/auth/，全部在门禁白名单里）：
 *   GET  /api/auth/me            → { enabled, authenticated }（登录页 / 前端判断是否已登录）
 *   POST /api/auth/login         → { user, pass } → Set-Cookie → { ok }
 *   POST /api/auth/logout        → 删 session + 清 cookie
 *   GET  /api/auth/qr            → 生成一次性码 → { code, payload, expiresIn }
 *   GET  /api/auth/qr.svg        → ?text=xxx → 二维码 SVG（用 qrcode 依赖，纯服务端生成）
 *   GET  /api/auth/qr-status     → ?code=xxx → { state: pending|approved|consumed|expired|gone }
 *   POST /api/auth/qr-approve    → { code } + 授权方 token → 标记已授权（不写 cookie）
 *   POST /api/auth/qr-login      → { code } → 消费码 + Set-Cookie → { ok }
 *
 * 二维码「授权登录」语义（2026-11-19 改为授权模式）：
 *   展示二维码的一方 = 待登录方（浏览器/电视/另一台设备），负责展示 + 轮询；
 *   扫码的一方 = 已登录的授权方（App），带自己的 token 调 qr-approve 批准，不写 cookie；
 *   待登录方轮询到 approved 后调 qr-login，session 落在【待登录方】自己的 cookie 里。
 *   一句话：App 已登录 = 授权方，扫码批准别人登录；谁展示二维码谁登录。
 *
 * 跨网络（一个内网、一个外网、但打同一个后端进程）成立的原因：
 *   code 存在服务端内存 qrs Map，与客户端 origin 无关。授权方用自己的地址 + token
 *   调 qr-approve，待登录方用自己的地址轮询/兑换，两端各自带上 code 即可对上同一条记录。
 *   ⚠ 前提：两端打到同一个后端进程；多实例 + 无共享内存会各存一份 qrs，code 对不上。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const core = require('./shared');
const { json, wrap, requestURL, normPathname, readBody, log, logErr } = core;

const COOKIE = 'ha3d_session';
const USER = String(process.env.HA3D_AUTH_USER || '').trim();
const PASS = String(process.env.HA3D_AUTH_PASS || '');
const HASH = String(process.env.HA3D_AUTH_PASS_HASH || '').trim();
const DAYS = (() => {
  const n = Number(process.env.HA3D_SESSION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 7;
})();
const TTL_MS = DAYS * 24 * 3600 * 1000;
/* 滑动续期阈值：剩余有效期不足一半 TTL 时才续（续满一整个 TTL）。
 * 为什么不是每次都续：每个请求都写盘 + 下发 Set-Cookie 没必要；
 * 一半的余量足够覆盖「隔几天才打开一次」的电视/平板，也不会让闲置会话永不过期。 */
const RENEW_BEFORE_MS = TTL_MS / 2;
const QR_TTL_MS = 60 * 1000;      // 一次性码 60 秒有效
const QR_HOLD_MS = 60 * 1000;     // qr-status 长轮询 hold 上限（用户定稿 60 秒；码寿命也是 60s，超时即过期）

/* 唤醒该 code 上所有 hold 中的长轮询（qr-approve / qr-login 状态变化时调用） */
function wakeQr(code, state) {
  const e = qrs.get(code);
  const list = (e && e.waiters) || [];
  if (e) e.waiters = [];
  for (const w of list) w(state);
}
const MAX_FAILED = 5;            // 同 IP 连续失败 5 次
const LOCK_MS = 60 * 1000;       // 锁定 60 秒
const enabled = !!(USER && (PASS || HASH));

/* token -> expiresAt(ms)；code -> { exp, state }；ip -> { n, until }
   code state: pending（待授权）→ approved（已授权待兑换）→ consumed（已兑换登录） */
const sessions = new Map();
const qrs = new Map();
const failed = new Map();

if (enabled) log('[auth] 登录门禁已启用，账号:', USER, '有效期:', DAYS, '天');

/* ---------------- session 落盘（2026-11-19） ----------------
 * 账号只有一个，但设备不只有一个：App / 平板 / PC 浏览器各自持有一条独立 token，
 * sessions 是 token -> 过期时间的 Map，天然支持多设备并发登录。
 * 之前重启即丢 Map，所有设备被迫重新登录；现在整表落盘 data/auth-sessions.json，
 * 启动时恢复并过滤过期条目。变更用 200ms 节流合并写，单账号场景变更极少，文件几行而已。
 * 二维码 qrs（60 秒）与失败锁定 failed 不落盘——短命数据，重启丢失无影响。 */
const SESS_FILE = path.join(core.DATA_DIR, 'auth-sessions.json');

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8'));
    const now = Date.now();
    let n = 0;
    for (const [t, exp] of raw) {
      if (typeof t === 'string' && Number.isFinite(exp) && exp > now) { sessions.set(t, exp); n++; }
    }
    if (n) log('[auth] 已恢复落盘 session:', n, '条（多设备免重登）');
  } catch (e) { /* 文件不存在/损坏 → 空表起步，行为与过去一致 */ }
}

let persistTimer = null;
function persistSessions() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.mkdirSync(path.dirname(SESS_FILE), { recursive: true });
      fs.writeFileSync(SESS_FILE, JSON.stringify([...sessions]));
    } catch (e) {
      logErr('[auth] session 落盘失败（不影响运行，重启后需重登）:', e.message);
    }
  }, 200);
  if (persistTimer.unref) persistTimer.unref();
}

/* ---------------- cookie / 会话基础件 ---------------- */
function cookieOf(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/* token 来源：header 优先，cookie 回退。
   · 浏览器端走 cookie（登录接口 Set-Cookie 自动写入）
   · App 端走 header：原生存 token，跨内外网地址复用，不受 cookie 的 origin 隔离限制。
     支持两种写法：X-HA3D-Token: <token> / Authorization: Bearer <token>。
   两种来源都指向同一张内存 session 表，服务端不区分。 */
function tokenOf(req) {
  const h = req.headers || {};
  const direct = String(h['x-ha3d-token'] || '').trim();
  if (direct) return direct;
  const bearer = /^Bearer\s+(.+)$/i.exec(String(h.authorization || '').trim());
  if (bearer) return bearer[1].trim();
  return cookieOf(req, COOKIE);
}

/* 穿透工具一般给 HTTPS；内网直连是 HTTP。只在确认是 HTTPS 时加 Secure，
   否则浏览器不会存 cookie，内网就登不进去。X-Forwarded-Proto 取第一个值。 */
function isSecure(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return xf === 'https' || !!req.secure;
}

function sessionCookie(req, token, maxAge) {
  return COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge
    + (isSecure(req) ? '; Secure' : '');
}

function clearCookie() {
  return COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

function newSession() {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + TTL_MS);
  persistSessions();
  return t;
}

function validSession(t) {
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); persistSessions(); return false; }
  return true;
}

/* 滑动续期：剩余不足 RENEW_BEFORE_MS 时把过期时间续满一整个 TTL，返回 true 表示这次续了。
 * 调用方负责重发 cookie —— 浏览器 cookie 的 Max-Age 只在登录/续期时下发，
 * 服务端续了但 cookie 不续，浏览器到期照样丢掉会话（App 的 cookie 是原生种的 1 年，不受影响）。 */
function renewIfNeeded(t) {
  const exp = sessions.get(t);
  if (!exp) return false;
  const now = Date.now();
  if (exp < now) return false;                 // 已过期（validSession 会负责清理）
  if (exp - now >= RENEW_BEFORE_MS) return false;
  sessions.set(t, now + TTL_MS);
  persistSessions();
  log('[auth] session 滑动续期，剩余有效期重置为', DAYS, '天');
  return true;
}

/* 请求级鉴权：校验 → 需要时续期 → 顺手重发 cookie。
 * guard / /api/auth/me 都走这里，保证「只要还在用就不会掉登录」。
 * res 可为空（WS upgrade 这类没有 Express 响应对象），那时只续服务端表。 */
function sessionCheck(req, res) {
  const t = tokenOf(req);
  if (!validSession(t)) return false;
  if (renewIfNeeded(t) && res && !res.headersSent) {
    res.setHeader('Set-Cookie', sessionCookie(req, t, Math.floor(TTL_MS / 1000)));
  }
  return true;
}

function reqOrigin(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = xf || (req.secure ? 'https' : 'http');
  const xh = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = xh || req.headers.host || ('localhost:' + (process.env.PORT || '8077'));
  return proto + '://' + host;
}

/* 客户端 IP：登录锁定用的键。X-Forwarded-For 可被客户端任意伪造，无脑采信 =
 * 攻击者每次换个假 IP 就绕过 5 次锁定。默认只认 socket 直连地址；部署在反向代理
 * 之后（真实 IP 只在 XFF 里）时设 TRUST_XFF=1 显式开启采信。 */
function ipOf(req) {
  if (process.env.TRUST_XFF) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || '?';
}

function lockedFor(ip) {
  const e = failed.get(ip);
  if (!e || !e.until) return 0;
  if (e.until > Date.now()) return Math.ceil((e.until - Date.now()) / 1000);
  failed.delete(ip);
  return 0;
}

function failOnce(ip) {
  const e = failed.get(ip) || { n: 0, until: 0 };
  e.n++;
  if (e.n >= MAX_FAILED) { e.until = Date.now() + LOCK_MS; e.n = 0; }
  failed.set(ip, e);
}

function passOK(input) {
  if (!HASH) {
    const a = Buffer.from(String(input));
    const b = Buffer.from(PASS);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const parts = HASH.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const want = Buffer.from(parts[2], 'hex');
    const got = crypto.scryptSync(String(input), salt, want.length);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  } catch (e) { return false; }
}

function sendWithCookie(res, code, obj, setCookie) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': setCookie,
  });
  res.end(JSON.stringify(obj));
}

/* ---------------- 门禁中间件 ---------------- */
/* 未登录时：
   · 页面导航（/、/index.html、/edit…）→ 302 到登录页并带 next
   · /api/*（除白名单）→ 401 JSON（前端据此跳登录）
   · /custom/*（用户私有资产）→ 401 纯文本
   · 其余静态资源 → 放行：登录页自身是 Vite 入口，它的 JS/CSS 在 /static/*（生产），
     必须能匿名加载，否则未登录访问 /login.html 会白屏。bundle/字体/内置 assets
     都不含敏感数据；HA 长期令牌由服务端代管（ha-proxy.js），不下发给浏览器，
     项目数据只经 /api/* 暴露，已受保护。 */
const PAGE_RE = /^\/(index|edit)(\/|\.html?$|$)/;
function isPage(p) {
  if (p === '/' || p === '') return true;
  if (p.endsWith('.html')) return true;
  return PAGE_RE.test(p);
}

/* ---------------- 门禁白名单（免登录，但各自仍有自己的鉴权） ----------------
 * 2026-11-19：studio 是独立服务，调 home 时没有本站 session；它走的是下面的公开接口。
 * 白名单只表示「不被登录门禁拦」，不等于无鉴权：
 *   · /api/plugins/install —— 由 server/install.js 用 X-Install-Key 校验（密钥是唯一凭据）；
 *   · /api/house/size、/api/catalog —— 只读元信息（户型长宽 / 家具分类），studio 匿名读取；
 *   · /api/health、/api/version —— 健康检查与版本号，App 裸请求核对离线缓存用。
 * 按方法放行，避免 POST /api/catalog 之类的误穿透。 */
const PUBLIC_API = [
  { path: '/api/health', methods: null },
  { path: '/api/version', methods: null },
  { path: '/api/plugins/install', methods: ['POST'] },
  { path: '/api/house/size', methods: ['GET', 'HEAD'] },
  { path: '/api/catalog', methods: ['GET', 'HEAD'] },
];
function isPublicApi(p, method) {
  if (p.startsWith('/api/auth/')) return true;
  return PUBLIC_API.some((e) => e.path === p && (!e.methods || e.methods.includes(method)));
}
function guard(req, res, next) {
  if (!enabled) return next();
  if (req.method === 'OPTIONS') return next();  // CORS 预检交给下游（仍返回 405）
  /* 门禁判断必须用解码归一后的路径：new URL().pathname 不解码 %xx，
   * /%63ustom/... 会绕过 /custom/ 前缀判断（与静态层共用 normPathname）。
   * 再统一小写口径：Windows/macOS 文件系统大小写不敏感，/EDIT.HTML 与 /edit.html
   * 是同一个文件，门禁若区分大小写就会被大写变体绕过（生产 Linux 上小写化
   * 只会让未匹配路径更早拦下，无副作用）。 */
  const u = requestURL(req);
  const p = normPathname(u);
  const pl = p.toLowerCase();
  if (pl === '/login.html' || isPublicApi(pl, req.method)) return next();
  if (sessionCheck(req, res)) return next();

  if (isPage(pl)) {
    const nextPath = p + (u.search || '');
    res.writeHead(302, {
      'Location': '/login.html?next=' + encodeURIComponent(nextPath),
      'Cache-Control': 'no-store',
    });
    return res.end();
  }
  if (pl.startsWith('/api/')) return json(res, 401, { error: '请先登录', needLogin: true });
  /* 用户自定义资产（家具 GLB / 插件 / catalog）是私有数据，未登录不放行 */
  if (pl.startsWith('/custom/')) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('401 Unauthorized');
  }
  /* 其余静态资源（登录页 bundle /static/*、字体、内置 assets）匿名放行 */
  return next();
}

/* ---------------- 路由 ---------------- */
function routes() {
  const r = express.Router({ caseSensitive: true, strict: true });

  r.get('/auth/me', (req, res) => json(res, 200, {
    enabled,
    authenticated: !enabled || sessionCheck(req, res),
  }));

  r.post('/auth/login', wrap(async (req, res) => {
    if (!enabled) return json(res, 200, { ok: true, disabled: true });
    const ip = ipOf(req);
    const wait = lockedFor(ip);
    if (wait) return json(res, 429, { error: '尝试过多，请 ' + wait + ' 秒后再试' });
    const body = (await readBody(req)) || {};
    const u = String(body.user == null ? '' : body.user).trim();
    const p = String(body.pass == null ? '' : body.pass);
    if (u !== USER || !passOK(p)) {
      failOnce(ip);
      return json(res, 401, { error: '账号或密码错误' });
    }
    failed.delete(ip);
    const token = newSession();
    /* body 回传 token 供 App 原生持久化（跨地址复用）；浏览器端忽略此字段，照旧用 cookie */
    return sendWithCookie(res, 200, { ok: true, token }, sessionCookie(req, token, Math.floor(TTL_MS / 1000)));
  }));

  r.post('/auth/logout', (req, res) => {
    const t = tokenOf(req);
    if (t) { sessions.delete(t); persistSessions(); }
    return sendWithCookie(res, 200, { ok: true }, clearCookie());
  });

  /* 一次性码：payload 是二维码内容。用完整 URL，这样任意扫码器都能打开；
     待登录方展示此码，App（授权方）解析出 code 调 qr-approve，而不是打开这个 URL。
     payload 里的地址是【待登录方】的 origin，仅便于扫码器打开；App 授权时不用它，
     App 用自己的地址 + token 调 qr-approve（跨网络时两端 origin 天然不同）。 */
  r.get('/auth/qr', (req, res) => {
    if (!enabled) return json(res, 200, { enabled: false });
    const code = crypto.randomBytes(12).toString('hex');
    qrs.set(code, { exp: Date.now() + QR_TTL_MS, state: 'pending' });
    const payload = reqOrigin(req) + '/login.html?code=' + code;
    return json(res, 200, { code, payload, expiresIn: Math.floor(QR_TTL_MS / 1000) });
  });

  /* 二维码 SVG：服务端用 qrcode 库生成，前端一个 <img> 即可，不依赖外网 CDN。 */
  r.get('/auth/qr.svg', (req, res) => {
    const text = String(requestURL(req).searchParams.get('text') || '').slice(0, 512);
    if (!text) { res.writeHead(400); return res.end(); }
    let QR;
    try { QR = require('qrcode'); } catch (e) { res.writeHead(500); return res.end('qrcode unavailable'); }
    QR.toString(text, {
      type: 'svg', margin: 1, width: 220,
      color: { dark: '#162033', light: '#ffffff' },
    }).then((svg) => {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(svg);
    }).catch(() => { res.writeHead(500); res.end('qr error'); });
  });

  /* 待登录方轮询：pending=还没人授权 / approved=授权方已批准，可以兑换 / consumed=已被兑换。
     注意 approved 后仍保留记录直到 qr-login 消费，避免轮询期间状态回退。
     长轮询（2026-11-19）：?wait=1 且状态为 pending 时 hold 响应，状态一变立即返回——
     授权后登录页即时跳转（原 1.2s 短轮询最多要等一个间隔），慢链路请求量也降一个量级。
     hold 只挂 res 不占事件循环；超时/断开/条目清理都安全退出。 */
  r.get('/auth/qr-status', (req, res) => {
    const sp = requestURL(req).searchParams;
    const code = String(sp.get('code') || '');
    const wait = sp.get('wait') === '1';
    const e = qrs.get(code);
    if (!e) return json(res, 200, { state: 'gone' });
    if (e.exp < Date.now()) { qrs.delete(code); return json(res, 200, { state: 'expired' }); }
    if (!wait || e.state !== 'pending') return json(res, 200, { state: e.state });

    let done = false;
    const timer = setTimeout(() => {
      /* 超时：按条目当前真实状态返回（hold 期间可能已被清理/过期） */
      const cur = qrs.get(code);
      finish(!cur || cur.exp < Date.now() ? 'expired' : cur.state);
    }, QR_HOLD_MS);
    const finish = (state) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const list = e.waiters || [];
      const i = list.indexOf(finish);
      if (i >= 0) list.splice(i, 1);
      if (!res.writableEnded && !res.destroyed) json(res, 200, { state });
    };
    e.waiters = e.waiters || [];
    e.waiters.push(finish);
    req.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const i = (e.waiters || []).indexOf(finish);
      if (i >= 0) e.waiters.splice(i, 1);
    });
  });

  /* 授权方（App）批准：必须带有效 token（自己已登录），否则任何人都能授权，门禁形同虚设。
     ⚠ 不写 cookie：批准动作不能让 App 自己登录，登录态要落在待登录方（qr-login）。
     跨网络要点：请求从 App 自己的地址发出，只靠 code 命中服务端内存里的同一条记录。 */
  r.post('/auth/qr-approve', wrap(async (req, res) => {
    if (!enabled) return json(res, 200, { ok: true, disabled: true });
    if (!sessionCheck(req, res)) return json(res, 401, { error: '授权方未登录', needLogin: true });
    const body = (await readBody(req)) || {};
    const code = String(body.code == null ? '' : body.code).trim();
    const e = qrs.get(code);
    if (!e || e.exp < Date.now()) {
      if (e) qrs.delete(code);
      return json(res, 400, { error: '二维码无效或已过期' });
    }
    if (e.state === 'consumed') return json(res, 400, { error: '二维码已使用' });
    e.state = 'approved';
    wakeQr(code, 'approved');
    return json(res, 200, { ok: true });
  }));

  /* 待登录方兑换：要求已被授权（approved），一次性；成功后 session 落在【调用方】cookie。
     这就是"谁展示二维码谁登录"——App 只是批准，从不调这个接口。 */
  r.post('/auth/qr-login', wrap(async (req, res) => {
    const body = (await readBody(req)) || {};
    const code = String(body.code == null ? '' : body.code).trim();
    const e = qrs.get(code);
    if (!e || e.exp < Date.now() || e.state !== 'approved') {
      if (e && e.exp < Date.now()) qrs.delete(code);
      return json(res, 400, { error: '二维码未授权或已过期' });
    }
    wakeQr(code, 'consumed');   // 先唤醒还在 hold 的展示方（其他页签/刷新前）
    qrs.delete(code);
    const token = newSession();
    return sendWithCookie(res, 200, { ok: true, token }, sessionCookie(req, token, Math.floor(TTL_MS / 1000)));
  }));

  return r;
}

/* 定期清理过期数据；unref 避免测试/工具进程被定时器挂住 */
const cleaner = setInterval(() => {
  const now = Date.now();
  let dirty = false;
  for (const [k, exp] of sessions) if (exp < now) { sessions.delete(k); dirty = true; }
  for (const [k, e] of qrs) if (e.exp < now) qrs.delete(k);
  /* failed Map 从不清理会无限膨胀（锁定过期条目 + 未达阈值的失败计数都要收）：
     未锁定的计数一小时窗口足够（锁定阈值 5 次），过期锁定读侧 lockedFor 也会删，这里兜底 */
  for (const [k, e] of failed) if (!e.until || e.until < now) failed.delete(k);
  if (dirty) persistSessions();   // 把清理出的过期条目同步出落盘文件
}, 3600 * 1000);
if (cleaner.unref) cleaner.unref();

/* 启动即恢复落盘 session：服务重启后各设备（App 原生 token / 浏览器 cookie）无需重新登录 */
loadSessions();

/* 供非常规 HTTP 请求的鉴权点（如 ha-proxy 的 WebSocket upgrade）复用同一条校验。
 * 没有 Express 响应对象、没法重发 cookie，只做「校验 + 续服务端表」——
 * 页面自身的 HTTP 请求随后会把 cookie 续掉；WS 断线重连时也会重新走这里。 */
function check(req) { return enabled ? sessionCheck(req, null) : true; }

module.exports = { guard, routes, check };
