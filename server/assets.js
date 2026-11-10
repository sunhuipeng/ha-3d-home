'use strict';
/* 域 3：资产目录 / 2D 参考底图 / 插件清单 —— 对应旧 handleAssets。 */
const express = require('express');
const { buildCatalog, saveRefImg, serveRefImg, catalogTypeDefs, listPlugins } = require('./library');
const { json, wrap, readBody } = require('./shared');

module.exports = function assetRoutes() {
  const r = express.Router({ caseSensitive: true, strict: true });

  r.post('/upload', wrap(async (req, res) => {
    const body = await readBody(req);
    try { return json(res, 200, saveRefImg(body && body.data)); }
    catch (e) { return json(res, e.status || 500, { error: String(e.message || e) }); }
  }));

  /* serveRefImg 直接操作原生 res（含 404 纯文本），不走 res.json */
  r.get('/refimg', (req, res) => { serveRefImg(res); return true; });

  r.get('/catalog', (req, res) => json(res, 200, { items: buildCatalog(), types: catalogTypeDefs() }));
  r.get('/plugins', (req, res) => json(res, 200, { plugins: listPlugins() }));

  return r;
};
