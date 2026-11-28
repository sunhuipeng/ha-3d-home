/*
 * composables/useNumEditing.js — 属性编辑家族（原 EditApp.vue 的「属性编辑」方法组）
 *
 * 为什么是「方法组对象」而不是 setup() 式 composable：
 *   EditApp 仍是 Options API，这批方法互相调用（wheelStep → applyNum → commit）并
 *   重度依赖组件上下文（this.selItem / this.mode / this.commit / this.toast）。
 *   导出普通方法对象、由根组件 `...numEditingMethods` 摊进 methods：Vue 会把每个
 *   method 绑定到组件实例，`this` 语义与原地内联完全一致 —— 行为零变化，纯搬运。
 *
 * 覆盖：setProp（统一入口）+ 数值底座（applyNum / wheelStep）+ 设备/门窗/家具
 * 数值包装 + 标签抬升高度家族。labelOffset 的两个 computed 逐字重复的问题
 * （审计 2.13）用下面的纯函数 labelOffsetDefaultOf / labelOffsetValOf 消掉：
 * EditApp 与 SelectionInspector 两处 computed 都改为调用同一份实现。
 */

import { devTypeOf } from '../model/catalog.js';

/* 「纯位姿」字段：3D 里改这些只需要挪一下 group，不必整树重建（见 setProp / View3D.moveItem）。
 * 不含 w/d/h 等几何尺寸（那是模型/目录形态，必须重建）。 */
export const POSE_KEYS = ['x', 'y', 'z', 'rot', 'pct'];

/* 标签抬升高度的造型默认值（styles[].labelOffset，缺省 0.3m）。
 * it = 选中项，kind = selection.kind。纯函数，无组件依赖，两页面共用。 */
export function labelOffsetDefaultOf(it, kind) {
  if (!it) return 0.3;
  if (kind !== 'device' && kind !== 'door' && kind !== 'window') return 0.3;
  const type = kind === 'device' ? devTypeOf(it) : kind;
  return (typeof window !== 'undefined' && window.PluginEngine)
    ? window.PluginEngine.labelOffset(type, it.style)
    : 0.3;
}

/* 面板显示值：实例覆盖 obj.labelOffset 优先，没设过就显示造型默认值 */
export function labelOffsetValOf(it, def) {
  return it && it.labelOffset != null ? it.labelOffset : def;
}

