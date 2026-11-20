/*
 * services/apiAuth.js — 我方 API 的登录门禁守卫（横切关注点，与 HA 鉴权无关）
 *
 * 两套鉴权必须分清，别再混进 services/ha.js：
 *   · server/auth.js 的 session cookie = 「允不允许打开这个面板」，保护所有我方 /api/*
 *   · HA 的 access_token        = 「允不允许控制设备」，只在 ha.js 的 WebSocket 里用
 * 本文件只管前者：我方 API 未登录时服务端回 401 {needLogin:true}，这里统一跳登录页。
 *
 * 为什么用「全局 fetch 守卫」而不是逐个改调用点：
 *   /api/ 的 fetch 散落在 model/catalog.js、engine/plugins.js、editor 各弹窗、
 *   EditApp.vue、ha.js 的 loadConfig 等十几处。逐个包一层既啰嗦又容易漏，
 *   以后新增接口还会再漏。装一次守卫，现有和未来的调用点自动覆盖。
 *   engine/ 只画引擎、ha.js 只管 HA 协议，两边都不该知道「登录页」的存在。
 *
 * 只处理「401 + needLogin」，跳过 /api/auth/*（登录接口自身，否则会跳自己的死循环）。
 * 用 response.clone() 读 body，不影响调用方照常读原 response。
 * HA 的 WebSocket 不走 fetch，不受影响。离页保存（EditApp beforeunload）用
 * keepalive fetch，同样经过本守卫 —— sendBeacon 不过 fetch，拿不到 App token 注入。
 */
let installed = false;

function shouldGuard(url) {
  if (!url) return false;
  // 只拦同源相对路径 /api/；绝对 URL（HA 直连等）不看
  if (url.charAt(0) !== '/' || url.slice(0, 5) !== '/api/') return false;
  // 登录自身接口不拦：me / login / logout / qr* 等
  if (url.slice(0, 10) === '/api/auth/') return false;
  return true;
}

function goLogin() {
  if (window.__authRedirecting) return;
  window.__authRedirecting = true;
  var next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.replace('/login.html?next=' + next);
}

/* App 端 token 注入：App 壳把登录 token 存在原生层（不依赖 WebView cookie，
   因此内外网地址切换后仍可用），这里在每次我方 /api 请求上补 X-HA3D-Token。
   浏览器端没有 AppShell.getToken，返回空串、不注入，行为完全不变。 */
function appToken() {
  try {
    if (window.AppShell && typeof window.AppShell.getToken === 'function') {
      return window.AppShell.getToken() || '';
    }
  } catch (e) { /* 桥接异常就当没有，继续走 cookie */ }
  return '';
}

/* 给 fetch 的 init 补一个 header；兼容 init.headers 为数组 / 对象 / Headers 三种形态 */
function withTokenHeader(init, token) {
  var o = Object.assign({}, init || {});
  var h = o.headers;
  if (h && typeof h.append === 'function') {
    h.append('X-HA3D-Token', token);          // Headers 实例
  } else if (Array.isArray(h)) {
    h = h.concat([['X-HA3D-Token', token]]);  // [['k','v'],...]
  } else {
    h = Object.assign({}, h || {});           // 普通对象
    h['X-HA3D-Token'] = token;
  }
  o.headers = h;
  return o;
}

export function installApiAuthGuard() {
  if (installed || typeof window === 'undefined' || !window.fetch) return;
  installed = true;
  var rawFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    /* 我方非登录接口 + App 端有原生 token：补 header（document 导航不受 fetch 控制，
       那部分靠 App 预置 cookie 兜底，见 App 端 seedAuthCookie）。 */
    if (shouldGuard(url)) {
      var t = appToken();
      if (t) init = withTokenHeader(init, t);
    }
    return rawFetch(input, init).then(function (res) {
      if (res && res.status === 401 && shouldGuard(url)) {
        try {
          res.clone().json().then(function (j) {
            if (j && j.needLogin === true) goLogin();
          }).catch(function () { /* 不是预期 JSON 就不拦，交给调用方 */ });
        } catch (e) { /* 读不到 body 也不拦 */ }
      }
      return res;
    });
  };
}
