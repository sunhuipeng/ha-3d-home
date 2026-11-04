/*
 * speaker — 小爱音箱插件（media_player）
 * 坐标系: group 原点 = 底面中心；尺寸按真实产品比例（约 1:1 米）
 *
 * 造型（参考市面在售小爱音箱）:
 *   ai_pod    小米AI音箱（一代）  白色织物圆柱 + 顶部环形 LED + 四麦孔 + 顶键
 *   sound_pro 小爱音箱 Pro        哑黑高圆柱 + 顶部 LED 环 + 三个顶键
 *   play      小爱音箱 Play       白色矮胖机身 + 灰色顶盘 + 环灯
 *   touch     小爱触屏音箱        楔形机身 + 前倾触摸屏（显示曲目/音量/时钟）
 *
 * 状态映射（真机 LED 语义）:
 *   playing          → 蓝色环灯常亮呼吸，亮度/频率随 volume_level
 *   is_volume_muted  → 橙色环灯暗呼吸
 *   其余（idle 等）  → 深蓝微亮慢呼吸
 * 说明: 音箱默认不参与点击（defaultOn:false，避免误触出声），在属性面板勾选「点击控制」后
 *       点击机身 = 播放 / 暂停
 *
 * —— 参数速查（设备类插件通用；完整逐项说明见 assets/plugins/door/plugin.js 头部手册）——
 * 注册: id / kind:'device' / type（HA 实体类型，决定能绑哪类实体）/ name 必填
 *       styles 造型 [{ id, name, z（锚点离地高度,米）, labelOffset?, icon?, model?,
 *                      desc?（面板说明小字）, options?（样式参数 schema）}]
 *              面板/数据里的造型 id 会加 '<插件id>:' 前缀；插件里 ctx.style.id 仍是原始 id
 *       fields 扩展实体 [{ key, label, domains?, placeholder?, tip? }]
 *              绑上后值存 obj[key]，用 ctx.field*(key) 读；未绑定返回 null / ''
 *       click 点击控制 { on, off, isOn(st), label?, defaultOn?, feedback? }
 *              on/off 写服务名或 { domain, service }；isOn(st) 决定「发 on 还是发 off」；
 *              不写 click 时按 type 取内置默认：light/switch/fan/cover = toggle，
 *              water_heater/climate = turn_on + turn_off，其它 type 不可点击；
 *              不写 isOn 时默认「state 既不是 off 也不是 unavailable 就算已开」
 *       stateText(st, obj, get) → 标题标签文案
 *              st = 主实体状态；obj = 实例数据；get = (eid) => 状态对象（读扩展实体用）；
 *              返回空串则由调用方回退通用规则（on/off → 已开启/已关闭，其余 state + 单位）
 *       plan2d(c, p) 可选，2D 平面符号自绘：只画中性线稿（颜色只用 p.fill / p.ink /
 *              p.accent / p.accent2 / p.lw），p.fill 只能填进封闭形状内部，返回包围半径(px)；
 *              选中虚线圈、未连接红描边由编辑器负责，别自己铺整圆背景、别画随机装饰
 * model3d(ctx) 必填，可 async，返回 { group, update?, dispose? }
 *       group   模型根节点（原点 = 锚点；摆位/旋转/整体比例由引擎做，别自己再加偏移）
 *       update  任一绑定实体变化时调用：只读状态算目标值，插值交给 animate
 *       dispose 场景重建时释放自建贴图/监听（几何由引擎回收）
 * obj 字段: entityId（主实体）+ fields 的 key；x/y/rot/z/pct 已由引擎应用；style 决定造型
 * ctx 常用: THREE / obj / style / options（样式参数取值）/ wallH / baseUrl
 *           glb('models/x.glb') → Promise<Group|null>（内部已 clone）/ frame(g,L,ref) 门窗框
 *           box() cyl() sphere() lambert() lightKit(parent,y,size,opts) glowTexture()
 *           getState(eid) / isOn(eid) / binaryRatio(eid) / toNum(v)
 *           field(key) hasField() fieldState() fieldOn() fieldNum() fieldText()
 *           animate(fn(dt秒)) 逐帧 / render() 手动刷一帧
 * 本插件用到: THREE、obj、style、box、cyl、lambert、getState、fieldText、animate
 * 完整手册（注册全表、ctx 全表、坐标系与摆放、生命周期、常见坑、最小模板）：
 *   assets/plugins/door/plugin.js 头部注释。
 */
