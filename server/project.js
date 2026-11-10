'use strict';
/* 域 5：户型项目 / 旋转锚点 / 房屋尺寸 —— 对应旧 handleProject。 */
const express = require('express');
const core = require('./shared');
const { json, wrap, readBody } = require('./shared');

module.exports = function projectRoutes() {
  const r = express.Router({ caseSensitive: true, strict: true });

  r.get('/project', (req, res) => json(res, 200, core.loadProject()));

  const save = wrap(async (req, res) => {
    const body = await readBody(req);
    const proj = core.normProject(body);
    if (!proj) {
      return json(res, 400, { error: '项目数据不合法：需要 { name, floors: [{ name, walls/doors/windows/furniture/devices }] }' });
    }
    return json(res, 200, core.saveProject(proj));
  });
  r.post('/project', save);
  r.put('/project', save);

  /* 锚点单独开接口：由服务端读最新文件做局部合并，避免整份项目覆盖编辑页的新数据 */
  r.get('/anchor', (req, res) => json(res, 200, { anchors: core.loadAnchors() }));
  const putAnchor = wrap(async (req, res) => {
    const body = await readBody(req);
    const anchors = core.saveAnchor(body);
    if (!anchors) {
      return json(res, 400, { error: '锚点数据不合法：需要 { floor, mode:"center"|"custom", x, y, z }' });
    }
    return json(res, 200, { ok: true, anchors });
  });
  r.put('/anchor', putAnchor);
  r.post('/anchor', putAnchor);

  /* 按各楼层墙体现算最大的那层；算不出再回退 project.json 里保存的 houseW/houseD */
  r.get('/house/size', (req, res) => {
    const proj = core.loadProject();
    let w = 0, d = 0;
    ((proj && proj.floors) || []).forEach((fl) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      ((fl && fl.walls) || []).forEach((wt) => {
        if (![wt.x1, wt.x2, wt.y1, wt.y2].every((n) => typeof n === 'number' && isFinite(n))) return;
        x0 = Math.min(x0, wt.x1, wt.x2); x1 = Math.max(x1, wt.x1, wt.x2);
        y0 = Math.min(y0, wt.y1, wt.y2); y1 = Math.max(y1, wt.y1, wt.y2);
      });
      if (x1 > x0 && y1 > y0) { w = Math.max(w, x1 - x0); d = Math.max(d, y1 - y0); }
    });
    w = Math.round(w * 10) / 10;
    d = Math.round(d * 10) / 10;
    if (!(w > 0) || !(d > 0)) { w = Number(proj && proj.houseW); d = Number(proj && proj.houseD); }
    const ok = w > 0 && d > 0;
    return json(res, 200, { ok, houseW: ok ? w : null, houseD: ok ? d : null });
  });

  return r;
};
