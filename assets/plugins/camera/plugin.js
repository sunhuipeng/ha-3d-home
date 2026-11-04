/*
 * camera — 摄像头插件（kind: 'device'，type: 'camera'）
 * 状态: 在线时录制红灯亮起；半球机在线时缓慢巡视转动
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
 * 本插件用到: THREE、obj、style、box、cyl、lambert、getState、fieldOn、animate
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
  id: 'camera',
  kind: 'device',
  type: 'camera',
  name: '摄像头',
  styles: [
    { id: 'cam_dome',   name: '半球摄像头', z: 2.78, icon: ico('<line x1="4" y1="4" x2="20" y2="4"/><path d="M6 4 a6 6 0 0 0 12 0"/><circle cx="12" cy="9" r="2" opacity=".7"/>') },
    { id: 'cam_bullet', name: '枪型摄像头', z: 2.6, icon: ico('<rect x="4" y="8" width="11" height="7" rx="2"/><path d="M15 9.5 l5 -2.5 v9 l-5 -2.5"/><circle cx="8" cy="11.5" r="1.4" opacity=".7"/>') },
  ],

  /* 扩展实体（可选）: 移动侦测 / 存储余量。
   * 摄像头主实体只反映在线/录制，移动侦测通常是独立的 binary_sensor。 */
  fields: [
    { key: 'motionEntity', label: '移动侦测', domains: ['binary_sensor'], placeholder: 'binary_sensor.xxx（可选）', tip: 'on=检测到移动，模型红灯快闪且标签提示' },
    { key: 'storageEntity', label: '存储余量', domains: ['sensor'], placeholder: 'sensor.xxx（可选）', tip: '如剩余容量/可用天数' },
  ],

  /* 点击: 开启 / 关闭隐私遮蔽（camera.turn_on / turn_off）
   * 摄像头普遍不响应开关，默认不参与点击，需要时在属性面板勾选
   * 判定: 非 unavailable 视为在线可关闭 */
  click: {
    on: 'turn_on',
    off: 'turn_off',
    isOn: (st) => PluginEngine.runningState(st),
    label: '开启 / 关闭',
    defaultOn: false,
  },

  /* 标签文案: 摄像头状态中文化 + 移动侦测/存储 */
  stateText(st, obj, get) {
    if (!st) return '';
    const m = { recording: '录制中', streaming: '推流中', idle: '待机', off: '已关闭', unavailable: '离线' };
    return PluginEngine.baseStateText(st, m) + PluginEngine.fieldBits(obj, get, [
      ['motionEntity', (s) => (s.state === 'on' ? '检测到移动' : '')],
      ['storageEntity', (s, n) => (n != null ? '存 ' + Math.round(n) + (s.attributes && s.attributes.unit_of_measurement ? s.attributes.unit_of_measurement : '') : '')],
    ]);
  },

  /* 2D 简笔: 按造型区分 —— cam_dome 半球（圆身+宽扇）/ cam_bullet 枪机（方身+窄扇） */
  plan2d(c, p) {
    const dome = (p.style || 'cam_dome') !== 'cam_bullet';
    const half = dome ? 0.6 : 0.35;
    const fov = 0.9 * p.ppm;
    /* 视场扇: 中性色常显（开/关只由 p.fill 填进机身封闭形状表达，编辑器不画整圆背景） */
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, fov, -Math.PI / 2 - half, -Math.PI / 2 + half);
    c.closePath();
    c.fillStyle = 'rgba(148,163,184,.12)'; c.fill();
    c.lineWidth = 1; c.strokeStyle = 'rgba(148,163,184,.45)'; c.stroke();
    if (dome) {
      const r = 0.09 * p.ppm;
      p.draw(() => { c.arc(0, 0, r, 0, Math.PI * 2) });
      c.beginPath(); c.arc(0, 0, r * 0.35, 0, Math.PI * 2);
      c.fillStyle = p.accent; c.fill();
    } else {
      const w = 0.16 * p.ppm, h = 0.07 * p.ppm;
      p.draw(() => p.rrect(-w / 2, -h / 2, w, h, h * 0.4));
      c.beginPath(); c.arc(0, -h / 2, Math.max(2, h * 0.22), Math.PI, 0);
      c.fillStyle = p.accent2; c.fill();
    }
    return fov + 2;
  },

  async model3d(ctx) {
    const d = ctx.obj;
    const sid = (ctx.style || {}).id || 'cam_dome';
    const g = new ctx.THREE.Group();
    let domeHead = null;

    if (sid === 'cam_bullet') {
      ctx.box(g, 0.04, 0.12, 0.04, 0, -0.06, 0, '#3a4048');
      const cam = ctx.cyl(g, 0.045, 0.05, 0.16, 14, 0, -0.14, 0.05, '#2f353c');
      cam.rotation.x = Math.PI / 2.4;
    } else {
      // 半球机: 底座 + 球头（在线时缓慢巡视）
      ctx.cyl(g, 0.08, 0.08, 0.02, 18, 0, -0.01, 0, '#dfe4ea');
      domeHead = new ctx.THREE.Group();
      domeHead.position.y = -0.02;
      const dome = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.06, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), ctx.lambert('#2f353c'));
      dome.rotation.x = Math.PI;
      domeHead.add(dome);
      g.add(domeHead);
    }

    const ledMat = ctx.lambert('#ff5544');
    ctx.cyl(g, 0.008, 0.008, 0.006, 10, sid === 'cam_dome' ? 0.05 : 0.02, sid === 'cam_dome' ? -0.02 : 0.03, sid === 'cam_dome' ? -0.05 : 0, 0).material = ledMat;

    let online = false, motion = false;
    const api = {
      group: g,
      update() {
        const st = ctx.getState(d.entityId);
        online = !!(st && st.state !== 'unavailable');
        /* 扩展实体: 移动侦测 → 红灯快闪（模型层面的反馈，不只标签） */
        motion = ctx.fieldOn('motionEntity');
        ledMat.emissive.setHex(online ? (motion ? 0xff2200 : 0xcc1100) : 0x000000);
      },
    };
    let t = 0, blink = 0;
    ctx.animate((dt) => {
      if (online && domeHead) {
        t += dt;
        domeHead.rotation.y = Math.sin(t * 0.5) * 0.6;   // 缓慢巡视
      }
      /* 侦测到移动: 红灯 3Hz 快闪；恢复常态常亮 */
      if (online) {
        if (motion) {
          blink += dt;
          ledMat.emissive.setHex(Math.sin(blink * 19) > 0 ? 0xff2200 : 0x2a0600);
        } else {
          ledMat.emissive.setHex(0xcc1100);
        }
      }
    });

    return api;
  },
});

})();
