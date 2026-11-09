/*
 * 应用版本号：从 /api/version 读取，服务端实时读根目录 package.json 的 version。
 *
 * 页面上只留一个带 data-app-version 的空占位；升版本（含 push:image 自动升版）后
 * 刷新页面即更新，前端不用维护任何版本号字面量。
 * 取不到就保持隐藏 —— 版本号只是装饰，不能因为它让页面报错。
 *
 * 两个页面的占位位置不同：编辑页（index.html）在页面左下角、Vue 挂载容器之外，
 * 是静态节点；大屏页（display.html）在标题里，项目异步加载后才渲染。
 * 因此 fetch 成功后先扫一遍：首轮填到节点（编辑页的静态占位）就直接结束，
 * 不创建观察器；一个都没填到，说明是大屏页那种由 Vue 异步渲染的标题，
 * 才挂 MutationObserver，补填完立即 disconnect（填充时会移除 data-app-version
 * 标记，不会形成回环）。8 秒只作节点始终不出现时的兜底，不再常驻扫描。
 *
 * 刻意不带 ?v= 缓存版本号：走 ETag 协商，本文件将来改动也能自动生效。
 */
'use strict';
(function () {
  var version = '', appName = 'HA 3D Home';

  function pending() { return document.querySelector('[data-app-version]'); }
  function scan() {
    var nodes = document.querySelectorAll('[data-app-version]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      el.textContent = 'v' + version;
      el.title = appName + ' ' + version;
      el.hidden = false;
      el.removeAttribute('data-app-version');   // 已填充：不再匹配，也就不触发回环
    }
    return nodes.length;                        // 本次填了几个（0 = 节点会延迟出现）
  }

  fetch('/api/version', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.version) return;
      version = String(d.version);
      if (d.name) appName = String(d.name);
      var filled = scan();
      /* 只有「首轮一个占位都没填到」才需要等异步节点。不能用 pending() 判断：
       * 大屏页标题尚未渲染时它同样返回 null，会把观察器一起跳过，版本号永远不显示。 */
      if (typeof MutationObserver === 'function' && filled === 0) {
        var mo = new MutationObserver(function () {
          scan();
          if (!pending()) mo.disconnect();       // 占位填满即断开，不常驻
        });
        mo.observe(document.body, { childList: true, subtree: true });
        setTimeout(function () { mo.disconnect(); }, 8000);   // 节点始终没出现的兜底
      }
    })
    .catch(function () { /* 静默降级：保持隐藏 */ });
})();
