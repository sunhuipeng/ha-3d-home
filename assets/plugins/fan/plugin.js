/*
 * fan — 落地扇插件（kind: 'device'，type: 'fan'）
 * 状态: on 时扇叶旋转（读 percentage 属性调节转速），off 减速停下
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
 * 本插件用到: THREE、obj、box、cyl、getState、isOn、animate
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
  id: 'fan',
  kind: 'device',
  type: 'fan',
  name: '风扇',
  styles: [
    { id: 'fan_stand', name: '落地扇', z: 0, icon: ico('<circle cx="12" cy="8" r="4.5"/><circle cx="12" cy="8" r="1.2" opacity=".6"/><line x1="12" y1="12.5" x2="12" y2="19"/><line x1="8.5" y1="20" x2="15.5" y2="20"/>') },
  ],

  /* 扩展实体（可选）: 室温 / 湿度，绑上后标签显示环境数据（判断要不要开风扇） */
  fields: [
    { key: 'tempEntity', label: '室温', domains: ['sensor', 'climate'], placeholder: 'sensor.xxx（°C，可选）', tip: '显示当前室温' },
    { key: 'humidityEntity', label: '湿度', domains: ['sensor'], placeholder: 'sensor.xxx（%，可选）', tip: '显示当前湿度' },
  ],

  /* 点击: 开 / 关（fan.toggle） */
  click: { on: 'turn_on', off: 'turn_off', label: '开 / 关' },

  /* 标签文案: 运行中显示风速百分比 + 室温/湿度 */
  stateText(st, obj, get) {
    if (!st) return '';
    const base = st.state !== 'on'
      ? PluginEngine.baseStateText(st, { off: '已关闭' })
      : (() => {
        const p = st.attributes && st.attributes.percentage;
        return p != null ? '风速 ' + p + '%' : '已开启';
      })();
    return base + PluginEngine.fieldBits(obj, get, [
      ['tempEntity', (s, n) => (n != null ? Math.round(n * 10) / 10 + '°' : '')],
      ['humidityEntity', (s, n) => (n != null ? Math.round(n) + '%' : '')],
    ]);
  },

  /* 2D 简笔: 落地扇俯视 —— 护网圆 + 三叶扇（扇叶用 p.accent 中性色，开/关只体现在 p.fill） */
  plan2d(c, p) {
    const R = 0.2 * p.ppm;
    p.draw(() => { c.arc(0, 0, R, 0, Math.PI * 2) });
    c.fillStyle = p.accent;
    for (let i = 0; i < 3; i++) {
      const a = i * 2 * Math.PI / 3;
      c.beginPath();
      c.ellipse(Math.cos(a) * R * 0.45, Math.sin(a) * R * 0.45, R * 0.38, R * 0.16, a, 0, Math.PI * 2);
      c.fill();
    }
    c.beginPath(); c.arc(0, 0, 2.2, 0, Math.PI * 2);
    c.fillStyle = p.ink; c.fill();
    return R + 2;
  },

  async model3d(ctx) {
    const d = ctx.obj;
    const g = new ctx.THREE.Group();

    // 底盘 + 立杆 + 网罩（静态）
    ctx.cyl(g, 0.14, 0.16, 0.03, 20, 0, 0.015, 0, '#3a4048');
    ctx.cyl(g, 0.02, 0.02, 1.1, 10, 0, 0.58, 0, '#555c66');
    ctx.cyl(g, 0.16, 0.16, 0.06, 20, 0, 1.18, 0, '#dfe4ea').rotation.x = Math.PI / 2;

    // 扇叶（动态）: 三叶十字
    const blades = new ctx.THREE.Group();
    blades.position.set(0, 1.18, 0.045);
    for (let i = 0; i < 3; i++) {
      const b = ctx.box(blades, 0.035, 0.26, 0.015, 0, 0, 0, '#c9d2dc');
      b.rotation.z = (i * Math.PI * 2) / 3;
      b.position.set(Math.sin((i * Math.PI * 2) / 3) * 0.11, Math.cos((i * Math.PI * 2) / 3) * 0.11, 0);
    }
    g.add(blades);

    let on = false, speed = 1;
    const api = {
      group: g,
      update() {
        on = ctx.isOn(d.entityId);
        const st = ctx.getState(d.entityId);
        const pct = st && st.attributes && st.attributes.percentage;
        speed = pct ? Math.max(0.3, pct / 100) : 1;
      },
    };
    let vel = 0;
    ctx.animate((dt) => {
      const target = on ? 9 * speed : 0;
      vel += (target - vel) * Math.min(1, dt * 1.5);   // 起转/减速惯性
      blades.rotation.z -= vel * dt;
    });

    return api;
  },
});

})();
