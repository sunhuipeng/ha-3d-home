/*
 * login.js — 登录页交互（Vite 入口，唯一使用者：login.html）
 *
 * 从原 public/login.html 的内联脚本搬出，改成 Vite 模块，好处：
 *   1) TV 焦点导航直接 import engine/tvFocus.js，与大屏页同源，不再内联两份副本；
 *   2) 样式抽到 login.css，HTML 只剩骨架。
 * TV 导航的接口（window.__tvFocus.key）由 tvFocus.js 的 initTvFocus() 挂出，
 * App 遥控键经 Shell.dispatchTvKey → evaluateJavascript 调用，无需本文件参与。
 */
import './login.css';
import { initTvFocus } from './engine/tvFocus';
import { PREF_KEYS, prefBool } from './services/prefs';

/* 主题跟随大屏展示页：读同一个偏好键 ha3d.nightMode（prefs.js 唯一入口），首帧写入
 * <html data-theme="dark">，与 main-index.js 的防闪写法一致。登录页是大屏之外独立文档，
 * 只在此刻读一次偏好；之后用户在展示页切主题不影响本页（登录成功即跳走，无需实时联动）。 */
if (prefBool(PREF_KEYS.nightMode, false)) document.documentElement.setAttribute('data-theme', 'dark');

(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* 扫码语义（2026-11-19 定稿）：本页是「待登录方」，账号密码 / 展示二维码两条路。
     App 是「已登录的授权方」——在 App 应用内设置页点「扫码授权登录」，扫本页的码后
     用自己的 token 调 qr-approve 批准，本页轮询到 approved 即自动 qr-login。
     本页的登录表单里不提供「打开相机扫码」按钮（待登录方扫不了自己的码）。
     原生侧 scanLogin / processScanPayload 桥现由设置页授权按钮触发。 */

  /* next 只允许站内相对路径，挡掉 //evil.com 与 javascript: 等开放重定向 */
  function safeNext() {
    var n = new URLSearchParams(location.search).get('next') || '/';
    return (n.charAt(0) === '/' && n.charAt(1) !== '/') ? n : '/';
  }
  function goHome() { location.replace(safeNext()); }
  function api(path, opts) {
    return fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}))
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, body: j }; }); });
  }

  /* App 端：把登录接口返回的 token 交给原生存放，跨内外网地址复用。
     浏览器端没有 AppShell.saveToken，自动跳过，仍靠 cookie 保持登录。 */
  function keepTokenInApp(body) {
    if (body && body.token && window.AppShell && typeof window.AppShell.saveToken === 'function') {
      try { window.AppShell.saveToken(body.token); } catch (e) { /* 原生桥异常不影响本次登录 */ }
    }
  }

  var code = new URLSearchParams(location.search).get('code') || '';

  api('/api/auth/me').then(function (res) {
    /* 未启用认证（内网默认）：直接放行，不打扰 */
    if (!res.body.enabled || res.body.authenticated) { goHome(); return; }

    if (code) { showConfirm(); return; }   // 扫码打开 → 确认页
    showMain();                            // 正常登录页
  }).catch(function () {
    /* 后端不可达时也别卡死：显示账号表单，让用户看到明确报错 */
    showMain();
    $('msgLogin').textContent = '无法连接服务，请稍后重试';
    $('msgLogin').className = 'msg err';
  });

  /* ---------- 扫码确认页 ---------- */
  function showConfirm() {
    $('paneConfirm').classList.add('on');
    $('subtitle').textContent = '扫码登录确认';
    $('btnConfirm').onclick = function () {
      $('btnConfirm').disabled = true;
      $('msgConfirm').textContent = '正在登录…';
      $('msgConfirm').className = 'msg';
      api('/api/auth/qr-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code }),
      }).then(function (res) {
        if (res.ok) { keepTokenInApp(res.body); $('msgConfirm').textContent = '登录成功，正在跳转…'; $('msgConfirm').className = 'msg ok'; goHome(); }
        else { throw new Error(res.body.error || '登录失败'); }
      }).catch(function (e) {
        $('msgConfirm').textContent = e.message || '二维码无效或已过期';
        $('msgConfirm').className = 'msg err';
        $('btnConfirm').disabled = false;
      });
    };
    refreshTvFocus();
  }

  /* ---------- 主登录页 ---------- */
  function showMain() {
    $('paneMain').classList.add('on');

    var tabs = document.querySelectorAll('.tab');
    tabs.forEach(function (t) {
      t.onclick = function () {
        tabs.forEach(function (x) { x.classList.remove('on'); });
        t.classList.add('on');
        ['pass', 'qr'].forEach(function (k) { $('tab' + (k === 'pass' ? 'Pass' : 'Qr')).classList.toggle('on', k === t.dataset.tab); });
        if (t.dataset.tab === 'qr') startQr(); else stopQr();
        refreshTvFocus();   // pane 切换后焦点可能落到被隐藏的控件，重新落焦
      };
    });

    $('btnLogin').onclick = function () {
      var u = $('user').value.trim(), p = $('pass').value;
      if (!u || !p) { $('msgLogin').textContent = '请输入账号和密码'; $('msgLogin').className = 'msg err'; return; }
      $('btnLogin').disabled = true;
      $('msgLogin').textContent = '正在登录…';
      $('msgLogin').className = 'msg';
      api('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: u, pass: p }),
      }).then(function (res) {
        if (res.ok) { keepTokenInApp(res.body); $('msgLogin').textContent = '登录成功，正在跳转…'; $('msgLogin').className = 'msg ok'; goHome(); }
        else { throw new Error(res.body.error || '登录失败'); }
      }).catch(function (e) {
        $('msgLogin').textContent = e.message || '登录失败';
        $('msgLogin').className = 'msg err';
        $('btnLogin').disabled = false;
      });
    };
    $('pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btnLogin').click(); });
    refreshTvFocus();
  }

  /* ---------- 二维码（供已登录的 App 扫码授权；长轮询授权状态） ----------
     语义：本页是「待登录方」，展示二维码；已登录的 App 扫码后调 qr-approve 批准，
     本页长轮询（?wait=1，服务端 hold 最多 60s）看到 approved 就自动 qr-login 兑换
     session（cookie 落在【本页】），完成登录。授权后服务端立即唤醒 hold，跳转零延迟。
     跨网络（App 内网 / 本页外网，或反之）同样成立：两端打同一个后端，code 在服务端
     内存里能对上，与各自 origin 无关。 */
  var qrTimer = null, qrCode = '';

  /* 蒙版开关：失效/获取失败时盖住二维码并提示点击刷新 */
  function showQrMask(text, sub) {
    var m = $('qrMask');
    m.firstElementChild.textContent = text || '二维码已失效';
    m.lastElementChild.textContent = sub || '点击刷新';
    m.hidden = false;
  }
  function hideQrMask() { $('qrMask').hidden = true; }

  /* 点击二维码（鼠标 / TV 遥控确认键都走 click）重新取码 */
  $('qrWrap').onclick = function () { startQr(); };

  function startQr() {
    $('msgQr').textContent = '';
    $('msgQr').className = 'msg';
    hideQrMask();
    api('/api/auth/qr').then(function (res) {
      if (!res.ok || !res.body.payload) throw new Error(res.body.error || '二维码获取失败');
      qrCode = res.body.code;
      $('qrImg').src = '/api/auth/qr.svg?text=' + encodeURIComponent(res.body.payload);
      $('qrHint').textContent = '请用已登录的 App 扫描此二维码（' + (res.body.expiresIn || 60) + ' 秒内有效）';
      qrTimer = true;           // 哨兵：true=轮询中；stopQr 置 null 可打断 hold 间的循环
      pollQr();
    }).catch(function (e) {
      $('qrImg').removeAttribute('src');
      $('qrHint').textContent = '二维码不可用';
      qrTimer = null;
      showQrMask('获取失败', '点击重试');
      $('msgQr').textContent = e.message || '获取失败';
      $('msgQr').className = 'msg err';
    });
  }

  /* 长轮询循环：pending → 服务端 hold 最多 60s，返回后立即发起下一个；网络错误退避 3s */
  function pollQr() {
    if (!qrTimer) return;
    api('/api/auth/qr-status?code=' + encodeURIComponent(qrCode) + '&wait=1').then(function (s) {
      if (!qrTimer) return;
      var st = s.body.state;
      if (st === 'approved') {
        /* App 已授权：本页立即兑换登录态（一次性），成功后跳首页 */
        qrTimer = null;
        $('msgQr').textContent = '已授权，正在登录…';
        $('msgQr').className = 'msg ok';
        api('/api/auth/qr-login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: qrCode }),
        }).then(function (r) {
          if (r.ok) { keepTokenInApp(r.body); goHome(); }
          else throw new Error(r.body.error || '兑换失败');
        }).catch(function (e) {
          $('msgQr').textContent = e.message || '登录失败';
          $('msgQr').className = 'msg err';
        });
      } else if (st === 'expired' || st === 'gone' || st === 'consumed') {
        qrTimer = null;
        showQrMask('二维码已失效', '点击刷新');
        $('msgQr').textContent = '二维码已失效，点击二维码刷新';
        $('msgQr').className = 'msg err';
      } else {
        pollQr();
      }
    }).catch(function () {
      /* 断网/超时：退避 3 秒再续，避免慢链路上叠请求 */
      if (!qrTimer) return;
      setTimeout(function () { if (qrTimer) pollQr(); }, 3000);
    });
  }
  function stopQr() { qrTimer = null; }

  /* pane 切换后重落焦：tvFocus 的 collect() 会过滤掉 display:none 的旧控件，
     这里按几何最近重新落到当前可见控件。仅 TV 模式挂了 __tvFocus，普通模式 no-op。 */
  function refreshTvFocus() {
    var tf = window.__tvFocus;
    if (tf && typeof tf.focusFirst === 'function') tf.focusFirst();
  }

  /* TV 焦点导航：复用大屏同源实现，挂出 window.__tvFocus.key(name)。
     必须早于上面的 showMain/showConfirm（它们会调 refreshTvFocus）。 */
  initTvFocus();
})();
