/*
 * useSceneMode.js — 3D 场景模式装配共享底座（审计 2.17）
 *
 * EditApp 与 PanelApp 的四段同源装配此前各自手抄并已漂移（PanelApp 的
 * onHAChange 少了 try/catch、标签开关的「持久化/重拨」顺序两边不一致）：
 *   1. toggleLabelsCore   标签开关骨架：翻转 → 持久化 → 重拨场景模式 → 提示
 *   2. applySceneCore     标签显隐 ⇔ 点击语义 + 选中环（model/pick.js 唯一实现）
 *   3. pickHi             选中变化 → 3D 高亮（两页 watch 的同一入口）
 *   4. refresh3dQuiet     HA 变更后的静默重绘（引擎未就绪不冒泡）
 * 导出「方法组对象」：根组件 ...spread 摊进 methods，Vue 把每个 method 绑定到
 * 组件实例，this 语义与原地内联一致 —— 纯搬运零行为变化。
 * 页面差异只保留三处入参：偏好键（编辑/展示页独立）、labels 判定、提示文案。
 */
import { applySceneMode as syncSceneMode, applyPickHi } from '../model/pick';
import { prefSetBool } from '../services/prefs';

export const useSceneMode = {
  methods: {
    /* 1. 标签开关骨架。apply / notify 由页面注入（各页的 labels 判定与文案不同）；
     * notify 里读 this.showLabels 时已完成翻转。持久化统一在重拨之前。 */
    toggleLabelsCore(prefKey, apply, notify) {
      this.showLabels = !this.showLabels;
      prefSetBool(prefKey, this.showLabels);
      apply();
      notify();
    },

    /* 2. 场景模式装配核心：拨 3D 点击语义（syncSceneMode 一次写完点击接管与
     * 标签显隐），再按 labels 决定选中环去留 —— 没有点选出卡，场景里不该留环。
     * selection 由页面按自身语义传：编辑页 labels ? this.selection : null，
     * 展示页传 this.sel（与各自 watch 的高亮口径一致，幂等重放无副作用）。 */
    applySceneCore(labels, selection) {
      if (!View3D || !View3D.init) return;
      syncSceneMode(View3D, labels, (hit) => this.onPick3D(hit));
      applyPickHi(View3D, selection, labels);
    },

    /* 3. 选中 → 3D 高亮：房间地面提亮 + 描边 / 设备脚下圆环，非 3D 或无选中清空 */
    pickHi(v, labels) { applyPickHi(View3D, v, labels); },

    /* 4. HA 变更后的静默重绘：引擎段若初始化失败，连接仍会建立（含演示模式的
     * 同步首帧推送），此时渲染调用不能打断状态回调 —— 只更新数据，等切视图再重绘。 */
    refresh3dQuiet(fn) {
      try { fn(); } catch (e) { /* 引擎尚未就绪 */ }
    },
  },
};
