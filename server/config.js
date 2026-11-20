'use strict';
/* 域 2：HA 连接配置 / 连接测试 —— 对应旧 handleConfig。
 * 2026-11-19 起 HA WS 鉴权由服务端代理代管（ha-proxy.js），GET /api/config
 * 不再下发令牌，只回 haUrl / hasToken（令牌只能写不能读）。 */
const express = require('express');
const core = require('./shared');
const http = require('http');
const https = require('https');
const { json, wrap, readBody, errText } = require('./shared');

/* ===== 原 ha.js：HA 连接测试（已消化进配置域）===== */
/*
 * Home Assistant 连接测试。
 *
 * 前端默认浏览器直连 HA WebSocket（不受 CORS 限制），本服务不代理实时状态，
 * 也不再转发 /api/states 与 /api/services（早期 REST 兜底无调用方，已删除以收窄转发面）。
 * 这里只供「连接与服务」里的「测试连接」按钮调用一次 /api/config。
 */


function haBase() { return (core.getConfig().haUrl || '').replace(/\/+$/, ''); }

/* 目前只有「测试连接」一个调用方（GET /api/config），method/body 参数暂留简单版 */
function haRequest(apiPath) {
  return new Promise((resolve, reject) => {
    const base = haBase();
    if (!base) return reject(new Error('未配置 Home Assistant 地址'));
    let url;
    try { url = new URL(base + apiPath); } catch (e) { return reject(new Error('HA 地址无效')); }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + core.getConfig().token,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = text;
        try { data = JSON.parse(text); } catch (e) { /* keep text */ }
        if (res.statusCode >= 400) return reject(Object.assign(new Error('HA 返回 ' + res.statusCode), { status: res.statusCode }));
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求 HA 超时')); });
    req.end();
  });
}

async function testConnection() {
  const conf = await haRequest('/api/config');
  return { ok: true, version: conf.version, location_name: conf.location_name };
}


module.exports = function configRoutes() {
  const r = express.Router({ caseSensitive: true, strict: true });

  r.get('/config', (req, res) => {
    const c = core.getConfig();
    /* 令牌不下发（服务端代管鉴权，见 ha-proxy.js）；只暴露地址与是否已配置 */
    return json(res, 200, { haUrl: c.haUrl, hasToken: !!c.token });
  });

  r.post('/config', wrap(async (req, res) => {
    const body = await readBody(req);
    const cur = core.getConfig();
    /* 只接受字符串；非字符串（数字/对象等畸形输入）回退当前值，避免 .trim 崩 500 */
    const pickStr = (v, fb) => (typeof v === 'string' ? v : (fb || '')).trim();
    core.saveConfig({
      haUrl: pickStr(body && body.haUrl, cur.haUrl),
      token: pickStr(body && body.token, cur.token),
    });
    let test = { ok: false, error: '' };
    const c = core.getConfig();
    if (c.haUrl && c.token) {
      try { test = Object.assign({ ok: true }, await testConnection()); }
      catch (e) { test = { ok: false, error: errText(e) }; }
    }
    return json(res, 200, { saved: true, test });
  }));

  /* 刻意返回 200：连接失败也用 body.ok=false 表达，前端 ConnModal.vue 按 body.ok 判断，不检查 HTTP 状态 */
  r.post('/config/test', wrap(async (req, res) => {
    try { return json(res, 200, await testConnection()); }
    catch (e) { return json(res, 200, { ok: false, error: errText(e) }); }
  }));

  return r;
};
