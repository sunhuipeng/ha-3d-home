/*
 * light — 灯具插件（kind: 'device'，type: 'light'，7 种灯型）
 * 坐标系: group 原点 = 锚点（吸顶/筒灯=天花板面，吊灯=灯罩悬挂高度，壁灯=灯体中心，落地灯/灯带=各自高度）
 * 静态: 灯体可来自 obj.model / style.model 的 GLB；无 GLB 时按灯型程序化绘制
 * 状态: entityId on/off 控制灯泡发光 + 光晕 + 点光源，rgb_color 同步光色
 * 发光方向: 按灯型区分——吸顶灯/吊灯/筒灯向下锥形扩散（吊灯灯罩开口向下）、
 *   壁灯向墙外斜下、落地灯/灯带灯罩四周透光全向（见 lightKit opts.dir）
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
 * 本插件用到: THREE、obj、style、view、wallH、box、cyl、lambert、lightKit、getState、isOn
 * 扩展实体读取示例（key 换成你自己 fields 里声明的）：
 *   ctx.field('motionEntity')       // 'sensor.xxx' 或 null —— 拿实体 id 本身
 *   ctx.hasField('motionEntity')    // 是否已绑定
 *   ctx.fieldState('motionEntity')  // 完整状态对象，未绑返回 null
 *   ctx.fieldOn('motionEntity')     // bool，未绑 / 无该实体 → false
 *   ctx.fieldNum('motionEntity')    // 45.2；非数值、''、unknown、unavailable 一律 null
 *   ctx.fieldText('motionEntity')   // '45.2 W'；未绑 → ''
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
  id: 'light',
  kind: 'device',
  type: 'light',
  name: '灯',
  styles: [
    { id: 'ceiling_flat',  name: '平板吸顶灯', z: 2.78, icon: ico('<rect x="4" y="5" width="16" height="4.5" rx="1.2"/><line x1="8" y1="12.5" x2="6.5" y2="14.5" opacity=".55"/><line x1="12" y1="13.0" x2="12" y2="15.1" opacity=".55"/><line x1="16" y1="12.5" x2="17.5" y2="14.5" opacity=".55"/>') },
    { id: 'ceiling_round', name: '圆形吸顶灯', z: 2.78, icon: ico('<circle cx="12" cy="7.5" r="4.5"/><line x1="8" y1="14.5" x2="6.5" y2="16.5" opacity=".55"/><line x1="12" y1="15.0" x2="12" y2="17.1" opacity=".55"/><line x1="16" y1="14.5" x2="17.5" y2="16.5" opacity=".55"/>') },
    { id: 'downlight',     name: '筒灯/射灯',  z: 2.78, icon: ico('<circle cx="12" cy="8" r="4"/><circle cx="12" cy="8" r="1.3" fill="currentColor" stroke="none"/><line x1="8" y1="14.5" x2="6.5" y2="16.5" opacity=".55"/><line x1="12" y1="15.0" x2="12" y2="17.1" opacity=".55"/><line x1="16" y1="14.5" x2="17.5" y2="16.5" opacity=".55"/>') },
    { id: 'wall',          name: '壁灯',       z: 1.8, icon: ico('<line x1="4" y1="4" x2="4" y2="20"/><path d="M4 8 a5 5 0 0 1 0 10 z"/><line x1="10.5" y1="13" x2="14" y2="13" opacity=".55"/><line x1="10.5" y1="16" x2="13" y2="16" opacity=".55"/>') },
    { id: 'pendant',       name: '吊灯',       z: 2.25, icon: ico('<line x1="12" y1="3" x2="12" y2="8"/><path d="M7.5 8 h9 l-2 6 h-5 z"/><circle cx="12" cy="16.5" r="1.6" opacity=".7"/>') },
    { id: 'floor',         name: '落地灯',     z: 0, labelOffset: 1.75, icon: ico('<path d="M9.5 4 h5 l1.5 5.5 h-8 z"/><line x1="12" y1="9.5" x2="12" y2="19"/><line x1="8.5" y1="20" x2="15.5" y2="20"/>') },   // 标签挂到灯罩上方
    { id: 'strip',         name: '灯带',       z: 2.75, icon: ico('<line x1="3" y1="9" x2="21" y2="9" stroke-dasharray="3 2.4"/><line x1="5" y1="12.5" x2="6.5" y2="14.5" opacity=".55"/><line x1="10" y1="12.5" x2="11.5" y2="14.5" opacity=".55"/><line x1="15" y1="12.5" x2="16.5" y2="14.5" opacity=".55"/><line x1="19" y1="12.5" x2="20.5" y2="14.5" opacity=".55"/>') },
  ],

  /* 扩展实体（可选）: 人体感应 + 环境照度。
   * 绑上后标签会带"有人 / 320lx"，插件也据此判断环境亮度（如灭灯时提示现场照度）。
   * 未绑定就不显示，不影响原有行为。 */
  fields: [
    { key: 'motionEntity', label: '人体感应', domains: ['binary_sensor'], placeholder: 'binary_sensor.xxx（可选）', tip: 'on 视为有人，用于标签提示' },
    { key: 'luxEntity', label: '环境照度', domains: ['sensor'], placeholder: 'sensor.xxx（lx，可选）', tip: '显示现场亮度，便于判断该不该开灯' },
  ],

  /* 点击: 开（light.turn_on）/ 关（light.turn_off），state on/off 判定 */
  click: { on: 'turn_on', off: 'turn_off', label: '开 / 关' },

  /* 标签文案: 开灯时显示亮度百分比；扩展实体（有人/照度）追加在后 */
  stateText(st, obj, get) {
    if (!st) return '';
    const extra = PluginEngine.fieldBits(obj, get, [
      ['motionEntity', (s) => (s.state === 'on' ? '有人' : '')],
      ['luxEntity', (s, n) => (n != null ? Math.round(n) + 'lx' : '')],
    ]);
    if (st.state !== 'on') return PluginEngine.baseStateText(st, { off: '已关闭' }) + extra;
    const b = st.attributes && st.attributes.brightness;
    return (b != null ? Math.round((b / 255) * 100) + '% 亮度' : '已开启') + extra;
  },

  /* 2D 简笔: 按造型区分俯视图 —— ceiling_flat 方板 / ceiling_round 圆形吸顶 / downlight 筒灯 /
   * wall 壁灯 / pendant 吊灯 / floor 落地灯 / strip 灯带；未识别时按圆形吸顶画 */
  plan2d(c, p) {
    const ray = (r) => {
      c.lineWidth = 1.4;
      c.strokeStyle = p.accent;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        c.beginPath();
        c.moveTo(Math.cos(a) * (r + 2), Math.sin(a) * (r + 2));
        c.lineTo(Math.cos(a) * (r + 2 + 0.06 * p.ppm), Math.sin(a) * (r + 2 + 0.06 * p.ppm));
        c.stroke();
      }
    };
    const disc = (r) => {
      p.draw(() => { c.arc(0, 0, r, 0, Math.PI * 2) });
    };
    const sid = p.style || 'ceiling_round';
    if (sid === 'ceiling_flat') {
      const s = 0.4 * p.ppm;
      p.draw(() => p.rrect(-s / 2, -s / 2, s, s, s * 0.2));
      ray(s * 0.5);
      return s * 0.71 + 0.06 * p.ppm + 2;
    }
    if (sid === 'downlight') { const r = 0.075 * p.ppm; disc(r); ray(r); return r + 0.06 * p.ppm + 2; }
    if (sid === 'wall') {
      const r = 0.12 * p.ppm;
      p.draw(() => { c.arc(0, 0, r, Math.PI, 0); c.closePath() });
      ray(r);
      return r + 0.06 * p.ppm + 2;
    }
    if (sid === 'pendant') {
      const r = 0.12 * p.ppm;
      disc(r);
      c.beginPath(); c.arc(0, 0, r * 0.25, 0, Math.PI * 2);
      c.fillStyle = p.ink; c.fill();
      ray(r);
      return r + 0.06 * p.ppm + 2;
    }
    if (sid === 'floor') {
      const r = 0.13 * p.ppm;
      disc(r);
      c.beginPath(); c.arc(0, 0, r * 0.6, 0, Math.PI * 2);
      c.lineWidth = 1.3; c.strokeStyle = p.ink; c.stroke();
      return r + 3;
    }
    if (sid === 'strip') {
      const L = 0.5 * p.ppm;
      /* 贴合底条: 状态色只落在灯带轮廓内部（透明角落不着色） */
      c.beginPath();
      c.moveTo(-L / 2 + 3.2, -3.2);
      c.arcTo(L / 2, -3.2, L / 2, 3.2, 3.2);
      c.arcTo(L / 2, 3.2, -L / 2, 3.2, 3.2);
      c.arcTo(-L / 2, 3.2, -L / 2, -3.2, 3.2);
      c.arcTo(-L / 2, -3.2, L / 2, -3.2, 3.2);
      c.closePath();
      c.fillStyle = p.fill; c.fill();
      c.lineWidth = 1; c.strokeStyle = p.ink; c.stroke();
      c.setLineDash([6, 4]);
      c.lineWidth = 2.5;
      c.strokeStyle = p.accent2;
      c.beginPath(); c.moveTo(-L / 2 + 4, 0); c.lineTo(L / 2 - 4, 0); c.stroke();
      c.setLineDash([]);
      return L / 2 + 2;
    }
    const r = 0.15 * p.ppm;   /* ceiling_round / 缺省 */
    disc(r); ray(r);
    return r + 0.06 * p.ppm + 2;
  },

  async model3d(ctx) {
    const d = ctx.obj;
    const style = ctx.style || {};
    const sid = style.id || 'pendant';
    const g = new ctx.THREE.Group();
    let kit = null;

    /* 静态灯体: 优先自定义 GLB（设备绑定的 model 或造型自带 model） */
    const url = d.model || style.model;
    if (url && window.THREE.GLTFLoader) {
      const proto = await ctx.view.loadModel(url);
      if (proto) {
        const inst = proto.clone(true);
        const box = new ctx.THREE.Box3().setFromObject(inst);
        const size = box.getSize(new ctx.THREE.Vector3());
        const target = d.scale || 0.5;
        const s = target / Math.max(size.x, size.y, size.z) || 1;
        inst.scale.multiplyScalar(s);
        inst.position.y = -box.min.y * s;
        g.add(inst);
      }
    }

    /* 程序化灯体（无自定义 GLB 时）+ 灯光 kit */
    if (!url || !g.children.length) {
      const H = ctx.wallH;
      if (sid === 'ceiling_flat') {
        // 平板吸顶灯: 边框 + 发光面板；发光方向 = 向下大锥角扩散
        ctx.box(g, 0.6, 0.05, 0.6, 0, -0.025, 0, '#dfe4ea');
        const panelMat = ctx.lambert('#f5f7fa');
        ctx.box(g, 0.54, 0.03, 0.54, 0, -0.06, 0, 0).material = panelMat;
        kit = ctx.lightKit(g, -0.12, 0.9, { dir: 'down', angle: 1.05, strength: 0.85 });
        kit.addMat(panelMat);
      } else if (sid === 'ceiling_round') {
        // 圆形吸顶灯: 圆环底座 + 半球灯罩；向下大锥角扩散
        ctx.cyl(g, 0.34, 0.34, 0.04, 28, 0, -0.02, 0, '#dfe4ea');
        const domeMat = ctx.lambert('#f5f7fa');
        const dome = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.3, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
        dome.position.y = -0.04;
        dome.rotation.x = Math.PI;
        g.add(dome);
        kit = ctx.lightKit(g, -0.14, 0.95, { dir: 'down', angle: 1.05, strength: 0.85 });
        kit.addMat(domeMat);
      } else if (sid === 'downlight') {
        // 筒灯/射灯: 嵌入圆环 + 内发光；向下窄锥角聚光（光斑集中）
        ctx.cyl(g, 0.1, 0.1, 0.045, 20, 0, -0.02, 0, '#cfd6de');
        const innerMat = ctx.lambert('#f5f7fa');
        ctx.cyl(g, 0.075, 0.06, 0.05, 20, 0, -0.05, 0, 0).material = innerMat;
        kit = ctx.lightKit(g, -0.1, 0.45, { dir: 'down', angle: 0.5, dist: 4.5, strength: 1.15 });
        kit.addMat(innerMat);
      } else if (sid === 'wall') {
        // 壁灯: 背板 + 支臂 + 半球罩（灯体探出墙面）；发光方向 = 向墙外斜向下
        const plate = ctx.cyl(g, 0.05, 0.05, 0.03, 16, 0, 0, 0.02, '#cfd6de');
        plate.rotation.x = Math.PI / 2;
        const arm = ctx.cyl(g, 0.015, 0.015, 0.12, 8, 0, 0.02, 0.09, '#9aa3ad');
        arm.rotation.x = Math.PI / 2;
        const shadeMat = ctx.lambert('#f0f2f5', { side: ctx.THREE.DoubleSide });
        const shade = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.13, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), shadeMat);
        shade.position.set(0, 0.02, 0.16);
        shade.rotation.x = Math.PI;
        g.add(shade);
        kit = ctx.lightKit(g, -0.02, 0.55, { dir: 'wall', angle: 0.85, strength: 0.95 });
        kit.addMat(shadeMat);
        g.position.z = 0.14;
      } else if (sid === 'floor') {
        // 落地灯: 底盘 + 立杆 + 灯罩（锚点在地面）；灯罩四周透光 = 全向
        ctx.cyl(g, 0.16, 0.18, 0.03, 24, 0, 0.015, 0, '#3a4048');
        ctx.cyl(g, 0.018, 0.018, 1.3, 10, 0, 0.68, 0, '#555c66');
        const shadeMat = ctx.lambert('#f0e6d4', { side: ctx.THREE.DoubleSide });
        const shade = new ctx.THREE.Mesh(new ctx.THREE.CylinderGeometry(0.14, 0.2, 0.28, 24, 1, true), shadeMat);
        shade.position.y = 1.45;
        g.add(shade);
        kit = ctx.lightKit(g, 1.42, 0.8, { dir: 'omni' });
        kit.addMat(shadeMat);
      } else if (sid === 'strip') {
        // 灯带: 细长发光条；沿条四面透光 = 全向
        const stripMat = ctx.lambert('#f5f7fa');
        ctx.box(g, 1.2, 0.018, 0.05, 0, 0, 0, 0).material = stripMat;
        kit = ctx.lightKit(g, -0.05, 0.7, { dir: 'omni' });
        kit.addMat(stripMat);
      } else {
        // 吊灯: 吊线（锚点=灯罩高度，线向上到天花板）+ 灯罩；灯罩开口向下 = 向下大锥角扩散
        const cordLen = Math.max(0.1, H - (d.z != null ? d.z : style.z || 2.25));
        ctx.cyl(g, 0.012, 0.012, cordLen, 6, 0, cordLen / 2, 0, '#555555');
        const shade = new ctx.THREE.Mesh(new ctx.THREE.ConeGeometry(0.24, 0.24, 24, 1, true), ctx.lambert('#3a4048', { side: ctx.THREE.DoubleSide }));
        g.add(shade);
        kit = ctx.lightKit(g, -0.09, 0.85, { dir: 'down', angle: 0.95, strength: 0.9 });
      }
    } else {
      // 自定义 GLB 灯体也配灯光 kit（默认向下扩散，吸顶/吊灯类通用）
      kit = ctx.lightKit(g, 0.05, 0.7, { dir: 'down', angle: 1.0, strength: 0.7 });
    }

    const rgb = () => {
      const st = ctx.getState(d.entityId);
      return st && st.attributes && st.attributes.rgb_color;
    };
    return {
      group: g,
      update() { if (kit) kit.set(ctx.isOn(d.entityId), rgb()); },
    };
  },
});

})();