'use strict';

/* 包一层 IIFE：独立 <script> 加载的经典脚本共享全局作用域，顶层 const 重名会 SyntaxError */
(function () {

/* 造型图标: 面板样式按钮里显示的线性 SVG（图标由插件自己提供，引擎只用 ⚙️ 兜底）。
 * 换图标直接改这里的 inner —— 24×24 视框、不写 width/height，颜色用 currentColor 跟随主题。 */
const ico = PluginEngine.ico;   // 图标包装在引擎里统一实现（PluginEngine.ico）

PluginEngine.register({
  builtin: true,   // 内置插件标记：不带此参数的注册一律视为自定义（「自定义」角标）
  id: 'speaker',
  kind: 'device',
  type: 'media_player',
  name: '小爱音箱',
  styles: [
    { id: 'ai_pod',    name: '小米AI音箱',   z: 0.72, icon: ico('<rect x="7" y="6" width="10" height="14" rx="4.5"/><ellipse cx="12" cy="6" rx="5" ry="1.7"/><circle cx="12" cy="6" r="1" fill="currentColor" stroke="none"/>') },
    { id: 'sound_pro', name: '小爱音箱 Pro', z: 0.72, icon: ico('<rect x="8" y="3.5" width="8" height="17" rx="3.5"/><ellipse cx="12" cy="3.8" rx="4" ry="1.3"/><line x1="9.5" y1="7" x2="14.5" y2="7" opacity=".5"/>') },
    { id: 'play',      name: '小爱音箱 Play', z: 0.55, icon: ico('<rect x="5.5" y="9" width="13" height="10" rx="4.5"/><ellipse cx="12" cy="9" rx="6.5" ry="1.8"/><circle cx="12" cy="9" r="1.1" fill="currentColor" stroke="none"/>') },
    { id: 'touch',     name: '小爱触屏音箱', z: 0.55, icon: ico('<rect x="4.5" y="5" width="15" height="10.5" rx="1.6"/><path d="M6.5 15.5 l-1.2 3 h13.4 l-1.2 -3" opacity=".7"/><line x1="8" y1="8" x2="14" y2="8" opacity=".5"/>') },
  ],

  /* 点击控制: 播放中→暂停，否则→播放。
   * defaultOn:false = 默认不响应点击（避免误触就出声），需要在属性面板勾选"点击控制"才启用 */
  click: {
    on: { domain: 'media_player', service: 'media_play' },
    off: { domain: 'media_player', service: 'media_pause' },
    isOn: (st) => !!(st && st.state === 'playing'),
    label: '播放 / 暂停',
    defaultOn: false,
  },

  /* 扩展实体（可选）: 音源 / 当前曲目。
   * 小爱多数机型只把音量放在 media_player 属性里，曲目与音源要另绑 sensor/select。 */
  fields: [
    { key: 'sourceEntity', label: '音源', domains: ['sensor', 'select', 'input_select'], placeholder: 'sensor.xxx / select.xxx（可选）', tip: '如"网易云/蓝牙/AUX"，显示在触屏左上与标签' },
    { key: 'titleEntity', label: '当前曲目', domains: ['sensor'], placeholder: 'sensor.xxx（可选）', tip: '主实体没有 media_title 时用它填触屏曲目行' },
  ],

  /* 标签文案: 播放状态 + 音量 + 静音图标 + 音源 */
  stateText(st, obj, get) {
    if (!st) return '';
    const at = st.attributes || {};
    const vol = at.volume_level != null ? ' ' + Math.round(at.volume_level * 100) + '%' : '';
    const base = st.state === 'playing' ? '播放中' : st.state === 'idle' ? '空闲' : st.state;
    return base + vol + (at.is_volume_muted ? ' 🔇' : '')
      + PluginEngine.fieldBits(obj, get, [['sourceEntity', (s) => (s.state || '').slice(0, 12)]]);
  },

  /* 2D 简笔: 按造型区分 —— ai_pod 胶囊 / sound_pro 方箱双单元 / play 条形音箱 / touch 带屏面板 */
  plan2d(c, p) {
    const sid = p.style || 'ai_pod';
    if (sid === 'sound_pro') {
      const s = 0.3 * p.ppm;
      p.draw(() => p.rrect(-s / 2, -s / 2, s, s, s * 0.18));
      c.beginPath(); c.arc(0, s * 0.16, s * 0.26, 0, Math.PI * 2);
      c.lineWidth = 1.4; c.strokeStyle = p.accent2; c.stroke();
      c.beginPath(); c.arc(0, -s * 0.24, s * 0.09, 0, Math.PI * 2);
      c.fillStyle = p.accent; c.fill();
      return s * 0.71;
    }
    if (sid === 'play') {
      const w = 0.8 * p.ppm, h = 0.12 * p.ppm;
      p.draw(() => p.rrect(-w / 2, -h / 2, w, h, h * 0.5));
      c.beginPath(); c.ellipse(0, 0, h * 0.28, h * 0.34, 0, 0, Math.PI * 2);
      c.fillStyle = p.accent2; c.fill();
      return w / 2;
    }
    if (sid === 'touch') {
      const w = 0.2 * p.ppm, h = 0.14 * p.ppm;
      p.draw(() => p.rrect(-w / 2, -h / 2, w, h, h * 0.25));
      p.rrect(-w * 0.32, -h * 0.3, w * 0.64, h * 0.5, h * 0.08);
      c.lineWidth = 1.2; c.strokeStyle = p.accent2; c.stroke();
      return Math.max(w, h) * 0.71;
    }
    const s = Math.max(14, 0.14 * p.ppm);   /* ai_pod / 缺省: 胶囊 */
    p.draw(() => p.rrect(-s / 2, -s / 2, s, s, s * 0.45));
    c.beginPath(); c.ellipse(0, 0, s * 0.3, s * 0.18, 0, 0, Math.PI * 2);
    c.lineWidth = 1.2; c.strokeStyle = p.accent2; c.stroke();
    return s * 0.72;
  },

  async model3d(ctx) {
    const T = ctx.THREE;
    const d = ctx.obj;
    const sid = (ctx.style || {}).id || 'ai_pod';
    const g = new T.Group();

    const LED_ON = 0x2f9dff;      // 播放: 小爱蓝
    const LED_MUTE = 0xff8a3d;    // 静音: 暖橙
    const LED_IDLE = 0x14202b;    // 待机: 深蓝微光
    const ledMats = [];
    const ledMat = () => { const m = ctx.lambert('#cfdae6'); ledMats.push(m); return m; };

    /* 环形 LED（水平放置的圆环） */
    const ring = (parent, R, tube, y, mat) => {
      const m = new T.Mesh(new T.TorusGeometry(R, tube, 10, 40), mat || ledMat());
      m.rotation.x = Math.PI / 2;
      m.position.y = y;
      parent.add(m);
      return m;
    };
    /* 顶面麦克风孔（4 个） */
    const mics = (parent, y, rad, color) => {
      [45, 135, 225, 315].forEach((a) => {
        const r = a * Math.PI / 180;
        ctx.cyl(parent, 0.0032, 0.0032, 0.002, 8, Math.cos(r) * rad, y, Math.sin(r) * rad, color || '#9aa4ae');
      });
    };

    let drawScreen = null;    // 仅触屏款有
    let screenTex = null;

    if (sid === 'sound_pro') {
      /* 小爱音箱 Pro: 哑黑高圆柱 h≈0.245 */
      ctx.cyl(g, 0.05, 0.053, 0.012, 28, 0, 0.006, 0, '#14181c');                 // 底座
      ctx.cyl(g, 0.0445, 0.0495, 0.212, 28, 0, 0.118, 0, '#2b3138');             // 网罩机身
      ctx.cyl(g, 0.0465, 0.0465, 0.012, 28, 0, 0.230, 0, '#1a1e23');             // 顶部收边
      ctx.cyl(g, 0.0435, 0.0435, 0.006, 28, 0, 0.239, 0, '#15181c');             // 顶面
      ring(g, 0.034, 0.0038, 0.2425);                                            // LED 环
      // 三个顶键（音量± / 播放）
      ctx.cyl(g, 0.011, 0.011, 0.003, 14, 0, 0.2425, -0.018, '#3a424a');
      ctx.cyl(g, 0.011, 0.011, 0.003, 14, -0.026, 0.2425, 0.004, '#3a424a');
      ctx.cyl(g, 0.011, 0.011, 0.003, 14, 0.026, 0.2425, 0.004, '#3a424a');
      ctx.box(g, 0.02, 0.006, 0.0015, 0, 0.015, 0.0495, '#525a63');              // 前 logo
    } else if (sid === 'play') {
      /* 小爱音箱 Play: 白色矮胖 h≈0.13 */
      ctx.cyl(g, 0.054, 0.057, 0.012, 26, 0, 0.006, 0, '#eff2f5');
      ctx.cyl(g, 0.05, 0.054, 0.10, 26, 0, 0.062, 0, '#f8f9fb');
      ctx.cyl(g, 0.05, 0.05, 0.014, 26, 0, 0.119, 0, '#dde3ea');                 // 灰色顶盘
      ring(g, 0.041, 0.005, 0.1265);
      ctx.cyl(g, 0.016, 0.016, 0.004, 14, 0, 0.1275, 0, '#c7cfd8');              // 播放键
      mics(g, 0.1278, 0.03, '#b3bcc6');
      ctx.box(g, 0.016, 0.005, 0.0015, 0, 0.03, 0.0535, '#b9c2cc');
    } else if (sid === 'touch') {
      /* 小爱触屏音箱: 楔形机身 + 前倾触摸屏 */
      ctx.box(g, 0.18, 0.012, 0.07, 0, 0.006, 0.004, '#e8ecf1');                 // 底座
      ctx.box(g, 0.17, 0.104, 0.05, 0, 0.064, -0.008, '#f2f4f7');                // 机身
      ctx.box(g, 0.156, 0.09, 0.006, 0, 0.066, 0.019, '#1a1d21');                // 屏幕边框
      ctx.box(g, 0.12, 0.014, 0.004, 0, 0.016, 0.026, '#d7dde4');                // 下方喇叭网
      ctx.cyl(g, 0.004, 0.004, 0.002, 10, 0, 0.108, 0.022, '#2a3038');           // 摄像头
      // 顶部 LED 灯条
      const barMat = ledMat();
      const bar = new T.Mesh(new T.BoxGeometry(0.13, 0.004, 0.006), barMat);
      bar.position.set(0, 0.112, 0.02);
      g.add(bar);
      // 触摸屏
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 144;
      const g2d = cv.getContext('2d');
      screenTex = new T.CanvasTexture(cv);
      const sp = new T.Mesh(new T.PlaneGeometry(0.144, 0.078), new T.MeshBasicMaterial({ map: screenTex }));
      sp.position.set(0, 0.066, 0.0235);
      sp.rotation.x = -0.08;
      g.add(sp);

      drawScreen = (playing, vol, muted, title, src) => {
        g2d.fillStyle = '#0b1016';
        g2d.fillRect(0, 0, 256, 144);
        // 顶部时钟
        const now = new Date();
        g2d.textAlign = 'right';
        g2d.font = '20px "SF Mono", monospace';
        g2d.fillStyle = '#48606f';
        g2d.fillText(String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'), 246, 28);
        // 左上: 音源（扩展实体，可选）
        if (src) {
          g2d.textAlign = 'left';
          g2d.font = '16px "PingFang SC", sans-serif';
          g2d.fillStyle = '#3d5666';
          g2d.fillText(('◈ ' + src).slice(0, 12), 14, 26);
        }
        // 状态 / 曲名
        g2d.textAlign = 'left';
        g2d.font = 'bold 26px "PingFang SC", "SF Mono", sans-serif';
        g2d.fillStyle = muted ? '#c98a4a' : playing ? '#8fd6ff' : '#3f4c58';
        g2d.fillText(muted ? '已静音' : playing ? '♪ 播放中' : '待机', 14, 62);
        g2d.font = '17px "PingFang SC", sans-serif';
        g2d.fillStyle = playing ? '#7d93a3' : '#33404c';
        const tt = (title || '').slice(0, 16) || (playing ? '小爱正在播放' : '');
        if (tt) g2d.fillText(tt, 14, 88);
        // 音量条
        g2d.fillStyle = '#16222c';
        g2d.fillRect(14, 104, 190, 10);
        if (!muted) {
          g2d.fillStyle = playing ? '#4fb8f5' : '#2c4353';
          g2d.fillRect(14, 104, 190 * (vol || 0), 10);
        }
        g2d.textAlign = 'right';
        g2d.font = '16px "SF Mono", monospace';
        g2d.fillStyle = muted ? '#8a6a44' : '#4a7a94';
        g2d.fillText(muted ? '🔇' : Math.round((vol || 0) * 100) + '%', 246, 130);
        screenTex.needsUpdate = true;
      };
    } else {
      /* 小米AI音箱（一代）: 白色织物圆柱 h≈0.21 */
      ctx.cyl(g, 0.05, 0.053, 0.014, 28, 0, 0.007, 0, '#e9ecf0');                // 底座
      ctx.cyl(g, 0.0465, 0.0495, 0.182, 28, 0, 0.105, 0, '#f6f7f9');             // 织物网罩
      ctx.cyl(g, 0.0485, 0.0485, 0.012, 28, 0, 0.202, 0, '#eff2f5');             // 顶部收边
      ctx.cyl(g, 0.0455, 0.0455, 0.006, 28, 0, 0.211, 0, '#e3e8ed');             // 顶面
      ring(g, 0.035, 0.0042, 0.2145);                                            // 环形 LED
      ctx.cyl(g, 0.016, 0.016, 0.003, 16, 0, 0.2145, 0, '#ccd3da');              // 播放键
      mics(g, 0.2148, 0.027, '#a7b0ba');
      ctx.box(g, 0.012, 0.007, 0.0015, 0, 0.04, 0.0495, '#a7b0ba');              // 前 MI 标
    }

    let playing = false, vol = 0.4, muted = false, title = '', src = '';
    const api = {
      group: g,
      update() {
        const st = ctx.getState(d.entityId);
        playing = !!(st && st.state === 'playing');
        const at = (st && st.attributes) || {};
        vol = at.volume_level != null ? Math.min(1, Math.max(0, at.volume_level)) : 0.4;
        muted = !!at.is_volume_muted;
        /* 曲目/音源: 主实体属性优先，缺了才用扩展实体（titleEntity / sourceEntity） */
        title = at.media_title || ctx.fieldText('titleEntity');
        src = at.source || ctx.fieldText('sourceEntity');
        if (drawScreen) drawScreen(playing, vol, muted, title, src);
      },
    };
    /* LED 呼吸: 播放蓝色（音量越大越亮越快）、静音橙色暗呼吸、待机深蓝微光 */
    let t = 0, lastSec = -1, lastSig = '';
    ctx.animate((dt) => {
      t += dt;
      const hex = muted ? LED_MUTE : playing ? LED_ON : LED_IDLE;
      const base = muted ? 0.3 : playing ? 0.55 + vol * 0.45 : 0.12;
      const spd = playing && !muted ? 2.0 + vol * 3.0 : 0.9;
      const k = Math.max(0.04, base * (0.72 + 0.28 * Math.sin(t * spd)));
      ledMats.forEach((m) => {
        m.emissive.setHex(hex);
        m.emissive.multiplyScalar(k);
      });
      /* 触屏: 空闲时每秒刷新时钟；曲目/音源变化立即重绘 */
      if (drawScreen) {
        const sec = Math.floor(t);
        const sig = title + '|' + src;
        if (sec !== lastSec || sig !== lastSig) {
          lastSec = sec; lastSig = sig;
          drawScreen(playing, vol, muted, title, src);
        }
      }
    });

    return api;
  },
});

})();
