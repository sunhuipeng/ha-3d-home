<template>
  <!-- 启动遮罩：Vue 挂载后、项目数据就绪前覆盖界面，由 boot.js 的 bootDone() 淡出移除。
       根节点仍是 #boot（组件不产生额外 wrapper），两页共用同一份 DOM 与样式。 -->
  <div id="boot">
    <div class="b-logo">🏠</div>
    <div class="b-name">HA 3D Home</div>
    <div class="b-spin"></div>
    <div class="b-tip">正在加载，请稍候…</div>
  </div>
</template>

<script>
export default { name: 'BootOverlay' };
</script>

<style>
/* 刻意不加 scoped：样式靠 #boot / .b-* 全局选择器命中，scoped 会改写选择器导致失效。
   遮罩样式不依赖外部资源，随组件一起打包，两页各 import 时共享同一份。 */
#boot { position: fixed; inset: 0; z-index: 9999; background: #f4f6fa; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; transition: opacity .25s; font-family: system-ui, sans-serif; }
#boot .b-logo { font-size: 46px; filter: drop-shadow(0 4px 10px rgba(60,80,120,.18)); }
#boot .b-name { font-size: 17px; font-weight: 700; color: #1f2733; letter-spacing: 1px; }
#boot .b-spin { width: 30px; height: 30px; border: 3px solid #d7deea; border-top-color: #3b82f6; border-radius: 50%; animation: b-rot .8s linear infinite; }
#boot .b-tip { font-size: 12px; color: #8a94a6; }
@keyframes b-rot { to { transform: rotate(360deg); } }
</style>
