/*
 * switch — 开关/插座插件（kind: 'device'，type: 'switch'）
 * 坐标系: group 原点 = 墙面锚点（+Z 朝室内）
 * 状态: 墙壁开关翘板随 on/off 翻转（缓动）；插座通电时指示孔发光
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
 * 本插件用到: THREE、obj、style、box、lambert、isOn、animate
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
  id: 'switch',
  kind: 'device',
  type: 'switch',
  name: '开关/插座',
  styles: [
    { id: 'wall_switch', name: '墙壁开关', z: 1.3, icon: ico('<rect x="7" y="4" width="10" height="16" rx="1.5"/><circle cx="12" cy="9" r="1.6" fill="currentColor" stroke="none"/><line x1="9.5" y1="14" x2="14.5" y2="14"/>') },
    { id: 'plug',        name: '智能插座', z: 0.35, icon: ico('<rect x="8" y="4" width="8" height="13" rx="2"/><line x1="10.5" y1="8" x2="10.5" y2="11"/><line x1="13.5" y1="8" x2="13.5" y2="11"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="17" x2="12" y2="20"/>') },
  ],

  /* 扩展实体（可选）: 功率 / 电量，绑上后标签显示实时功耗与累计电量 */
  fields: [
    { key: 'powerEntity', label: '功率', domains: ['sensor'], placeholder: 'sensor.xxx（W，可选）', tip: '插座/开关所接负载的实时功率' },
    { key: 'energyEntity', label: '电量', domains: ['sensor'], placeholder: 'sensor.xxx（kWh，可选）', tip: '累计用电量（今日或总量）' },
  ],

  /* 点击: 开 / 关（switch.toggle 双向切换） */
  click: { on: 'turn_on', off: 'turn_off', label: '开 / 关' },

  /* 标签文案: 开关状态 + 功率/电量 */
  stateText(st, obj, get) {
    if (!st) return '';
    const base = PluginEngine.baseStateText(st);
    return base + PluginEngine.fieldBits(obj, get, [
      ['powerEntity', (s, n) => (n != null ? Math.round(n) + 'W' : '')],
      ['energyEntity', (s, n) => (n != null ? n.toFixed(1) + 'kWh' : '')],
    ]);
  },

  /* 2D 简笔: 按造型区分 —— wall_switch 开关面板（方面板+按键）/ plug 插座（面板+二孔+地极） */
  plan2d(c, p) {
    const s = Math.max(14, 0.16 * p.ppm);
    p.draw(() => p.rrect(-s / 2, -s / 2, s, s, s * 0.22));
    if ((p.style || 'wall_switch') === 'plug') {
      c.lineWidth = 1.4;
      c.strokeStyle = p.accent2;
      c.beginPath(); c.moveTo(-s * 0.14, -s * 0.22); c.lineTo(-s * 0.14, -s * 0.02); c.stroke();
      c.beginPath(); c.moveTo(s * 0.14, -s * 0.22); c.lineTo(s * 0.14, -s * 0.02); c.stroke();
      c.beginPath(); c.moveTo(-s * 0.14, s * 0.14); c.lineTo(s * 0.14, s * 0.14); c.stroke();
    } else {
      c.beginPath(); c.arc(0, 0, s * 0.2, 0, Math.PI * 2);
      c.fillStyle = p.accent; c.fill();
    }
    return s * 0.72;
  },

  async model3d(ctx) {
    const d = ctx.obj;
    const sid = (ctx.style || {}).id || 'wall_switch';
    const g = new ctx.THREE.Group();

    if (sid === 'plug') {
      // 智能插座: 低处小面板 + 通电指示孔
      ctx.box(g, 0.08, 0.08, 0.03, 0, 0, 0.02, '#f0f2f5');
      const ledMat = ctx.lambert('#f5f7fa');
      ctx.box(g, 0.016, 0.016, 0.012, 0, 0, 0.038, 0).material = ledMat;
      return {
        group: g,
        update() { ledMat.emissive.setHex(ctx.isOn(d.entityId) ? 0x33cc66 : 0x000000); },
      };
    }

    // 墙壁开关: 中屏 + 翘板（on/off 翻转）
    ctx.box(g, 0.086, 0.086, 0.025, 0, 0, 0.012, '#f0f2f5');
    const rockerMat = ctx.lambert('#d3d9e0');
    const rocker = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.05, 0.05, 0.02), rockerMat);
    rocker.position.z = 0.032;
    g.add(rocker);

    let on = false;
    const api = {
      group: g,
      update() { on = ctx.isOn(d.entityId); },
    };
    ctx.animate((dt) => {
      const t = on ? -0.14 : 0.14;                       // 翘板倾角
      rocker.rotation.x += (t - rocker.rotation.x) * Math.min(1, dt * 8);
    });
    rocker.rotation.x = on ? -0.14 : 0.14;

    return api;
  },
});

})();
