/*
 * cover — 窗帘插件（kind: 'device'，type: 'cover'）
 *
 * 坐标系: group 原点 = 轨道中心（锚点高度 = styles.z 指定的轨道离地高度）
 * 状态: cover 实体 state === 'open' → 窗帘收拢到一侧；'closed' → 完全展开；缓动过渡
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
 * 本插件用到: THREE、obj、box、cyl、lambert、getState、animate
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
  id: 'cover',
  kind: 'device',
  type: 'cover',
  name: '窗帘',
  styles: [
    { id: 'curtain', name: '窗帘', z: 1.4, icon: ico('<line x1="4" y1="4" x2="20" y2="4"/><path d="M5 4 q-1 8 2 16 M19 4 q1 8 -2 16"/><path d="M9 4 q-.5 8 1 16 M15 4 q.5 8 -1 16" opacity=".5"/>') },
  ],

  /* 扩展实体（可选）: 环境照度 / 雨感。窗帘开合的判断依据，绑上后一起显示在标签上 */
  fields: [
    { key: 'luxEntity', label: '环境照度', domains: ['sensor'], placeholder: 'sensor.xxx（lx，可选）', tip: '显示当前光照，便于判断要不要拉窗帘' },
    { key: 'rainEntity', label: '雨感', domains: ['binary_sensor', 'weather'], placeholder: 'binary_sensor.xxx（可选）', tip: 'on=有雨，标签会提示' },
  ],

  /* 点击: 开 / 关（cover.open_cover / close_cover） */
  click: {
    on: 'open_cover',
    off: 'close_cover',
    label: '打开 / 关闭',
  },

  /* 开/合判定（引擎唯一入口）: state=open 或 current_position>0 视为已打开 */
  isOn(obj, get) {
    const st = obj && obj.entityId ? get(obj.entityId) : null;
    return !!st && (st.state === 'open' || !!(st.attributes && st.attributes.current_position > 0));
  },

  /* 标签文案: 开合状态 / 开度 + 照度/雨感 */
  stateText(st, obj, get) {
    if (!st) return '';
    const m = { open: '已打开', closed: '已关闭', opening: '打开中', closing: '关闭中' };
    let base = m[st.state];
    if (!base) {
      const p = st.attributes && st.attributes.current_position;
      base = p != null ? '开度 ' + p + '%' : st.state;
    }
    return base + PluginEngine.fieldBits(obj, get, [
      ['luxEntity', (s, n) => (n != null ? Math.round(n) + 'lx' : '')],
      ['rainEntity', (s) => (s.state === 'on' || s.state === 'rainy' ? '有雨' : '')],
    ]);
  },

  /* 2D 简笔: 窗帘俯视 —— 贴合底条（窗轨）+ 垂坠布褶波浪（状态色只落在底条内部） */
  plan2d(c, p) {
    const w = Math.max(40, 0.9 * p.ppm);
    c.beginPath();
    c.moveTo(-w / 2 + 3, -3);
    c.arcTo(w / 2, -3, w / 2, 3, 3);
    c.arcTo(w / 2, 3, -w / 2, 3, 3);
    c.arcTo(-w / 2, 3, -w / 2, -3, 3);
    c.arcTo(-w / 2, -3, w / 2, -3, 3);
    c.closePath();
    c.fillStyle = p.fill; c.fill();
    c.lineWidth = 2.4; c.strokeStyle = p.ink; c.stroke();
    const n = 5, seg = w / n;
    c.lineWidth = 1.4;
    c.strokeStyle = p.accent2;
    for (let i = 0; i < n; i++) {
      c.beginPath(); c.arc(-w / 2 + seg * (i + 0.5), 2, seg / 2, 0, Math.PI); c.stroke();
    }
    return w / 2;
  },

  async model3d(ctx) {
    const g = new ctx.THREE.Group();

    // 轨道（静态）
    ctx.box(g, 1.6, 0.03, 0.05, 0, 0, 0, '#9aa3ad');

    // 垫圈环扣装饰
    for (let i = -2; i <= 2; i++) ctx.cyl(g, 0.015, 0.015, 0.04, 8, i * 0.3, -0.03, 0, '#b9c2cc');

    // 帘布（动态: 沿 X 收拢/展开）
    const clothMat = ctx.lambert('#cfd9e4', { transparent: true, opacity: 0.75 });
    const cloth = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(1.55, 1.6, 0.04), clothMat);
    cloth.position.y = -0.82;
    g.add(cloth);

    let openRatio = 0;   // 0=闭合 1=全开
    const api = {
      group: g,
      update() {
        const st = ctx.getState(ctx.obj.entityId);
        if (!st) return;
        if (st.state === 'open') openRatio = 1;
        else if (st.state === 'closed') openRatio = 0;
        else if (/^([0-9]+)/.test(st.state)) openRatio = Math.min(1, Math.max(0, parseInt(st.state, 10) / 100));  // 数值状态当作位置百分比: 0=闭合、100=全开
      },
    };
    ctx.animate((dt) => {
      const targetX = 0.12 + (1 - openRatio) * 0.88;    // 收拢后宽度 12%
      cloth.scale.x += (targetX - cloth.scale.x) * Math.min(1, dt * 2.5);
      // 收拢时布料移向左侧轨道端
      const targetPos = -(1.55 - (1.55 * cloth.scale.x)) / 2;
      cloth.position.x += (targetPos - cloth.position.x) * Math.min(1, dt * 2.5);
    });

    return api;
  },
});

})();
