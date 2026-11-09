/*
 * Home Assistant 连接测试。
 *
 * 前端默认浏览器直连 HA WebSocket（不受 CORS 限制），本服务不代理实时状态，
 * 也不再转发 /api/states 与 /api/services（早期 REST 兜底无调用方，已删除以收窄转发面）。
 * 这里只供「连接与服务」里的「测试连接」按钮调用一次 /api/config。
 */
'use strict';

const http = require('http');
const https = require('https');
const core = require('./core');

function haBase() { return (core.getConfig().haUrl || '').replace(/\/+$/, ''); }

function haRequest(apiPath, method, body) {
  return new Promise((resolve, reject) => {
    const base = haBase();
    if (!base) return reject(new Error('未配置 Home Assistant 地址'));
    let url;
    try { url = new URL(base + apiPath); } catch (e) { return reject(new Error('HA 地址无效')); }
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const req = mod.request(url, {
      method: method || 'GET',
      headers: {
        'Authorization': 'Bearer ' + core.getConfig().token,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
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
    if (payload) req.write(payload);
    req.end();
  });
}

async function testConnection() {
  const conf = await haRequest('/api/config', 'GET');
  return { ok: true, version: conf.version, location_name: conf.location_name };
}

module.exports = { haRequest, testConnection };
