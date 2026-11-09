/*
 * 安装包落盘的公共原子替换。
 *
 * 插件包（custom/plugins/<id>）与家具包（custom/models/<id>）原本各写了一遍同样的
 * 「写临时目录 → 旧目录改名备份 → 新目录上位 → 失败回滚 → 清 tmp」，两份还不一致：
 * 插件版把删备份放在 try 内，删失败会误报 500，但实际已经升级成功。
 * 这里收口成一份，两个安装流程只负责把文件写进 tmp 目录。
 *
 * 零 npm 依赖（只用 Node 内置模块）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* writeFn(tmpDir) 里写完所有文件。成功返回 { upgraded }；
 * 任何一步失败都清理临时目录并回滚旧版本，抛带 status:500 的 Error 给路由。 */
function atomicDirReplace(parentDir, id, writeFn, label) {
  fs.mkdirSync(parentDir, { recursive: true });
  const target = path.join(parentDir, id);
  /* 同一毫秒并发安装同一 id 时别撞临时目录名 */
  const stamp = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  const tmp = path.join(parentDir, '.install-' + id + '-' + stamp);
  const backup = path.join(parentDir, '.old-' + id + '-' + stamp);
  let upgraded = false;
  try {
    writeFn(tmp);
    upgraded = fs.existsSync(target);
    if (upgraded) fs.renameSync(target, backup);          // 旧版本先挪开
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      if (upgraded) fs.renameSync(backup, target);        // 上位失败：把旧版本放回去
      throw e;
    }
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    throw Object.assign(new Error('写入' + label + '目录失败: ' + e.message), { status: 500 });
  }
  /* 删备份失败不影响「已经升级成功」这个事实，不能因此报 500 */
  if (upgraded) {
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  return { upgraded };
}

module.exports = { atomicDirReplace };
