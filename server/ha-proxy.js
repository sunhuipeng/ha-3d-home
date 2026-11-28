'use strict';
/* ha-proxy.js — HA 全代理（2026-11-19 方案 A 定稿；同日升级为服务端代管鉴权）
 *
 * 背景：此前 HA WebSocket 由浏览器直连 data/config.json 里的 haUrl（内网地址），
 * 走外网隧道时页面/模型正常但 WS 连不上内网 IP（一直"正在重新链接"），
 * 摄像头图（entity_picture 拼 haUrl）同理。https 页面连 ws:// 内网地址还会被
 * 浏览器按混合内容直接拦掉。改为全代理后浏览器只认 home 服务一个 origin：
 *
 *   · WS  /api/ha-ws（http upgrade）→ 服务端向 HA 发起 /api/websocket 握手。
 *     2026-11-19 起从「原始字节透传」升级为 ws 库消息级中继，原因：
 *     HA token 不再随 /api/config 下发浏览器（展示页也不再请求 /api/config），
 *     改由【服务端】在收到 HA 的 auth_required 后用落盘 token 代发 auth，
 *     并吞掉客户端发来的 auth 消息（兼容仍会发 auth 的旧前端缓存）。
 *   · 未配置 HA：接受 upgrade 后以关闭码 4400 断开 —— 前端据此进演示模式，
 *     与「网络不通（1006）走重连退避」区分开。
 *   · 图片 /api/ha-media/*（GET）→ 服务端带 Bearer token 转发 HA（含查询串）。
 *
 * 代理路径自身受登录门禁约束（auth.check）。
 */
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const { Readable } = require('stream');
const core = require('./shared');
const auth = require('./auth');
const { json, log, logErr, errText } = core;

/* haBase 单一出处是 shared.js（审计 2.1）：此前 config/ha-proxy 两处各写一份，一处 trim 一处不 trim */
const haBase = core.haBase;

/* 报错脱敏：收敛到 shared.maskUpstream（审计 2.5，automation-proxy 同款逻辑）。
 * 本模块是不走 errText 直回前端的转发路由，曾泄漏过内网地址。 */
function safeErr(e, base) {
  return core.maskUpstream(e, base, 'ha');
}

/* http(s)://host:port → { secure, host, port }；无效返回 null */
function parseBase(base) {
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return {
      secure: u.protocol === 'https:',
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    };
  } catch (e) { return null; }
}

/* 给客户端 socket 回一段 HTTP 响应后断开（upgrade 阶段无法走 express 错误处理） */
function fail(socket, status, text) {
  try {
    socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + text + '\n');
  } catch (e) { /* socket 可能已断 */ }
}

/* ---------------- WS 消息级中继（服务端代管 HA 鉴权） ---------------- */

/* 未配置 HA 的专用关闭码：前端 onclose 收到它直接进演示模式，不做重连退避 */
const CLOSE_UNCONFIGURED = 4400;

