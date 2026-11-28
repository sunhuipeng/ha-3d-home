/*
 * composables/useFloors.js — 楼层方法组（原 EditApp.vue 的「楼层」职责）
 *
 * 与 useNumEditing（EditApp 拆分）同一口径：导出方法组对象，根组件
 * `...floorMethods` 摊进 methods，Vue 把每个 method 绑定到组件实例，`this`
 * 语义与原地内联完全一致 —— 纯搬运零行为变化。
 * 依赖的组件上下文：this.cur / this.floorIdx / this.project（editor store 映射）、
 * this.syncBg（useRefImage 方法组）、this.updateHouseSize（根组件：撤销路径也用）、
 * this.commit / this.dirty / this.viewDirty / this.toast / this.closeFlyout。
 *
 * 覆盖：切层联动（setFloor / selectFloor）→ 增删复制（addFloor / copyFloor /
 * delFloor）→ 楼层属性（setFloorName / setWallOpacity / setFloorHeight）→
 * 重置本层（confirmResetFloor，确认弹窗交互在 ResetModal）。
 * openResetFloor（浮层开关）与 setProjectName（项目级）留在根组件。
 */
import { FLOOR_LIST_KEYS, DEFAULT_FLOOR_H, newFloor, cloneFloor } from '../model/catalog.js';

export const floorMethods = {
  /* fit=false: 只重指向楼层 + 联动刷新，不用重新适配视野（撤销恢复走这条路，避免画面跳动） */
  setFloor(fit) {
    Editor.floor = this.cur;
    Editor.roomPts = null;   // 切层丢弃未落定的房间：那一串点属于上一层的坐标系
    Editor.clearMeasures();  // 标线同理：坐标是某一层的，换层就整批清掉（不落盘、不压撤销）
    if (fit === false) Editor.render(); else Editor.fit();
    this.setZoomFromPpm(Editor.ppm);
    this.syncBg();
    this.updateHouseSize();
  },
  /* noView=true: 不记录切层这个「视图动作」（新建/删除楼层自己会压一条数据快照，
   * 再插一条视图快照会让撤销要按两次） */
  selectFloor(i, noView) {
    this.floorIdx = i;
    Editor.select(null);   // 切层清选中（App 与 Editor 两边由 select 内部同步）
    this.setFloor();
    if (!noView) this.viewDirty();   // 切层 = fit 重新取景，算一次视图变化（撤销能回到原来那层的取景）
    /* 切层必须让 3D 场景（含背景插件构图）一起换层：背景 group 是按当前楼层的
     * 房屋包围盒摆位的，只在 3D 模式 rebuild 会让「2D 下切层」时背景停留在上一层
     * 的落点，之后切回 3D 前房屋与平台就是错开的。切层是低频操作，隐藏容器里
     * 多建一次 3D 模型可以接受；进 3D 时 setMode 会再 resize + rebuild 一次。 */
    View3D.rebuild(this.project, i);
  },
  addFloor() {
    this.project.floors.push(newFloor((this.project.floors.length + 1) + '层'));
    this.selectFloor(this.project.floors.length - 1, true);
    this.dirty();
  },
  /* 复制本层：墙体/房间/门窗/家具/设备/展示配置全量深拷贝（元素换新 id、房间引用
     与展示项 eid 按映射改写，HA 实体绑定原样保留），插入到本层之后并切过去 */
  copyFloor() {
    const src = this.cur;
    if (!src) return;
    const fl = cloneFloor(src, (src.name || '层') + ' 副本');
    this.project.floors.splice(this.floorIdx + 1, 0, fl);
    this.selectFloor(this.floorIdx + 1, true);
    this.dirty();
  },
  delFloor() {
    if (this.project.floors.length <= 1) return;
    this.project.floors.splice(this.floorIdx, 1);
    this.selectFloor(0, true);
    this.dirty();
  },
  /* 楼层改名：与项目名同一条链路 —— 直写响应式对象后 dirty()（落盘 + 压撤销栈）。
     之前模板里 cur.name 直写绕过了 dirty()，刷新即丢、Ctrl+Z 无效。 */
  setFloorName(v) {
    const fl = this.cur;
    if (!fl) return;
    fl.name = String(v).trim() || '楼层';
    this.dirty();
  },

  /* 墙面不透明度(%)：按楼层记忆，拖动实时刷新 3D */
  setWallOpacity(v) {
    const fl = this.cur;
    if (!fl) return;
    if (isNaN(v)) return;
    fl.wallOpacity = Math.min(100, Math.max(0, Math.round(v)));
    this.commit();
  },

  /* 层高(m)：实时预览。input（打字/点步进箭头）防抖 120ms 后重建 3D，change（失焦/回车）
   * 立即收口并钳制到 2~6。打字途中不钳制——0.5 会被 2~6 夹成 2 反写回输入框，打断输入。
   * 2D 平面不画层高，redraw2d 省掉；高度只影响 3D，由 commit 的 rebuild3D 刷新（wallH 在
   * View3D.build 里读 fl.height）。 */
  setFloorHeight(v, phase) {
    const fl = this.cur;
    if (!fl) return;
    const h = parseFloat(v);
    if (isNaN(h)) {
      if (phase === 'change') { fl.height = DEFAULT_FLOOR_H; this.commit({ redraw2d: false }); }   // 清空/乱输，失焦兜底回默认
      return;   // 输入中途（如「3.」）不更新，等下一个字符或失焦
    }
    clearTimeout(this._fhTimer);
    if (phase === 'change') {
      fl.height = Math.min(6, Math.max(2, h));
      this.commit({ redraw2d: false });
      return;
    }
    fl.height = h;
    this._fhTimer = setTimeout(() => this.commit({ redraw2d: false }), 120);
  },

  /* 重置当前楼层（「输入确认」的校验随输入框一起收进 ResetModal，
   * 按钮 disabled + Enter 都要过 ok；这里只负责真正清空楼层、清选中、压栈与提示） */
  confirmResetFloor() {
    if (!this.cur) return;
    const fl = this.cur;
    FLOOR_LIST_KEYS.forEach((k) => { fl[k] = []; });
    Editor.select(null);   // 清选中（App 与 Editor 两边同步）
    Editor.wallStart = null;
    Editor.ghost = null;
    this.closeFlyout('reset');
    this.commit();
    this.toast('已重置「' + fl.name + '」（自动保存）');
  },
};
