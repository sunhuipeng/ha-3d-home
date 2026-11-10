/*
 * recode.js — 快照式撤销/重做（历史栈模块；命名为 Recode 以避开浏览器内置的 History API）
 *
 * 原理: 每次数据改动后把整个 project 深拷贝压栈（项目数据仅几 KB，快照成本可忽略），
 *       undo/redo 就是把栈里相邻的快照换回来。相比命令式（每个操作记反向操作），
 *       快照式对「改动点散布在编辑器/面板/设置各处」的架构零侵入、不会漏。
 *
 * 连续变更合并: 拖拽时 onMove 每移动 1cm 就 dirty 一次、滑杆每个 input tick 一次——
 *       MERGE_MS 时间窗内相同 label 的连续改动合并为一步（丢弃中间态），
 *       所以拖一次家具 = 一步撤销，而不是几十步。
 *
 * 快照附带 floorIdx: undo 时跳回当时编辑的楼层，避免「撤销了 A 层的墙但人还在 B 层」。
 *
 * 快照附带 view {ox, oy, ppm}: 当时 2D 画布的平移/缩放。恢复时一并还原，
 *       否则 undo 会重新 fit() 一次，画面整体位置/比例突变（看起来像「跳了一下」）。
 *
 * 视图也进栈（pushView）: 光记录「改动那一刻的视图」还不够 —— 用户先平移、再改东西时，
 *       上一条快照的视图还停在下平移之前的位置，undo 回去照样跳。所以平移/缩放本身也压栈，
 *       成为一步（label='view'）。这样 undo 一次只回退一步，视图与数据始终同步回退。
 *       连续平移/缩放合并为同一条（项目数据没变，只刷新它的 view），不会把栈塞满。
 */

export const Recode = {
  MAX: 100,          // 栈深上限（超出丢最旧）
  MERGE_MS: 600,     // 同 label 连续改动合并的时间窗

  stack: [],         // [{ project(深拷贝), floorIdx, view, label, t }]
  idx: 0,            // 当前状态在栈中的位置
  restoring: false,  // 恢复快照期间置 true：期间的 dirty 不再进栈（防 undo 自身入栈、清空 redo 分支）

  /* 载入项目时初始化: 清栈并压入初始状态（作为第一步 undo 的落点） */
  init(project, floorIdx, view) {
    this.stack = [this._snap(project, floorIdx, 'init', 0, view)];
    this.idx = 0;
    this._lastLabel = '';
    this._lastT = 0;
  },

  /* 改动后调用。label 标识改动来源（drag/wall/del/edit…），同 label 且在时间窗内 → 合并 */
  push(project, floorIdx, label, view) {
    if (this.restoring || !project || !project.floors || !project.floors.length) return false;
    const now = Date.now();
    const snap = this._snap(project, floorIdx, label, now, view);
    /* 合并: 替换栈顶（当前态）为最新状态，中间态丢弃；idx===0 是初始态，永不合并 */
    if (label && label === this._lastLabel && this.idx > 0 && now - this._lastT < this.MERGE_MS) {
      this.stack[this.idx] = snap;
    } else {
      this.stack.length = this.idx + 1;   // 从当前位置分叉 = 丢弃 redo 分支
      this.stack.push(snap);
      if (this.stack.length > this.MAX) this.stack.splice(0, this.stack.length - this.MAX);
      this.idx = this.stack.length - 1;
    }
    this._lastLabel = label;
    this._lastT = now;
    return true;
  },

  /* 纯视图改动（平移/缩放）压栈: 项目数据沿用当前态（不重复深拷贝），只更新栈顶的 view。
   * 连续多次平移/缩放 → 合并成一条，undo 一步回到这轮视图操作之前。 */
  pushView(project, floorIdx, view) {
    if (this.restoring || !view || !project || !project.floors || !project.floors.length) return false;
    const top = this.stack[this.idx];
    if (top && top.label === 'view') {
      this.stack.length = this.idx + 1;   // 视图操作也算新改动 → 丢弃 redo 分支
      top.view = { ox: view.ox, oy: view.oy, ppm: view.ppm };
      this._lastLabel = 'view';
      this._lastT = Date.now();
      return true;
    }
    return this.push(project, floorIdx, 'view', view);
  },

  /* 返回 { project(新深拷贝), floorIdx, view, undone } 或 null。恢复方负责换数据 + 联动刷新。
   * undone = 被撤销/重做的那一步的 label（栈顶那条），供 UI 提示用 */
  undo() {
    if (this.idx <= 0) return null;
    this._lastLabel = '';   // 断开合并链，下一次改动重新起一步
    const undone = this.stack[this.idx].label;
    const s = this.stack[--this.idx];
    return { project: JSON.parse(JSON.stringify(s.project)), floorIdx: s.floorIdx, view: s.view ? { ...s.view } : null, undone };
  },

  redo() {
    if (this.idx >= this.stack.length - 1) return null;
    this._lastLabel = '';
    const s = this.stack[++this.idx];
    return { project: JSON.parse(JSON.stringify(s.project)), floorIdx: s.floorIdx, view: s.view ? { ...s.view } : null, undone: s.label };
  },

  canUndo() { return this.idx > 0; },
  canRedo() { return this.idx < this.stack.length - 1; },

  /* 补记初始快照的视图：载入项目时 2D 画布还没 init（view 拿不到），
   * App 在 Editor.init + fit 之后再调一次，保证「撤销回到最初」也不跳视图 */
  setBaseView(view) {
    if (!view || !this.stack.length) return;
    this.stack[0].view = { ox: view.ox, oy: view.oy, ppm: view.ppm };
  },

  _snap(project, floorIdx, label, t, view) {
    return {
      project: JSON.parse(JSON.stringify(project)),
      floorIdx: floorIdx || 0,
      view: view ? { ox: view.ox, oy: view.oy, ppm: view.ppm } : null,
      label, t,
    };
  },
};
