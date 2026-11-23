'use strict';
/* 域 4：安装密钥 / 远程安装 / 编辑页导入 —— 对应旧 handleInstall。
 * zip 是原始二进制，必须走 readRawBody；绝不能挂 body-parser 先消费掉流。 */
const crypto = require('crypto');
const express = require('express');
const core = require('./shared');
const { INSTALL_MAX_BYTES, PLUGIN_ID_RE, installPackage, uninstallPlugin, uninstallCatalog } = require('./library');
const { json, wrap, readBody, readRawBody, requestURL, errText } = require('./shared');

module.exports = function installRoutes() {
  const r = express.Router({ caseSensitive: true, strict: true });

  /* 不返回密钥明文，只回是否已设置 + 末 4 位 */
  r.get('/install/config', (req, res) => {
    const key = core.installKey();
    return json(res, 200, {
      hasKey: !!key,
      keyTail: key ? key.slice(-4) : '',
    });
  });

  r.post('/install/config', wrap(async (req, res) => {
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
    const key = 'hk_' + crypto.randomBytes(12).toString('base64url');
    core.setInstallKey(key);
    core.log('[ha-3d-home] 已生成新的插件安装密钥（旧密钥失效）');
    return json(res, 200, { key, keyTail: key.slice(-4) });
  }));

  /* 远程安装：POST /api/plugins/install?id=<id>
   * 请求体 = studio 打的 zip 原始字节；头 X-Install-Key 校验；?id= 与 X-Plugin-Id 二选一。 */
  r.post('/plugins/install', wrap(async (req, res) => {
    const needKey = core.installKey();
    if (!needKey) {
      return json(res, 401, {
        error: '未配置安装密钥：请在本站编辑页「导入插件/包」弹窗里生成密钥，填到 studio 设置后才能远程发布',
      });
    }
    if (String(req.headers['x-install-key'] || '') !== needKey) {
      return json(res, 401, { error: '安装密钥不正确：studio 发布时带的 X-Install-Key 与本站设置不一致，请在 studio 设置页确认密钥' });
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
    catch (e) { return json(res, e && e.status || 500, { error: errText(e) }); }
    try { return json(res, 200, await installPackage(zipBuf, id)); }
    catch (e) { return json(res, e.status || 500, { error: errText(e) }); }
  }));

  /* 编辑页「导入插件」：本站 UI 直接上传 zip，id 从包内清单读，无需密钥 */
  r.post('/plugins/import', wrap(async (req, res) => {
    let zipBuf;
    try { zipBuf = await readRawBody(req, INSTALL_MAX_BYTES); }
    catch (e) { return json(res, e && e.status || 500, { error: errText(e) }); }
    try { return json(res, 200, await installPackage(zipBuf, null)); }
    catch (e) { return json(res, e.status || 500, { error: errText(e) }); }
  }));

  /* 清理弹窗「卸载」：kind=plugin 删 custom/plugins/<dir>，kind=catalog 删 custom/models/<dir>。
   * 目录名白名单 + 父目录校验在 uninstallFrom 内完成；成功时同步清对应 API 快照。
   * 前端依据「是否被引用」决定按钮是否可点；服务端不重复判定引用（引用真相在 project，
   * 服务端若自行拦会把「用户已确认删除但项目还留着脏 mid」的情况卡死，故只做路径安全）。 */
  r.post('/uninstall', wrap(async (req, res) => {
    const body = await readBody(req);
    const kind = String((body && body.kind) || '');
    const dir = String((body && body.dir) || '');
    if (!PLUGIN_ID_RE.test(dir)) {
      return json(res, 400, { error: '目录名不合法（小写字母/数字/_ . -）: ' + dir });
    }
    try {
      if (kind === 'plugin') return json(res, 200, uninstallPlugin(dir));
      if (kind === 'catalog') return json(res, 200, uninstallCatalog(dir));
      return json(res, 400, { error: 'kind 只能是 plugin 或 catalog' });
    } catch (e) { return json(res, e.status || 500, { error: errText(e) }); }
  }));

  return r;
};
