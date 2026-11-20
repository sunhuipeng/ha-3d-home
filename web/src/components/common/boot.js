/**
 * 启动遮罩移除逻辑，与同目录的 BootOverlay.vue 配套。
 * 编辑页 / 大屏页原本各写了一份 bootDone() 与 12s 兜底计时器，统一收敛到这里。
 * 用普通函数而非 composable：两个页面都是 Options API，只需显式调用，不参与响应式。
 */

/** 淡出并移除 #boot；重复调用安全（节点已移除时直接返回） */
export function bootDone() {
  const b = document.getElementById('boot');
  if (!b) return;
  b.style.opacity = '0';
  b.style.pointerEvents = 'none';
  setTimeout(() => { b.remove(); }, 260);
}

/** 12s 兜底：init() 异常没走到 bootDone() 时强制移除，避免卡死在加载界面 */
export function armBootFallback(delay = 12000) {
  setTimeout(bootDone, delay);
}
