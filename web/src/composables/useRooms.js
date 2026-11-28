/*
 * composables/useRooms.js — 房间属性与排序（原 EditApp.vue 的房间方法组）
 *
 * 排序的顺序真相就是**数组顺序**：fl.rooms → 房间 tab、「全屋」卡片分组。
 * 消费端全部直接 v-for（PanelApp.vue / useCards.js），无需新增 order 字段
 * （roomOut 是白名单序列化，新字段会被静默丢弃）。
 * 设备顺序不在这里排（2026-11-14）：设备排序走 DevOrderPanel / reorderDevices
 * （见 composables/useDeviceOrder.js），顺序即卡片权重；RoomsPanel 里的设备列表只读展示。
 *
 * 两个关键约束（reorderRooms）：
 *  1) 必须**原地按索引覆写**，不能替换数组引用 —— Editor.floor = this.cur 持有
 *     旧数组，替换后 2D 绘制 / 拾取看到的还是旧顺序；
 *  2) 组件只产出「新的 id 顺序」，写入 / 撤销栈 / 重绘 / 保存在这里一次做完。
 */
export const roomMethods = {
  /* 房间属性（名称 / 地面颜色 / 温湿度实体绑定）。房间走 commit() 统一收口：重绘 2D
   * + 压一条撤销 + 触发保存；3D 模式下顺带 rebuild，让地面分区/标签跟着刷新。
   * 这些都是低频改动，不需要像拖拽那样做 160ms 防抖。
   * 温湿度实体：EntityInput 每次输入都 emit（边打边搜），这里统一去空格 + 限长；
   * 空串直接删字段，避免存档里留一堆空键。绑定变化要重建 3D 标签（rebuild 会 syncLabels）。 */
  setRoomProp(key, value) {
    const it = this.selItem;
    if (!it || !this.selection || this.selection.kind !== 'room') return;
    if (key === 'name') it.name = String(value == null ? '' : value).slice(0, 20) || '房间';
    else if (key === 'color') it.color = String(value || '');
    else if (key === 'tempEntity' || key === 'humidityEntity') {
      const eid = String(value == null ? '' : value).trim().slice(0, 160);
      if (eid) it[key] = eid;
      else delete it[key];
    } else return;
    this.commit();
  },
  reorderRooms(payload) {
    const fl = this.cur;
    const p = payload || {};
    if (!fl || !Array.isArray(p.ids)) return;
    if (!this._applyRoomOrder(fl, p.ids)) return;
    /* 一次 ↑↓ 点击 = 一条撤销：label 带本次顺序，避免 Recode 600ms 同 label 合并把
       连续几次排序吞成一步。changed() 顺带完成 2D 重绘 + 自动保存。 */
    const label = 'room-order:rooms:' + p.ids.join(',');
    Editor.changed(false, label);
    this.rebuild3D();   // 3D 模式下房间绘制层次 / 标签跟着换（2D 模式内部直接返回）
  },
  _applyRoomOrder(fl, ids) {
    const arr = fl.rooms || [];
    if (ids.length !== arr.length) return false;
    const byId = new Map(arr.map((r) => [r.id, r]));
    const next = ids.map((id) => byId.get(id));
    if (next.some((r) => !r) || new Set(next).size !== next.length) return false;
    if (next.every((r, i) => r === arr[i])) return false;   // 没变就不压撤销
    next.forEach((r, i) => { arr[i] = r; });
    return true;
  },
  /* 列表点房间名 → 走引擎的 select（经 window.App.setSelection 同步 Pinia + 画布高亮），
     不能直接写 store.selection，否则 2D/3D 的选中高亮不会跟着走 */
  selectRoom(id) {
    if (!id) return;
    Editor.select('room', id);
    Editor.render();
  },
};
