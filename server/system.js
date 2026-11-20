'use strict';
/* 域 1：系统 —— 对应旧 handleSystem。
 * /api/health 旧实现不检查 method（任意方法都回），故用 r.all 复刻。 */
const express = require('express');
const core = require('./shared');
const { json } = require('./shared');

module.exports = function systemRoutes() {
  const r = express.Router({ caseSensitive: true, strict: true });

  r.all('/health', (req, res) => {
    const mem = process.memoryUsage().rss;
    return json(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      memMB: Math.round(mem / 1048576 * 10) / 10,
    });
  });

  /* 版本号唯一出处是根 package.json，core.appVersion 每次实时读文件 */
  r.get('/version', (req, res) => json(res, 200, { name: 'ha-3d-home', version: core.appVersion() }));

  return r;
};