function upgrade(req, socket, head) {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch (e) { pathname = req.url || ''; }
  if (pathname !== '/api/ha-ws') { try { socket.destroy(); } catch (e) {} return; }

  if (!auth.check(req)) return fail(socket, '401 Unauthorized', '未登录');
  const base = haBase();
  const dst = parseBase(base);
  if (!dst) {
    /* 未配置 HA：也要先完成 101 握手再按约定码断开 —— 否则浏览器侧只会看到
     * onerror + 1006，没法和「网络不通」区分（会一直转圈重连）。 */
    return wss.handleUpgrade(req, socket, head, (ws) => {
      try { ws.close(CLOSE_UNCONFIGURED, 'HA 未配置'); } catch (e) {}
    });
  }

  /* 服务端 → HA 的 WS 客户端：ws 库自己完成握手 / 掩码 / 分帧 */
  const proto = dst.secure ? 'wss' : 'ws';
  let upstream;
  try { upstream = new WebSocket(proto + '://' + dst.host + ':' + dst.port + '/api/websocket'); } catch (e) {
    logErr('[ha-proxy] HA WS 创建失败:', e && e.message || e);
    return wss.handleUpgrade(req, socket, head, (ws) => { try { ws.close(1011, 'HA 连接创建失败'); } catch (e2) {} });
  }
  /* 空窗期兜底：handleUpgrade 回调注册真正的转发逻辑之前，HA 连不上也不许崩进程 */
  upstream.on('error', (err) => { logErr('[ha-proxy] HA WS 建连失败:', err && err.message || err); });

  wss.handleUpgrade(req, socket, head, (client) => {
    let serverAuthed = false;   // 已替客户端完成过一次 auth（防 HA 重发 auth_required 时重复发）
    let dead = false;
    const die = () => {
      if (dead) return;
      dead = true;
      try { client.close(); } catch (e) {}
      try { upstream.close(); } catch (e) {}
    };

    upstream.on('message', (data, isBinary) => {
      if (dead) return;
      if (!isBinary) {
        let msg = null;
        try { msg = JSON.parse(data.toString('utf8')); } catch (e) { /* 非 JSON 原样转发 */ }
        if (msg && msg.type === 'auth_required') {
          /* 服务端代发 auth，token 绝不出服务器；auth_required 不转发，
             新前端（不发 auth）与旧前端（发了会被 client 侧吞掉）都只等 auth_ok */
          const token = core.getConfig().token || '';
          if (token && !serverAuthed) {
            serverAuthed = true;
            try { upstream.send(JSON.stringify({ type: 'auth', access_token: token })); } catch (e) {}
          } else if (!token) {
            /* 没配令牌：把缺失告诉前端（会话仍握手成功但 HA 会等 auth 超时），
               直接断开让前端走演示/重连路径更干净 */
            logErr('[ha-proxy] HA 地址已配置但令牌为空，断开 WS');
            try { client.close(4400, 'HA 令牌未配置'); } catch (e) {}
            return die();
          }
          return;
        }
        if (msg && msg.type === 'auth_invalid') {
          /* 服务端 token 被 HA 拒绝：原样转发给前端展示明确错误 */
          logErr('[ha-proxy] HA 拒绝了服务端配置的令牌 (auth_invalid)');
        }
      }
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on('close', () => die());
    upstream.on('error', (err) => {
      logErr('[ha-proxy] HA WS 通道异常:', err && err.message || err);
      try { client.close(1011, 'HA 通道异常'); } catch (e) {}
      die();
    });

    client.on('message', (data, isBinary) => {
      if (dead) return;
      if (!isBinary) {
        let msg = null;
        try { msg = JSON.parse(data.toString('utf8')); } catch (e) { /* 非 JSON 原样转发 */ }
        /* 客户端的 auth 一律吞掉：鉴权由服务端代管，别让客户端 token / 空值
           干扰 HA 握手（旧前端缓存仍会发 auth，吞掉即可完全兼容） */
        if (msg && msg.type === 'auth') return;
      }
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    });
    client.on('close', () => die());
    client.on('error', () => die());
  });
}

/* 客户端侧的 WS 服务：noServer，upgrade 里按需 handleUpgrade */
const wss = new WebSocketServer({ noServer: true, clientTracking: false });

/* ---------------- 媒体（图片）代理 ---------------- */
/* 登录门禁由全局 auth.guard 负责（/api/* 已拦未登录）；这里只做转发。
 * entity_picture 形如 /api/camera_proxy_stream/camera.xxx?token=...，
 * 拼上 haUrl 直接转发，响应头里的 Content-Type / Cache-Control 原样带回。 */
function mediaRoutes() {
  const r = express.Router({ caseSensitive: true, strict: true });
  r.get('/*', async (req, res) => {
    const base = haBase();
    if (!base) return json(res, 503, { error: '未配置 Home Assistant 地址' });
    const token = core.getConfig().token || '';
    /* req.url 是挂载点后的剩余部分（含 / 前缀与查询串） */
    const target = base + req.url;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      const up = await fetch(target, {
        headers: { Authorization: 'Bearer ' + token },
        signal: ac.signal,
      });
      clearTimeout(timer);
      const h = up.headers;
      if (h.get('content-type')) res.setHeader('Content-Type', h.get('content-type'));
      if (h.get('cache-control')) res.setHeader('Cache-Control', h.get('cache-control'));
      res.status(up.status);
      if (!up.body) return res.end();
      /* try/catch 只覆盖 fetch 阶段：上游流中途出错若无监听会成为 uncaught
       * exception，崩掉整个进程（曾因这里进程反复重启）。客户端提前断开时
       * 也要 cancel 上游流，别让 HA 继续把图片下载完。 */
      const stream = Readable.fromWeb(up.body);
      /* cancel 对已消费完/已出错的流会返回 rejected promise（流被 reader 锁定），
       * 必须把同步抛错与异步拒绝都吞掉，否则又是一个 unhandledRejection */
      const cancelUp = () => { try { Promise.resolve(up.body.cancel()).catch(() => {}); } catch (e) { /* 已结束 */ } };
      stream.on('error', () => { try { res.destroy(); } catch (e) { /* 连接已断 */ } });
      res.on('error', cancelUp);
      res.on('close', cancelUp);
      stream.pipe(res);
    } catch (e) {
      if (!res.headersSent) return json(res, 502, { error: 'HA 媒体转发失败: ' + safeErr(e, base) });
      try { res.end(); } catch (e2) {}
    }
  });
  return r;
}

module.exports = { upgrade, mediaRoutes };