export const numEditingMethods = {
  /* 属性编辑统一走 setProp()；engine 侧的选中态同步由 window.App.setSelection
   * （bridge.js → editor store 的 setSelection Action）完成。 */
  setProp(key, value, type) {
    const it = this.selItem;
    if (!it) return;
    let v = parseFloat(value);
    if (type === 'str') {
      const s = (value || '').trim();
      if (s) it[key] = s; else delete it[key];   // 清空 = 解绑，不留空串（插件侧统一按 falsy 判未绑定）
    }
    else { if (isNaN(v)) return; it[key] = type === 'deg' ? v * Math.PI / 180 : v; }
    /* 位姿类字段（位置 / 离地 / 旋转 / 比例）：3D 里只有这一件事变了，就地改变换即可。
     * 之前走 commit({rebuild:true}) → 整树重建（dispose 全屋材质 + 插件 reset +
     * 标签 DOM 全删建），改一个数字就掉帧，还会因重建回中让视角跳。
     * moveItem 只对「已登记的自由摆放实例」成功；门窗（跟墙洞口）与墙/房间等
     * 结构件返回 false，自动回退到全量重建。 */
    const pose = type !== 'str' && POSE_KEYS.indexOf(key) >= 0;
    const moved = pose && this.mode === '3d' ? View3D.moveItem(it) : false;
    const isStr = type === 'str';   // 实体绑定 / 名称等字符串字段：不重建，但要让插件与标签即时响应
    this.commit({
      rebuild: !isStr && !moved,     // 就地变换成功 → 不必重建
      updateAll: isStr || !moved,    // 位置变化不涉及实体状态，省掉一次全插件推送
      syncLabels: isStr || !moved,   // 标签每帧按实例坐标投影，位置变化自己跟着走
    });
  },
  deg(rad) { return Math.round((rad || 0) * 180 / Math.PI); },

  /* ------- 数值编辑（设备/门窗/家具共用底座） -------
   * applyNum: 解析 + 可选角度换算/夹取 + commit（原 setDevNum/setOpenNum/setFurnNum 三胞胎收敛于此）
   * wheelStep: 滚轮步进（deltaY 向上 = 增）后走 applyNum（原 wheelNum/wheelOpen/wheelFurn 收敛于此）
   * opts: { deg: 按°输入换算弧度, min/max: 夹取, int: 取整, redraw2d: 是否重绘 2D } */
  applyNum(key, value, opts) {
    const it = this.selItem;
    if (!it) return;
    const o = opts || {};
    const v = parseFloat(value);
    if (isNaN(v)) return;
    let n = o.deg ? v * Math.PI / 180 : v;
    if (o.int) n = Math.round(n);
    if (o.min != null) n = Math.max(o.min, n);
    if (o.max != null) n = Math.min(o.max, n);
    it[key] = n;
    /* 与 setProp 同一策略：位姿字段就地改变换，其余（尺寸 w/d/h 等）仍整树重建。
     * 滚轮调 x/y/rot/pct（含拖动滑条）此前每一格都重建全屋，明显掉帧。 */
    const moved = POSE_KEYS.indexOf(key) >= 0 && this.mode === '3d' ? View3D.moveItem(it) : false;
    this.commit({ redraw2d: o.redraw2d !== false, rebuild: !moved });
  },
  wheelStep(key, e, step, opts) {
    const it = this.selItem;
    if (!it) return;
    const o = opts || {};
    const cur = o.deg ? this.deg(it[key]) : (parseFloat(it[key]) || 0);
    let v = cur + (e.deltaY < 0 ? step : -step);
    if (!o.deg) v = Math.round(v * 1000) / 1000;   // 浮点步进不留 0.30000000000000004 这类尾巴
    this.applyNum(key, String(v), o);
  },
  /* 设备数值: x/y/rot 重绘 2D（redraw2d=true），z 不重绘（贴地属性由 3D 决定） */
  setDevNum(key, value, redraw2d) {
    this.applyNum(key, value, { min: key === 'z' ? 0 : null, redraw2d: !!redraw2d });
  },
  wheelNum(key, e, step, redraw2d, min, max) {
    this.wheelStep(key, e, step, {
      redraw2d: !!redraw2d,
      min: min != null ? min : (key === 'z' ? 0 : null),
      max: max != null ? max : null,
    });
  },
  /* 标签抬升高度（m）: 实例覆盖造型声明值，只动 HTML 标签位置、不重建 3D ——
   * View3D.updateLabels 每帧读 obj.labelOffset，改完下一帧就到位。
   * 拖滑条时 200ms 防抖再 dirty（快照/自动保存），避免每一档都压一条撤销栈 */
  setDevLabelOffset(value) {
    const it = this.selItem;
    if (!it) return;
    if (String(value).trim() === '') return;                // 正在清空：等 @change 再决定
    const v = parseFloat(value);
    if (isNaN(v)) return;
    it.labelOffset = Math.round(Math.max(-1, Math.min(6, v)) * 100) / 100;
    clearTimeout(this._labelOffTimer);
    this._labelOffTimer = setTimeout(() => this.dirty(), 200);
  },
  /* 输入框失焦/回车：清空 = 删掉实例覆盖，回到造型声明的 labelOffset */
  commitDevLabelOffset(value) {
    if (String(value).trim() === '') this.clearDevLabelOffset();
    else this.setDevLabelOffset(value);
  },
  clearDevLabelOffset() {
    const it = this.selItem;
    if (!it || it.labelOffset == null) return;
    delete it.labelOffset;
    clearTimeout(this._labelOffTimer);
    this._labelOffTimer = setTimeout(() => this.dirty(), 200);
  },
  wheelDevLabelOffset(e, step) {
    const cur = parseFloat(this.labelOffsetVal) || 0;
    this.setDevLabelOffset(cur + (e.deltaY < 0 ? step : -step));
  },
  /* 门窗数值: 宽度（最小 0.05m）/角度，实时刷新 2D + 3D */
  setOpenNum(key, value, type) {
    this.applyNum(key, value, { deg: type === 'deg', min: type === 'deg' ? null : 0.05 });
  },
  /* 窗离地高度: 0 起步（门恒 0 不可调，面板不渲染输入框） */
  setOpenZ(value) { this.applyNum('z', value, { min: 0 }); },
  wheelOpenZ(e, step) { this.wheelStep('z', e, step, { min: 0 }); },
  wheelOpen(key, e, step, type) {
    this.wheelStep(key, e, step, { deg: type === 'deg', min: type === 'deg' ? null : 0.05 });
  },
  /* 家具数值: 旋转/位置/离地高度/整体比例（20–300 取整），实时刷新 2D + 3D */
  setFurnNum(key, value, type) {
    this.applyNum(key, value, {
      deg: type === 'deg',
      min: key === 'z' ? 0 : (key === 'pct' ? 20 : null),
      max: key === 'pct' ? 300 : null,
      int: key === 'pct',
    });
  },
  wheelFurn(key, e, step) {
    if (key === 'rot') return this.wheelStep(key, e, step, { deg: true });
    this.wheelStep(key, e, step, {
      min: key === 'z' ? 0 : (key === 'pct' ? 20 : null),
      max: key === 'pct' ? 300 : null,
      int: key === 'pct',
    });
  },
};
