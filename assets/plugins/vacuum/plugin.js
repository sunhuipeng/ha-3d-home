/*
 * vacuum — 扫地机器人插件（kind: 'device'，type: 'vacuum'）
 * 状态: state 不在 docked/off/unavailable/returning 时视为清扫中，状态环呼吸发光
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
 * 本插件用到: THREE、obj、cyl、lambert、getState、animate
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
  id: 'vacuum',
  kind: 'device',
  type: 'vacuum',
  name: '扫地机器人',
  styles: [
    { id: 'vacuum', name: '扫地机器人', z: 0.06, icon: ico('<circle cx="12" cy="10" r="6.5"/><circle cx="12" cy="10" r="2" opacity=".6"/><path d="M8 19.5 h8" opacity=".7"/><path d="M9.5 17 h5" opacity=".4"/>') },
  ],

  /* 扩展实体（可选）: 电量 / 清扫面积 / 耗材寿命，绑上后显示在标签上 */
  fields: [
    { key: 'batteryEntity', label: '电池电量', domains: ['sensor'], placeholder: 'sensor.xxx（%，可选）', tip: '低电量回充判断，标签显示 🔋' },
    { key: 'areaEntity', label: '清扫面积', domains: ['sensor'], placeholder: 'sensor.xxx（㎡，可选）', tip: '本次清扫面积' },
  ],

  /* 点击: 清扫中 → 回充；否则 → 开始清扫（vacuum.start / return_to_base） */
  click: {
    on: 'start',
    off: 'return_to_base',
    label: '开始清扫 / 回充',
  },

  /* 开/合判定（引擎唯一入口）: 清扫/回充/暂停都算「在干活」 */
  isOn(obj, get) {
    const st = obj && obj.entityId ? get(obj.entityId) : null;
    return !!st && ['cleaning', 'returning', 'paused'].includes(st.state);
  },

  /* 标签文案: 清扫机状态中文化 + 电量/面积 */
  stateText(st, obj, get) {
    if (!st) return '';
    const m = { cleaning: '清扫中', returning: '回充中', docked: '已回充', paused: '已暂停', idle: '空闲', error: '故障', off: '已关闭' };
    return PluginEngine.baseStateText(st, m) + PluginEngine.fieldBits(obj, get, [
      ['batteryEntity', (s, n) => (n != null ? (n <= 20 ? '⚠ ' : '🔋') + Math.round(n) + '%' : '')],
      ['areaEntity', (s, n) => (n != null ? Math.round(n) + '㎡' : '')],
    ]);
  },

  /* 2D 简笔: 扫地机俯视 —— 圆形机身 + 前向缓冲弧 + 激光头（机身 p.accent / 激光头 p.accent2 中性色） */
  plan2d(c, p) {
    const R = 0.165 * p.ppm;
    p.draw(() => { c.arc(0, 0, R, 0, Math.PI * 2) });
    c.beginPath(); c.arc(0, 0, R - 2.5, -Math.PI * 0.75, -Math.PI * 0.25);
    c.lineWidth = 2.6; c.strokeStyle = p.accent; c.stroke();
    c.beginPath(); c.arc(0, 0, Math.max(3, 0.045 * p.ppm), 0, Math.PI * 2);
    c.fillStyle = p.accent2; c.fill();
    return R + 2;
  },

  async model3d(ctx) {
    const d = ctx.obj;
    const g = new ctx.THREE.Group();

    // 扁圆盘机身 + 顶部雷达凸台
    ctx.cyl(g, 0.17, 0.17, 0.08, 24, 0, 0.04, 0, '#2f353c');
    ctx.cyl(g, 0.05, 0.05, 0.015, 16, 0, 0.088, 0, '#555c66');

    // 状态环（动态: 清扫时呼吸发光）
    const ringMat = ctx.lambert('#8fd19e');
    const ring = new ctx.THREE.Mesh(new ctx.THREE.TorusGeometry(0.155, 0.008, 8, 36), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.082;
    g.add(ring);

    let cleaning = false;
    const api = {
      group: g,
      update() {
        const st = ctx.getState(d.entityId);
        const s = st ? st.state : '';
        cleaning = !!s && !['docked', 'off', 'unavailable', 'returning'].includes(s);
      },
    };
    let t = 0;
    ctx.animate((dt) => {
      t += dt;
      ringMat.emissive.setHex(cleaning ? 0x22aa44 : 0x000000);
      if (cleaning) ringMat.emissive.setScalar(0.25 + Math.sin(t * 3) * 0.2);
    });

    return api;
  },
});

})();
