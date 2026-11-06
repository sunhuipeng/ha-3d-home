/*
 * sensor — 传感器插件（kind: 'device'，type: 'sensor'）
 * 状态: 实体 state 为 'on' 或 'detected' 时状态灯亮起并呼吸闪烁；纯数值传感器保持熄灭
 *
 * —— 参数速查（设备类插件通用；完整逐项说明见 assets/plugins/door/plugin.js 头部手册）——
 * 注册: id / kind:'device' / type（HA 实体类型，决定能绑哪类实体）/ name 必填
 *       styles 造型 [{ id, name, z（锚点离地高度,米）, labelOffset?, icon?, model?,
 *                      desc?（面板说明小字）, options?（样式参数 schema）}]
 *              面板/数据里的造型 id 会加 '<插件id>:' 前缀；插件里 ctx.style.id 仍是原始 id
 *       fields 扩展实体 [{ key, label, domains?, placeholder?, tip? }]
 *              绑上后值存 obj[key]，用 ctx.field*(key) 读；未绑定返回 null / ''
 *       click 点击控制 { on, off, label?, defaultOn?, feedback? }
 *              on/off 写服务名或 { domain, service }；「当前算不算开着」由顶层 isOn(obj, get) 判定；
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
 * 本插件用到: THREE、obj、style、box、cyl、lambert、getState、animate
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
  id: 'sensor',
  kind: 'device',
  type: 'sensor',
  name: '传感器',
  styles: [
    { id: 'sensor_round', name: '温湿度传感器',   z: 2.5, icon: ico('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" opacity=".6"/><line x1="12" y1="5" x2="12" y2="7" opacity=".6"/>') },
    { id: 'sensor_pir',   name: '人体存在传感器', z: 2.5, icon: ico('<circle cx="12" cy="10" r="4.5"/><path d="M5 18 a7 4 0 0 1 14 0" opacity=".6"/>') },
  ],

  /* 点击: 强制刷新读数（sensor 无控制类服务，用 homeassistant.update_entity 拉一次新值） */
  click: {
    on: { domain: 'homeassistant', service: 'update_entity' },
    off: { domain: 'homeassistant', service: 'update_entity' },
    label: '刷新读数',
    feedback: true,             // 刷新无可见状态变化，执行后给个 toast
  },

  /* 开/合判定（引擎唯一入口）: 传感器没有开合概念，恒 false → 点击永远走 on 分支（刷新读数） */
  isOn() { return false; },

  /* 扩展实体（可选）: 电池电量 / 同点湿度。
   * 很多传感器只把温度做成主实体，湿度、电量是独立实体，绑上后一起显示在标签上。 */
  fields: [
    { key: 'batteryEntity', label: '电池电量', domains: ['sensor'], placeholder: 'sensor.xxx（%，可选）', tip: '电量低于 20% 时标签会加 ⚠' },
    { key: 'humidityEntity', label: '湿度', domains: ['sensor'], placeholder: 'sensor.xxx（%，可选）', tip: '同一位置的湿度实体' },
  ],

  /* 标签文案: 数值带单位；二值传感器 on/off → 已触发/正常；再追加电量/湿度 */
  stateText(st, obj, get) {
    if (!st) return '';
    const at = st.attributes || {};
    let base;
    if (at.unit_of_measurement) base = st.state + ' ' + at.unit_of_measurement;
    else if (st.state === 'on') base = '已触发';
    else if (st.state === 'off') base = '正常';
    else base = st.state;
    return base + PluginEngine.fieldBits(obj, get, [
      ['humidityEntity', (s, n) => (n != null ? '湿度 ' + Math.round(n) + '%' : '')],
      ['batteryEntity', (s, n) => (n != null ? (n <= 20 ? '⚠ ' : '🔋') + Math.round(n) + '%' : '')],
    ]);
  },

  /* 2D 简笔: 按造型区分 —— sensor_round 圆形机身+波 / sensor_pir 方形机身+宽角感应扇 */
  plan2d(c, p) {
    const r = Math.max(6, 0.09 * p.ppm);
    if ((p.style || 'sensor_round') === 'sensor_pir') {
      const s = Math.max(10, 0.12 * p.ppm);
      p.draw(() => p.rrect(-s / 2, -s / 2, s, s, s * 0.25));
      c.lineWidth = 1.2;
      c.strokeStyle = p.accent2;
      [0.08, 0.14, 0.2].forEach((wr, i) => {
        c.beginPath();
        c.arc(0, 0, s / 2 + wr * p.ppm, -Math.PI / 2 - (1.2 - i * 0.2), -Math.PI / 2 + (1.2 - i * 0.2));
        c.stroke();
      });
      return s / 2 + 0.2 * p.ppm;
    }
    p.draw(() => { c.arc(0, 0, r, 0, Math.PI * 2) });
    c.beginPath(); c.arc(0, 0, r * 0.35, 0, Math.PI * 2);
    c.fillStyle = p.accent; c.fill();
    c.lineWidth = 1.2;
    c.strokeStyle = p.accent2;
    [r + 0.05 * p.ppm, r + 0.1 * p.ppm].forEach((wr, i) => {
      c.beginPath(); c.arc(0, 0, wr, -Math.PI / 2 - (0.9 - i * 0.25), -Math.PI / 2 + (0.9 - i * 0.25)); c.stroke();
    });
    return r + 0.1 * p.ppm;
  },

  async model3d(ctx) {
    const d = ctx.obj;
    const sid = (ctx.style || {}).id || 'sensor_round';
    const g = new ctx.THREE.Group();

    if (sid === 'sensor_pir') {
      // 人体存在: 方底座 + 半球罩
      ctx.box(g, 0.09, 0.025, 0.09, 0, 0, 0, '#e8eef5');
      const dome = new ctx.THREE.Mesh(
        new ctx.THREE.SphereGeometry(0.045, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        ctx.lambert('#dde6ee')
      );
      dome.position.y = 0.012;
      g.add(dome);
    } else {
      // 温湿度: 小圆饼
      ctx.cyl(g, 0.05, 0.05, 0.025, 20, 0, 0, 0, '#e8eef5');
    }

    // 状态灯（侧面小点，触发时呼吸）
    const ledMat = ctx.lambert('#8fd19e');
    ctx.cyl(g, 0.012, 0.012, 0.008, 12, sid === 'sensor_pir' ? 0.055 : 0, 0, sid === 'sensor_pir' ? 0 : 0.014, 0).material = ledMat;

    let active = false;
    const api = {
      group: g,
      update() {
        const st = ctx.getState(d.entityId);
        active = !!(st && (st.state === 'on' || st.state === 'detected'));
      },
    };
    let t = 0;
    ctx.animate((dt) => {
      t += dt;
      ledMat.emissive.setHex(active ? 0x22aa44 : 0x000000);
      if (active) ledMat.emissive.setScalar(0.3 + Math.sin(t * 4) * 0.25);
    });

    return api;
  },
});

})();
