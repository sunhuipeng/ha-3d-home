/*
 * composables/useEditorKeys.js — 编辑页全局键盘绑定（原 EditApp.vue 的 bindKeys）
 *
 * 同 useNumEditing 的口径：导出方法组对象，根组件摊进 methods。keydown 分支
 * 依赖 this.dialogOpen / this.setTool / this.undo / this.redo / this.setMode
 * 等组件方法与 store 映射属性，`this` 绑定到组件实例后语义不变。
 *
 * 键位分层（从上到下优先级递减）：
 *   Esc 关弹窗 → 输入框守卫 → Ctrl+Z/Y 撤销重做 → 顶栏键 → 工具键 → Delete → Esc 画布分支
 */
export const editorKeysMethods = {
  bindKeys() {
    /* 审计 3.7 / 4-应用.4：句柄存实例，unbindKeys() 与之成对（此前匿名注册永不移除） */
    this._keyHandler = (e) => {
      /* Esc 关弹窗优先于一切（连接 / 导入 / 展示项 / 重置确认，后开的先关）：
       * 必须放在输入框守卫**前面** —— 弹窗表单里正聚焦输入框时也要能 Esc 关闭。
       * 没有弹窗时才落到下面的画布分支（取消绘制 + 收浮层 + 清选中）。 */
      if (e.key === 'Escape' && this.dialogOpen) {
        if (this.resetOpen) this.closeFlyout('reset');
        else if (this.importOpen) this.closeFlyout('import');
        else if (this.connOpen) this.closeFlyout('conn');
        else this.closeFlyout('disp');
        return;
      }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      const map = { v: 'select', h: 'pan', r: 'room', w: 'wall', d: 'door', n: 'window', f: 'furniture', e: 'device', t: 'measure', b: 'bg', g: 'backdrop' };
      const k = e.key.toLowerCase();
      /* 撤销/重做: Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z（或 Ctrl+Y）；输入框聚焦时 bindKeys 顶部已跳过 */
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
      /* 顶栏按钮快捷键（与 TopBar 里的 <i class="tb-kbd"> 角标、title 提示一一对应）：
       *   2 / 3 = 2D 编辑 / 3D 展示、L = 标签、K = 卡片、
       *   M = 重置锚点、C = 连接、I = 导入插件/包。
       * 全部要求不带修饰键（Ctrl+C 复制 / Ctrl+I / Ctrl+L 等一律放行）；
       * 有弹窗时不抢键，也不和左侧工具键（v/h/r/w/d/n/f/e/b/g）重叠。 */
      if (!mod && !this.dialogOpen) {
        if (k === '2' && this.mode !== '2d') { this.setMode('2d'); return; }
        if (k === '3' && this.mode !== '3d') { this.setMode('3d'); return; }
        const top = { l: 'toggleLabels', k: 'toggleCards', m: 'resetAnchor', c: 'openConn', i: 'openImport' };
        if (top[k]) { this[top[k]](); return; }
      }
      /* 必须排除 mod：否则 Ctrl+R（刷新）/ Ctrl+F（页内查找）会顺手切掉工具。
       * 必须排除弹窗：弹窗开着时按 v/h/r/w/d… 会在背后切工具，
       * 按 Delete/Backspace 会删掉选中对象并压撤销栈（与顶栏键分支同口径）。 */
      if (map[k] && !mod && !this.dialogOpen && this.mode === '2d') this.setTool(map[k]);
      if (!this.dialogOpen && (e.key === 'Delete' || e.key === 'Backspace') && this.mode === '2d') {
        /* 画房间过程中 Backspace = 撤掉最后一个顶点（Delete 仍只删选中对象）：
         * 点错一个角不用整间房重画 */
        if (e.key === 'Backspace' && Editor.roomPts && Editor.roomPts.length) {
          Editor.roomPts.pop();
          if (!Editor.roomPts.length) Editor.roomPts = null;
          Editor.render();
          return;
        }
        Editor.deleteSelection();
      }
      /* Esc 统一收起: 取消绘制 + 收浮层 + 清选中 → 右侧无论从属性面板还是背景面板进来，
       * 都回到「楼层设置」；'none' 是故意不存在的工具值 —— 不点亮任何左侧按钮
       * （落到 editor 的 select default 分支，画布点击选中仍可用），也不默认切回「选择」。
       * 房间：Esc = 落定当前多边形（>=3 点）+ 退出工具，所以 commitRoom() 必须在清空前调，
       * 否则这一笔直接丢（commitRoom 内部已 render，并压一条撤销）。 */
        if (e.key === 'Escape') {
          Editor.commitRoom();
          /* 标线清理由 engine/editor.js 的模块级 keydown 自清（先于本处理器注册执行；
           * 审计 2.12：同职责此前双路径，这里不再重复调一次） */
          Editor.wallStart = null; Editor.ghost = null; Editor.select(null); Editor.render(); this.setTool('none', true);
        }
    };
    window.addEventListener('keydown', this._keyHandler);
  },
  /* 与 bindKeys() 成对的移除出口（EditApp.beforeUnmount 调用） */
  unbindKeys() {
    if (this._keyHandler) {
      window.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }
  },
};
