/*
 * water_heater — 电热水器插件
 * 坐标系: group 原点 = 挂墙锚点（横置储水式电热水器，锚点默认离地 1.8m）
 * 组合: 横置圆柱罐体(轴向水平) + 端盖 + 挂墙支架 + 进出水管 + Canvas 显示屏 + 加热指示灯
 * 绑定: 该设备自身的 water_heater.* 实体
 * 状态:
 *   - state 'on'/'off' → 开机/待机（屏幕亮灭）
 *   - attributes.current_temperature / target_temperature → 显示屏实时刷新
 *   - attributes.heating_power → 功率读数 + 呼吸灯频率
 *   - attributes.heating → 加热指示灯呼吸（红色）
 *   - attributes.min_temp / max_temp → 目标温度进度条范围（超出钳制）
 * 属性契约参考（米家热水器）: min_temp/max_temp/current_temperature/target_temperature/
 *   heating/heating_power/... 均为实体 attributes，插件按需读取不依赖其余字段
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
 * 本插件用到: THREE、obj、box、lambert、getState、fieldNum、animate
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
  id: 'water_heater',
  kind: 'device',
  type: 'water_heater',
  name: '热水器',
  styles: [
    { id: 'tank', name: '横置水箱', z: 1.8, icon: ico('<rect x="3.5" y="7" width="17" height="9" rx="4.5"/><line x1="8" y1="16" x2="8" y2="19.5"/><line x1="16" y1="16" x2="16" y2="19.5"/><line x1="3.5" y1="11.5" x2="20.5" y2="11.5" opacity=".45"/><circle cx="16.6" cy="9.6" r="1" fill="currentColor" stroke="none"/>') },
  ],

  /* 点击: 开机 / 关机（water_heater 域无 toggle 服务，用 turn_on / turn_off） */
  click: {
    on: 'turn_on',
    off: 'turn_off',
    isOn: (st) => PluginEngine.runningState(st),
    label: '开机 / 关机',
  },

  /* 标签文案: 当前温度 → 目标温度 */
  stateText(st, obj, get) {
    if (!st) return '';
    const at = st.attributes || {};
    const extra = PluginEngine.fieldBits(obj, get, [
      ['ambientEntity', (s, n) => (n != null ? '环境 ' + Math.round(n) + '°' : '')],
    ]);
    if (st.state === 'off') return '已关闭' + extra;
    if (at.current_temperature != null) {
      const tgt = at.target_temperature != null ? ' → ' + Math.round(at.target_temperature) + '°' : '';
      return Math.round(at.current_temperature) + '°' + tgt + extra;
    }
    return '已开启' + extra;
  },

  /* 扩展实体（可选）: 外部功率计 / 环境温度。
   * 不少热水器只报 current_temperature，功率与环境温度来自独立的计量插座/温湿度计。 */
  fields: [
    { key: 'powerEntity', label: '功率', domains: ['sensor'], placeholder: 'sensor.xxx（W，可选）', tip: '主实体没有 heating_power 时用它驱动屏幕功率与呼吸灯' },
    { key: 'ambientEntity', label: '环境温度', domains: ['sensor'], placeholder: 'sensor.xxx（°C，可选）', tip: '机房/阳台温度，显示在标签' },
  ],

  /* 2D 简笔: 热水器俯视 —— 圆形储水罐 + 两个进出水管（内圈用 p.accent2 中性色，加热与否只体现在 p.fill） */
  plan2d(c, p) {
    const R = 0.17 * p.ppm;
    p.draw(() => { c.arc(0, 0, R, 0, Math.PI * 2) });
    c.beginPath(); c.arc(0, 0, R * 0.6, 0, Math.PI * 2);
    c.lineWidth = 1.3; c.strokeStyle = p.accent2; c.stroke();
    c.lineWidth = 2.4; c.strokeStyle = p.ink;
    c.beginPath(); c.moveTo(-R * 0.45, -R); c.lineTo(-R * 0.45, -R - 0.05 * p.ppm); c.stroke();
    c.beginPath(); c.moveTo(R * 0.45, -R); c.lineTo(R * 0.45, -R - 0.05 * p.ppm); c.stroke();
    return R + 0.06 * p.ppm + 2;
  },

  async model3d(ctx) {
    const d = ctx.obj;
    const g = new ctx.THREE.Group();

    /* 横置罐体: 圆柱 R0.23 × L0.78，轴向沿 X 水平，中心即锚点 */
    const R = 0.23, L = 0.78;
    const body = new ctx.THREE.Mesh(new ctx.THREE.CylinderGeometry(R, R, L, 24), ctx.lambert('#eef1f5'));
    body.rotation.z = Math.PI / 2;
    g.add(body);
    /* 两端圆弧端盖（半球收边，模拟储水罐封头） */
    [-L / 2, L / 2].forEach((x) => {
      const cap = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(R, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), ctx.lambert('#e2e8ef'));
      cap.position.x = x;
      cap.rotation.z = x > 0 ? -Math.PI / 2 : Math.PI / 2;
      g.add(cap);
    });

    /* 挂墙支架（背面 -Z 贴墙） */
    ctx.box(g, 0.5, 0.16, 0.07, 0, -0.06, -(R - 0.02), '#c9d1da');
    ctx.box(g, 0.56, 0.05, 0.05, 0, 0.02, -(R + 0.01), '#b7c1cc');

    /* 进出水管（罐底伸出两根短管） */
    [-0.2, 0.2].forEach((x) => {
      const pipe = new ctx.THREE.Mesh(new ctx.THREE.CylinderGeometry(0.035, 0.035, 0.22, 10), ctx.lambert('#aab6c2'));
      pipe.position.set(x, -(R + 0.1), 0.06);
      g.add(pipe);
    });

    /* Canvas 显示屏（正面 +Z，罐体表面）: 当前温度 + 目标温度 + 功率 + 加热状态 */
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 64;
    const g2d = cv.getContext('2d');
    const tex = new ctx.THREE.CanvasTexture(cv);
    const panel = new ctx.THREE.Mesh(
      new ctx.THREE.PlaneGeometry(0.26, 0.13),
      new ctx.THREE.MeshBasicMaterial({ map: tex })
    );
    panel.position.set(0.12, -0.04, R + 0.002);   // 罐体表面（R + 0.002 防 z-fighting）
    g.add(panel);

    function draw(cur, tgt, on, heating, lo, hi, pw) {
      g2d.fillStyle = on ? '#0a141d' : '#151a20';
      g2d.fillRect(0, 0, 128, 64);
      /* 当前温度（大字） */
      g2d.textAlign = 'left';
      g2d.font = 'bold 30px "SF Mono", monospace';
      g2d.fillStyle = on ? '#38e18c' : '#3c4754';
      g2d.fillText((cur != null ? Math.round(cur) : '--') + '°', 7, 34);
      /* 目标温度（小字） */
      g2d.textAlign = 'right';
      g2d.font = '15px "SF Mono", monospace';
      g2d.fillStyle = heating && on ? '#ff9a6a' : '#5f7c92';
      g2d.fillText(tgt != null ? '目标 ' + Math.round(tgt) + '°' : '待机', 122, 30);
      /* 功率（左下小字，heating_power，单位 W） */
      g2d.textAlign = 'left';
      g2d.font = '12px "SF Mono", monospace';
      g2d.fillStyle = on && pw > 0 ? '#ffd479' : '#4a5a68';
      g2d.fillText(pw != null ? Math.round(pw) + 'W' : '--W', 8, 56);
      /* 目标进度条（min_temp~max_temp 内的位置，右半区） */
      if (on && tgt != null && lo != null && hi != null && hi > lo) {
        const p = Math.max(0, Math.min(1, (tgt - lo) / (hi - lo)));
        g2d.fillStyle = '#22323f';
        g2d.fillRect(58, 50, 60, 6);
        g2d.fillStyle = heating ? '#ff8a50' : '#38e18c';
        g2d.fillRect(58, 50, Math.round(60 * p), 6);
      }
      tex.needsUpdate = true;
    }

    /* 加热指示灯（罐体正面右下） */
    const heatMat = ctx.lambert('#7a2e20');
    const lamp = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.028, 12, 10), heatMat);
    lamp.position.set(-0.2, -0.1, R - 0.02);
    g.add(lamp);

    let on = false, heating = false, cur = null, tgt = null, lo = null, hi = null, pw = null;
    const api = {
      group: g,
      update() {
        const st = ctx.getState(d.entityId);
        on = !!(st && st.state === 'on');
        const at = (st && st.attributes) || {};
        heating = !!at.heating;
        const num = (v) => ctx.toNum(v);
        cur = num(at.current_temperature);
        tgt = num(at.target_temperature);
        lo = num(at.min_temp);
        hi = num(at.max_temp);
        /* 功率优先用主实体 heating_power，没有则回退到绑定的功率传感器；
         * 主实体没报 heating 时，用功率 >30W 判断是否在加热（呼吸灯/指示灯靠它） */
        pw = num(at.heating_power);
        if (pw == null) pw = ctx.fieldNum('powerEntity');
        if (at.heating == null && pw != null) heating = pw > 30;
        draw(cur, tgt, on, heating, lo, hi, pw);
        if (!heating || !on) heatMat.emissive.setHex(0x000000);
      },
    };
    /* 加热呼吸灯: 闪烁速度随功率变化（heating_power 0~3000W 映射 1.6~5.2 rad/s） */
    let t = 0;
    ctx.animate((dt) => {
      t += dt;
      if (on && heating) {
        const rate = 1.6 + 3.6 * Math.max(0, Math.min(1, (pw || 0) / 3000));
        const p = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * rate));
        heatMat.emissive.setRGB(p, 0.22 * p, 0.1 * p);
      }
    });

    return api;
  },
});

})();
