'use strict';
/* 域 4：安装密钥 / 远程安装 / 编辑页导入 —— 对应旧 handleInstall。
 * zip 是原始二进制，必须走 readRawBody；绝不能挂 body-parser 先消费掉流。 */
const crypto = require('crypto');
const express = require('express');
const core = require('./shared');
const { INSTALL_MAX_BYTES, PLUGIN_ID_RE, installPackage } = require('./library');
const { json, wrap, readBody, readRawBody, requestURL } = require('./shared');

module.exports = function installRoutes() {
  const r = express.Router({ caseSensitive: true, strict: true });

  /* 不返回密钥明文，只回是否已设置 + 末 4 位 */
  r.get('/install/config', (req, res) => {
    const key = core.installKey();
    return json(res, 200, {
      hasKey: !!key,
      keyTail: key ? key.slice(-4) : '',
      locked: core.installKeyLocked(),
    });
  });

  r.post('/install/config', wrap(async (req, res) => {
    if (core.installKeyLocked()) {
      return json(res, 409, { error: '安装密钥已由环境变量 HA3D_INSTALL_KEY 设置，页面不能修改' });
    }
    const body = await readBody(req);
    const key = String((body && body.key) || '').trim();
    /* 会作为 HTTP 头 X-Install-Key 传输 → 限定可见 ASCII */
    if (!/^[A-Za-z0-9_.:@-]{6,128}$/.test(key)) {
      return json(res, 400, { error: '安装密钥需 6–128 位，仅限字母、数字与 _ . : @ -' });
    }
    core.setInstallKey(key);
    return json(res, 200, { saved: true, keyTail: key.slice(-4) });
  }));

  r.post('/install/config/generate', wrap((req, res) => {
    if (core.installKeyLocked()) {
      return json(res, 409, { error: '安装密钥已由环境变量 HA3D_INSTALL_KEY 设置，不能重新生成' });
    }
    const key = 'hk_' + crypto.randomBytes(12).toString('base64url');
    core.setInstallKey(key);
    core.log('[ha-3d-home] 已生成新的插件安装密钥（旧密钥失效）');
    return json(res, 200, { key, keyTail: key.slice(-4) });
  }));

  /* 远程安装：POST /api/plugins/install?id=<id>&version=<v>
   * 请求体 = studio 打的 zip 原始字节；头 X-Install-Key 校验；?id= 与 X-Plugin-Id 二选一。 */
  r.post('/plugins/install', wrap(async (req, res) => {
    const needKey = core.installKey();
    if (!needKey) {
      return json(res, 401, {
        error: '未配置安装密钥：请在本站「连接与服务」里设置安装密钥，或设置环境变量 HA3D_INSTALL_KEY',
      });
    }
    if (String(req.headers['x-install-key'] || '') !== needKey) {
      return json(res, 401, { error: '安装密钥不正确（X-Install-Key 与本站设置不一致）' });
    }

    const u = requestURL(req);
    const qid = String(u.searchParams.get('id') || '').trim();
    const hid = String(req.headers['x-plugin-id'] || '').trim();
    if (qid && hid && qid !== hid) return json(res, 400, { error: '查询参数 id 与 X-Plugin-Id 不一致' });
    const id = qid || hid;
    if (!id) return json(res, 400, { error: '缺少插件 id（?id= 或 X-Plugin-Id）' });
    if (!PLUGIN_ID_RE.test(id)) {
      return json(res, 400, { error: '插件 id 不合法：小写字母开头，字母/数字/_ . -，最长 64' });
    }

    let zipBuf;
    try { zipBuf = await readRawBody(req, INSTALL_MAX_BYTES); }
    catch (e) { return json(res, 413, { error: e.message }); }
    try { return json(res, 200, await installPackage(zipBuf, id)); }
    catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }));

  /* 编辑页「导入插件」：本站 UI 直接上传 zip，id 从包内清单读，无需密钥 */
  r.post('/plugins/import', wrap(async (req, res) => {
    let zipBuf;
    try { zipBuf = await readRawBody(req, INSTALL_MAX_BYTES); }
    catch (e) { return json(res, 413, { error: e.message }); }
    try { return json(res, 200, await installPackage(zipBuf, null)); }
    catch (e) { return json(res, e.status || 500, { error: e.message }); }
  }));

  return r;
};
