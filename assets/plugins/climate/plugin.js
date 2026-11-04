/*
 * climate — 空调插件
 * 坐标系: group 原点 = 锚点（壁挂 = 挂机机身中心，即深度中线 / 柜机 = 地面中心）
 * 状态:
 *   - state（hvac_mode）非 off/unavailable 视为运行: 出风叶片摆下送风 + 运行指示
 *   - attributes.temperature / current_temperature → 显示屏实时读数
 *   - attributes.hvac_action → 模式色: cooling 蓝 / heating 橙红 / 其余（fan/dry/idle）绿
 *   - attributes.fan_mode → 显示屏显示风速
 *   - attributes.swing_mode === 'vertical' → 叶片上下扫风，否则定角送风
 * 属性契约（米家空调 companion）: hvac_modes/min_temp/max_temp/temperature/
 *   current_temperature/fan_mode/hvac_action/swing_mode，按需读取不依赖其余字段
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
 * 本插件用到: THREE、obj、style、box、lambert、getState、fieldNum、animate
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
  id: 'climate',
  kind: 'device',
  type: 'climate',
  name: '空调',
  styles: [
    { id: 'ac_wall',  name: '壁挂空调', z: 2.55, icon: ico('<rect x="4" y="5" width="16" height="8" rx="1.5"/><line x1="4" y1="10" x2="20" y2="10" opacity=".5"/><path d="M8 16 q2 2 4 0 q2 -2 4 0" opacity=".6"/>') },
    { id: 'ac_floor', name: '立式柜机', z: 0, icon: ico('<rect x="7" y="3.5" width="10" height="17" rx="1.5"/><line x1="7" y1="9" x2="17" y2="9" opacity=".5"/><line x1="7" y1="16.5" x2="17" y2="16.5" opacity=".5"/>') },
  ],

  /* 点击: 开机 / 关机（climate 域无 toggle 服务，用 turn_on / turn_off）
   * state 是 cool/heat/idle 等模式值，非 off 即视为运行中 */
  click: {
    on: 'turn_on',
    off: 'turn_off',
    isOn: (st) => PluginEngine.runningState(st),
    label: '开机 / 关机',
  },

  /* 标签文案: 模式 + 目标温度 */
  stateText(st, obj, get) {
    if (!st) return '';
    const m = { cool: '制冷中', heat: '制热中', fan_only: '送风', dry: '除湿', idle: '待机', auto: '自动', off: '已关闭' };
    const at = st.attributes || {};
    const tgt = st.state !== 'off' && at.temperature != null ? ' ' + Math.round(at.temperature) + '°' : '';
    return PluginEngine.baseStateText(st, m) + tgt + PluginEngine.fieldBits(obj, get, [
      ['humidityEntity', (s, n) => (n != null ? '湿度 ' + Math.round(n) + '%' : '')],
      ['outdoorEntity', (s, n) => (n != null ? '室外 ' + Math.round(n) + '°' : '')],
    ]);
  },

  /* 扩展实体（可选）: 室内湿度 / 室外温度。
   * 空调本体通常只报室温，湿度与室外温度是独立实体；绑上后显示在机身屏幕与标签上。 */
  fields: [
    { key: 'humidityEntity', label: '室内湿度', domains: ['sensor'], placeholder: 'sensor.xxx（%，可选）', tip: '显示在机身屏幕右下与标签' },
    { key: 'outdoorEntity', label: '室外温度', domains: ['sensor'], placeholder: 'sensor.xxx（°C，可选）', tip: '显示在标签，便于对比室内外' },
  ],

  /* 2D 简笔: 按造型区分 —— ac_wall 壁挂内机（长条）/ ac_floor 柜机（方身+竖栅条） */
  plan2d(c, p) {
    if ((p.style || 'ac_wall') === 'ac_floor') {
      const s = 0.35 * p.ppm;
      p.draw(() => p.rrect(-s / 2, -s / 2, s, s, s * 0.15));
      c.lineWidth = 1.3;
      c.strokeStyle = p.accent2;
      c.beginPath(); c.moveTo(-s * 0.3, s * 0.3); c.lineTo(s * 0.3, s * 0.3); c.stroke();
      for (let i = 0; i < 3; i++) {
        c.beginPath(); c.arc(0, s / 2, 4 + i * 3.5, 0.25 * Math.PI, 0.75 * Math.PI); c.stroke();
      }
      return s * 0.71 + 12;
    }
    const w = 0.85 * p.ppm, h = 0.22 * p.ppm;
    p.draw(() => p.rrect(-w / 2, -h / 2, w, h, h * 0.35));
    c.lineWidth = 1.3;
    c.strokeStyle = p.accent2;
    c.beginPath(); c.moveTo(-w / 2 + 4, h * 0.25); c.lineTo(w / 2 - 4, h * 0.25); c.stroke();
    for (let i = 0; i < 3; i++) {
      c.beginPath(); c.arc(0, h / 2, 4 + i * 3.5, 0.25 * Math.PI, 0.75 * Math.PI); c.stroke();
    }
    return w / 2 + 12;
  },

  async model3d(ctx) {
    const d = ctx.obj;
    const sid = (ctx.style || {}).id || 'ac_wall';
    const g = new ctx.THREE.Group();

    let louver = null;      // 出风叶片（动态）
    const ledMat = ctx.lambert('#f2f4f6');

    /* 显示屏 Canvas（当前温度 + 目标温度 + 模式/风速） */
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 64;
    const g2d = cv.getContext('2d');
    const tex = new ctx.THREE.CanvasTexture(cv);
    const panel = new ctx.THREE.Mesh(
      new ctx.THREE.PlaneGeometry(0.3, 0.15),
      new ctx.THREE.MeshBasicMaterial({ map: tex })
    );

    if (sid === 'ac_floor') {
      // 立式柜机: 高箱体 + 出风栅 + 叶片；屏幕在机身上部
      ctx.box(g, 0.5, 1.8, 0.5, 0, 0.9, 0, '#f2f4f6');
      ctx.box(g, 0.4, 0.5, 0.02, 0, 0.6, 0.26, '#b9c2cc');
      louver = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.38, 0.1, 0.015), ctx.lambert('#d5dde4'));
      louver.position.set(0, 0.42, 0.275);
      g.add(louver);
      panel.position.set(0, 1.35, 0.252);
      g.add(panel);
      ctx.box(g, 0.02, 0.02, 0.01, 0.21, 1.2, 0.256, 0).material = ledMat;
    } else {
      // 壁挂空调: 长条挂机 + 底部出风叶片；屏幕在机身右侧
      ctx.box(g, 0.8, 0.25, 0.22, 0, 0, 0, '#f2f4f6');
      louver = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.72, 0.05, 0.015), ctx.lambert('#d5dde4'));
      louver.position.set(0, -0.14, 0.115);
      g.add(louver);
      panel.position.set(0.24, 0.02, 0.112);
      panel.scale.set(0.72, 0.72, 1);
      g.add(panel);
      ctx.box(g, 0.015, 0.015, 0.01, -0.33, 0.08, 0.112, 0).material = ledMat;
    }

    /* 送风气流: 交叉双面风带粒子，运行时从出风口沿叶片方向流出 */
    const windGroup = new THREE.Group();
    const streaks = [];
    for (let i = 0; i < 9; i++) {
      const geo = new THREE.PlaneGeometry(0.05, 0.2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xbfe3ff, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      const m2 = new THREE.Mesh(geo, mat);   // 十字交叉第二面，任意视角可见
      m2.rotation.y = Math.PI / 2;
      m.add(m2);
      windGroup.add(m);
      streaks.push({ mesh: m, mat, t: i / 9, speed: 0.55 + Math.random() * 0.35, side: i / 8 - 0.5 });
    }
    g.add(windGroup);

    function draw(cur, tgt, on, action, fan, hum) {
      g2d.fillStyle = on ? '#0a141d' : '#151a20';
      g2d.fillRect(0, 0, 128, 64);
      /* 目标温度（大字） */
      g2d.textAlign = 'left';
      g2d.font = 'bold 26px "SF Mono", monospace';
      g2d.fillStyle = on ? '#e8f4ff' : '#3c4754';
      g2d.fillText(on && tgt != null ? Math.round(tgt) + '°' : '--', 7, 30);
      /* 当前温度（右上小字） */
      g2d.textAlign = 'right';
      g2d.font = '13px "SF Mono", monospace';
      g2d.fillStyle = on ? '#5f7c92' : '#3a4450';
      g2d.fillText(cur != null ? '室温 ' + Math.round(cur) + '°' : '室温 --', 122, 20);
      /* 模式/风速（底部一行） */
      g2d.textAlign = 'left';
      g2d.font = '12px "SF Mono", monospace';
      const actText = { cooling: '❄ 制冷', heating: '♨ 制热', drying: '⊟ 除湿', fan: '送风', idle: '待机', 'off': '停止' }[action] || '';
      g2d.fillStyle = on ? (action === 'cooling' ? '#5fb8ff' : action === 'heating' ? '#ff9a6a' : '#38e18c') : '#3a4450';
      g2d.fillText(actText, 7, 52);
      g2d.textAlign = 'right';
      g2d.fillStyle = on ? '#4a5a68' : '#323c46';
      /* 右下: 湿度（扩展实体）+ 风速，两者都有时并排 */
      g2d.fillText([hum != null ? Math.round(hum) + '%' : '', fan || ''].filter(Boolean).join(' '), 122, 52);
      tex.needsUpdate = true;
    }

    /* 模式指示灯颜色（机身 LED） */
    const actLed = { cooling: 0x3d8bff, heating: 0xff6a3d, drying: 0x39c9a8, fan: 0x38e18c, idle: 0x2a9e6a };

    let running = false, action = 'off', swing = false, fan = '';
    const api = {
      group: g,
      update() {
        const st = ctx.getState(d.entityId);
        running = PluginEngine.runningState(st);
        const at = (st && st.attributes) || {};
        const num = (v) => ctx.toNum(v);
        action = at.hvac_action || 'off';
        swing = at.swing_mode === 'vertical';
        fan = at.fan_mode || '';
        /* 扩展实体: 湿度优先用绑定的湿度传感器，未绑定则用主实体的 current_humidity */
        const hum = ctx.fieldNum('humidityEntity');
        draw(num(at.current_temperature), num(at.temperature), running, action, fan,
          hum != null ? hum : num(at.current_humidity));
        if (!running) ledMat.emissive.setHex(0x000000);
        else if (actLed[action]) ledMat.emissive.setHex(actLed[action]);
        else ledMat.emissive.setHex(0x33cc66);
      },
    };
    /* 叶片: 运行时摆下送风；swing_mode=vertical 上下扫风，否则定角微摆 */
    let t = 0;
    ctx.animate((dt) => {
      t += dt;
      const base = running ? 0.55 : 0.02;
      const wobble = running ? (swing ? Math.sin(t * 1.6) * 0.22 : Math.sin(t * 1.6) * 0.06) : 0;
      louver.rotation.x += ((base + wobble) - louver.rotation.x) * Math.min(1, dt * 3);

      /* 风带: 从出风口沿当前叶片角度流出，随距离淡入淡出 */
      const floorMode = sid === 'ac_floor';
      const oy = floorMode ? 0.40 : -0.16;
      const oz = floorMode ? 0.30 : 0.15;
      const tilt = floorMode ? 0.18 : louver.rotation.x;   // 柜机略上仰，壁挂跟随叶片
      const dy = Math.sin(tilt), dz = Math.cos(tilt);
      const span = floorMode ? 0.17 : 0.30;                // 横向铺开宽度
      const range = floorMode ? 1.0 : 1.15;                // 风程
      windGroup.visible = running;
      for (const s of streaks) {
        if (!running) { s.mat.opacity = 0; continue; }
        s.t += dt * s.speed;
        if (s.t > 1) s.t -= 1;
        const dist = s.t * range;
        s.mesh.position.set(s.side * span, oy + dy * dist, oz + dz * dist);
        s.mesh.rotation.x = Math.atan2(dz, dy);            // 长轴对齐风向
        s.mat.opacity = Math.sin(Math.PI * s.t) * 0.26;    // 首尾淡出
      }
    });

    return api;
  },
});

})();
