/*
 * HTTP 小工具：JSON 响应 + 请求体读取。
 * 与「静态资源怎么发出去」无关，从 assets.js 拆出来，供路由层和其它模块共用。
 * 零 npm 依赖（只用 Node 内置模块）。
 */
'use strict';

const BODY_MAX_BYTES = 20 * 1024 * 1024;   // JSON 请求体上限

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/* 统一的流式读取。超过上限后不再缓存数据、但继续把流读完，这样还能回一个
 * 正常的 JSON 错误（带 status 413），而不是直接掐断连接。 */
function collectBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { over = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) {
        return reject(Object.assign(
          new Error('请求体过大（上限 ' + Math.round(limit / 1048576) + 'MB）'), { status: 413 }));
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/* 读 JSON 请求体（解析失败回 null，由调用端判断） */
async function readBody(req) {
  const buf = await collectBody(req, BODY_MAX_BYTES);
  if (!buf.length) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
}

/* 读原始字节（上传 zip 用：要的就是二进制，不能走 JSON 解析） */
function readRawBody(req, limit) {
  return collectBody(req, limit);
}

/* 路由分域函数用它同时完成「回响应」与「告诉主流程已处理」，避免把
 * `return sendJSON(...)` 的 undefined 当成「未处理」继续往下走。 */
function reply(res, code, obj) {
  sendJSON(res, code, obj);
  return true;
}

module.exports = { BODY_MAX_BYTES, sendJSON, collectBody, readBody, readRawBody, reply };
