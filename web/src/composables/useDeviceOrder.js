/*
 * composables/useDeviceOrder.js — 设备排序与卡片隐藏标记（原 EditApp.vue 的方法组）
 *
 * 权重 = **fl.devices 的数组顺序**，卡片是跟着设备走的：
 * useCards 全屋分支直接遍历 fl.devices 建卡，CardEngine.buildListCard 再把
 * 「单元素卡（solo 聚合成一组）」与「多控件卡片」分开排，两类内部都按这个顺序。
 * 所以这里只改数组，不新增 order 字段（devOut 是白名单序列化，新字段会被静默丢弃）。
 *
 * 约束与房间排序（composables/useRooms.js）同一套：原地按槽位覆写（不替换数组引用，
 * 否则 2D 绘制 / 拾取还看旧顺序）；面板只产出新的 id 顺序，撤销栈 / 重绘 / 保存在
 * 这里一次做完。与房间排序不同：设备顺序不影响 3D 几何，**不需要 rebuild3D**。
 */
export const deviceOrderMethods = {
  reorderDevices(payload) {
    const fl = this.cur;
    const p = payload || {};
    if (!fl || !Array.isArray(p.ids)) return;
    if (!this._applyDeviceOrder(fl, p.ids)) return;
    /* label 带本次顺序：避免 Recode 600ms 同 label 合并把连续几次排序吞成一步 */
    Editor.changed(false, 'device-order:' + p.ids.join(','));
  },
  /* 只重排「可排序设备」占的槽位：家具实例与未绑实体的设备位置一字不动
   * （它们不出卡，顺序对展示没有意义，没必要跟着挪） */
  _applyDeviceOrder(fl, ids) {
    const arr = fl.devices || [];
    const sortable = (d) => !!d && !!d.entityId && d.type !== 'furniture';
    const slots = [];
    const byId = new Map();
    arr.forEach((d, i) => { if (sortable(d)) { slots.push(i); byId.set(d.id, d); } });
    if (slots.length !== ids.length) return false;   // 面板与数据不同步 → 放弃这次排序
    const next = ids.map((id) => byId.get(id));
    if (next.some((d) => !d) || new Set(next).size !== next.length) return false;
    if (next.every((d, k) => d === arr[slots[k]])) return false;   // 没变就不压撤销
    slots.forEach((idx, k) => { arr[idx] = next[k]; });
    return true;
  },
  /* ------- 卡片隐藏标记（DevOrderPanel 的「隐藏 / 显示」）-------
   * 语义：**不是隐藏设备本身**。设备对象照旧在 fl.devices 里，2D 绘制 / 3D 模型 /
   * 标签 / 点击全部不变；只在设备上写一个布尔 hideCard，建卡层（useCards 的
   * 全屋与房间分支）把它过滤掉 —— 卡片里不再出现这台设备的插片。
   * 单设备选中态照常出卡（显式点中 = 想看它），统计数字也仍按全部设备算。
   * 写入同 reorderDevices：改完一次 Editor.changed 压一条撤销 + 自动保存。 */
  toggleDeviceCardHide(id) {
    const fl = this.cur;
    const d = ((fl && fl.devices) || []).find((x) => x && x.id === id);
    if (!d) return;
    if (d.hideCard === true) delete d.hideCard;   // 显示：删掉标记，回到「未设置」
    else d.hideCard = true;
    /* label 带设备 id：连续隐藏多台不会被 600ms 同 label 合并成一条撤销 */
    Editor.changed(false, 'device-hide:' + id);
  },
  /* 一次恢复全部：只对真正隐藏过的设备动手，没有可改的就不压撤销 */
  showAllDeviceCards() {
    const fl = this.cur;
    const arr = (fl && fl.devices) || [];
    let n = 0;
    arr.forEach((d) => { if (d && d.hideCard === true) { delete d.hideCard; n++; } });
    if (!n) return;
    Editor.changed(false, 'device-hide:all');
  },
  /* 面板里点设备名：只做选中 + 画布 / 3D 高亮，不切工具 ——
     排序时常连续挪几次，切走会关掉设备浮层与排序面板 */
  selectDevice(id) {
    if (!id) return;
    Editor.select('device', id);
    Editor.render();
  },
  locateDevice(p) {
    if (p.fi !== this.floorIdx) this.selectFloor(p.fi);
    Editor.select(p.d.kindName || 'device', p.d.id);
    Editor.fit();
    this.setZoomFromPpm(Editor.ppm);
    this.viewDirty();   // 定位后取景变了，记一条视图快照（撤销能回到定位前）
  },
};
