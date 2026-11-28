'use strict';
/* automation-proxy.js — Home 服务端代理 ha3d-automation 的两个能力（2026-11-25 接管方案步骤 6）：
 *
 *   GET  /api/automation/actions       → automation GET  /api/actions（动作与场景候选，只读）
 *   POST /api/automation/trigger/:id   → automation POST /api/script/:id/trigger（一次性执行）
 *
 * 浏览器/展示页/编辑页都只认 home 自己的 origin，不直连 automation —— 与 HA 的
 * ha-proxy 同一思路：内网地址不出服务端，地址切换/外网隧道/CORS 都不影响面板。
 * 鉴权沿用全局 auth.guard（/api/* 已拦未登录）；automation 侧按拍板不加鉴权。
 *
 * 地址：HA3D_AUTOMATION_URL 环境变量，默认 http://127.0.0.1:8100（本机开发）。
 * Docker 里两个容器若不在同一网络，需显式配置（如 http://ha3d-automation:8100）。
 */
const express = require('express');
const core = require('./shared');
const { json, wrap, errText } = core;

const DEFAULT_BASE = 'http://127.0.0.1:8100';
function autoBase() {
  return (process.env.HA3D_AUTOMATION_URL || DEFAULT_BASE).trim().replace(/\/+$/, '');
}

/* 统一上游调用：超时中止 + 读 JSON + 非 2xx 把上游 error 原样带回来。
 * 错误消息抹掉上游地址（与 ha-proxy.safeErr 同口径，防内网地址泄漏）。 */
async function upstream(apiPath, { method = 'GET', timeoutMs = 8000 } = {}) {
  const base = autoBase();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(base + apiPath, {
      method, signal: ac.signal, headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 留给错误分支处理 */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('automation 返回 ' + res.status));
      err.upstream = true;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.upstream) throw e;
    const raw = e && e.name === 'AbortError' ? '请求超时' : errText(e);
    const err = new Error('automation 代理失败：' + core.maskUpstream(raw, base, 'automation'));
    err.status = 502;
    throw err;
  } finally { clearTimeout(timer); }
}

function routes() {
  const r = express.Router({ caseSensitive: true, strict: true });

  r.get('/actions', wrap(async (req, res) => {
    try {
      const data = await upstream('/api/actions');
      return json(res, 200, { items: Array.isArray(data && data.items) ? data.items : [] });
    } catch (e) { return json(res, e.status || 502, { error: e.message }); }
  }));

  r.post('/trigger/:id', wrap(async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return json(res, 400, { error: '脚本 id 非法' });
    try {
      const data = await upstream('/api/script/' + encodeURIComponent(id) + '/trigger', { method: 'POST' });
      return json(res, 200, { ok: true, ...(data && typeof data === 'object' ? data : {}) });
    } catch (e) { return json(res, e.status || 502, { error: e.message }); }
  }));

  return r;
}

module.exports = { routes };
