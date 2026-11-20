/*
 * composables/useSceneRunner.js — 展示项执行状态机的 Vue 适配层（展示页使用）
 *
 * 只做三件事：给 model/sceneRunner.js 传 reactive 状态对象、注入 toast、暴露
 * 卸载时清理。执行语义 / 时序 / 文案全在纯模块里，可用假时钟单测。
 *
 * Options API 用法：
 *   setup() {
 *     const vm = getCurrentInstance().proxy;
 *     return useSceneRunner({ toast: (msg) => vm.toastMsg(msg) });
 *   }
 * 模板与 methods 里继续用 sceneBusy / sceneDone / runScene / checkSceneWatchers，
 * 页面卸载时调一次 disposeScenes()。
 */
import { reactive } from 'vue';
import { createSceneRunner } from '../model/sceneRunner.js';

export function useSceneRunner(opts = {}) {
  const state = reactive({ busy: {}, done: {} });
  const runner = createSceneRunner(Object.assign({}, opts, {
    state: { busy: state.busy, done: state.done },
    ha: opts.ha || (() => (typeof window !== 'undefined' ? window.HA : null)),
  }));
  return {
    sceneBusy: state.busy,
    sceneDone: state.done,
    runScene: runner.run,
    checkSceneWatchers: runner.check,
    disposeScenes: runner.dispose,
  };
}
