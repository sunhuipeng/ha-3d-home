/*
 * wardrobe — 衣柜（家具类参考示例：type:'furniture'）
 *
 * ============================================================================
 * 这个插件演示什么
 * ============================================================================
 * 家具通常是「静态的」——放着不动、没有 HA 实体。但如果它的外形要随用户选择变化
 * （单开/双开门、不同高度、不同长度），用一张静态 GLB 就做不到，这时候就该把家具做成
 * **家具插件**：`kind:'device'` + `type:'furniture'`，用 `model3d(ctx)` 按参数现场建模。
 *
 * 和普通家具（`floors.furniture` 里 `mid` → 目录静态 GLB）的区别：
 *   · 普通家具  实例存 floors.furniture，`mid` 指向 assets/models 里的固定 GLB
 *   · 家具插件  实例存 floors.devices（和灯/门/窗同一张表），`type:'furniture'`，
 *               `style` 指向插件造型，`styleOpts` 存参数（本插件的 高度/长度/宽度(进深)）
 * 放置方式（示例，写进 data/project.json 的楼层里即可；也可由 MCP / 后续的放置面板生成）：
 *
 *   "devices": [{
 *     "id": "d_wardrobe_1", "type": "furniture",
 *     "x": 2.4, "y": 1.6, "rot": 0,
 *     "style": "wardrobe:swing",
 *     "styleOpts": { "h": 2.2, "len": 1.8, "dep": 0.6 }
 *   }]
 *
 * 三个参数都是 styles[].options 里的滑块（range），改一次 → 属性面板防抖 commit →
 * View3D.rebuild → 本插件 model3d 重新跑一遍，于是柜体尺寸和门数立刻重算。
 * 同造型的不同实例各存各的 styleOpts，A 柜 1.8m 三门、B 柜 0.8m 单门互不影响。
 *
 * ============================================================================
 * 门数怎么来的（本示例的重点）
 * ============================================================================
 * 门数**不是**一个单独的参数，而是由长度推出来的（见 doorsOf）：
 *   每扇门约 0.55m 宽，门数 = round(长度 / 0.55)，夹在 1~6 之间。
 *   0.6m→1 扇 · 1.2m→2 扇 · 1.8m→3 扇 · 2.4m→4 扇 · 3.0m→5 扇
 * 这样「调长度」这一个动作就同时改变了柜体宽度、每扇门的宽度和门数，用户不用再单独选门数。
 * 门板宽度 =（柜内净宽 − 门缝总和）/ 门数，所以每扇门永远等宽、正好铺满正面。
 *
 * ============================================================================
 * 家具类型的三条缺省行为（引擎已内置，插件不用写）
 * ============================================================================
 *   · 无 3D 标签   type:'furniture' 的 labels 缺省 false（柜子上方挂状态牌很怪）
 *   · 不可点击     CLICK_DEFAULTS 不含 furniture —— 本插件不声明 click 就点不动，
 *                  也不会向 HA 发任何服务（家具本来就没有可控实体）
 *   · 贴地         devY 对 furniture 返回 def.z（本插件声明 z:0），不会像吊灯那样浮空
 * ============================================================================
 */
'use strict';

/* 包一层 IIFE：插件是独立 <script> 加载的经典脚本，顶层 const 会与其他插件共享全局作用域，
 * 重名会直接 SyntaxError（整个插件失效）。所有辅助函数/常量都写在函数作用域内。 */
(function () {

const ico = PluginEngine.ico;
const ICON = ico('<path d="M5 3h14v18H5z"/><line x1="12" y1="3" x2="12" y2="21"/>'
  + '<circle cx="9.6" cy="12" r=".7"/><circle cx="14.4" cy="12" r=".7"/>');

/* ---------------- 尺寸与门数：唯一的「参数 → 几何」换算入口 ---------------- */

/* 参数可能来自面板、MCP 或手改的 project.json，一律夹取到合法区间，
 * 免得一个 0 或者字符串把几何算成 NaN（NaN 的 Mesh 会整块消失，很难查） */
function clamp(v, min, max, dft) {
  const n = parseFloat(v);
  if (!isFinite(n)) return dft;
  return Math.min(max, Math.max(min, n));
}

const DOOR_W = 0.55;   // 每扇门的参考宽度（米）：门数由它和长度推出来
const DOOR_MIN = 1;
const DOOR_MAX = 6;

/* 长度 → 门数：1.8m 三门、2.4m 四门…（详见文件头说明）。
 * 换个口径只改这一行，3D 与 2D 会同时跟着变（两边都调它）。 */
function doorsOf(len) {
  return Math.max(DOOR_MIN, Math.min(DOOR_MAX, Math.round(len / DOOR_W)));
}

/* ---------------- 参数表：面板滑块与几何夹取的唯一来源 ----------------
 * 三个参数的 label / min / max / step / def 只写在这一处：styles[].options 由它生成，
 * dimsOf() 也按同一份边界夹取。
 * ⚠ 别在 options 和 dimsOf 里各写一份边界 —— 只改 options 的 max 是最容易踩的坑：
 *   滑块能拖到 4m，几何却仍被 dimsOf 的旧上限（2.8m）夹住，看起来像「改了没用」。 */
const P = {
  h:   { label: '高度 (m)',      min: 1.6,  max: 4, step: 0.05, def: 2.2 },
  len: { label: '长度 (m)',      min: 0.6,  max: 4, step: 0.1,  def: 1.8 },
  dep: { label: '宽度/进深 (m)', min: 0.45, max: 4, step: 0.05, def: 0.6 },
};
/* styles[].options 直接从参数表生成，顺序 = P 的键顺序（高度 / 长度 / 进深） */
const OPTIONS = Object.keys(P).map((key) => Object.assign({ key, type: 'range' }, P[key]));

/* 参数 → 柜体三围 + 门数。边界与默认值全部取自 P，与面板滑块永远一致 */
function dimsOf(o) {
  o = o || {};
  const L = clamp(o.len, P.len.min, P.len.max, P.len.def);   // 长度 = 柜体宽（局部 X）
  const H = clamp(o.h, P.h.min, P.h.max, P.h.def);           // 高度 = 柜体高（局部 Y）
  const D = clamp(o.dep, P.dep.min, P.dep.max, P.dep.def);   // 深度 = 柜体厚（局部 Z）
  return { L, H, D, n: doorsOf(L) };
}

/* ---------------- 3D：按参数现场拼一个柜子 ---------------- */

/* 板厚/门缝/踢脚：都是真实家具上的可见细节，写死即可，不做成参数（参数越多面板越难用） */
const PANEL = 0.02;      // 板厚
const GAP = 0.005;       // 门缝
const PLINTH = 0.07;     // 踢脚高度

function buildWardrobe(ctx) {
  const T = ctx.THREE;
  const d = dimsOf(ctx.options);
  const L = d.L, H = d.H, D = d.D, n = d.n;

  /* 配色：柜体（侧板/顶底板）偏深、门板偏浅、背板最暗，正对着光看层次才清楚 */
  const C_BODY = '#c8b49a';
  const C_DOOR = '#e0d2bb';
  const C_BACK = '#a99478';
  const C_HANDLE = '#8d7a5f';

  const g = new T.Group();

  /* 柜体骨架：原点在柜体底面中心（引擎负责把 group 摆到 obj.x/obj.y 并抬到 devY=0） */
  ctx.box(g, L, PANEL, D, 0, PANEL / 2, 0, C_BODY);                        // 底板
  ctx.box(g, L, PANEL, D, 0, H - PANEL / 2, 0, C_BODY);                    // 顶板
  ctx.box(g, PANEL, H - PANEL * 2, D, -L / 2 + PANEL / 2, H / 2, 0, C_BODY);  // 左侧板
  ctx.box(g, PANEL, H - PANEL * 2, D, L / 2 - PANEL / 2, H / 2, 0, C_BODY);   // 右侧板
  ctx.box(g, L - PANEL * 2, H - PANEL * 2, 0.012, 0, H / 2, -D / 2 + 0.006, C_BACK);  // 背板

  /* 踢脚：门板下方内收一条，柜体就不会像直接坐在地板上 */
  ctx.box(g, L - PANEL * 2, PLINTH, 0.016, 0, PLINTH / 2, D / 2 - 0.03, C_BACK);

  /* 门板区：从踢脚上沿到顶板下沿，n 扇等宽（扣掉门缝）铺满整个正面 */
  const inner = L - PANEL * 2;             // 柜内净宽
  const y0 = PLINTH + 0.004;
  const y1 = H - PANEL - 0.004;
  const dh = y1 - y0;
  const cy = (y0 + y1) / 2;
  const dw = (inner - (n - 1) * GAP) / n;  // 每扇门宽
  const x0 = -L / 2 + PANEL;               // 第一扇门的左边缘

  for (let i = 0; i < n; i++) {
    const x = x0 + i * (dw + GAP) + dw / 2;
    ctx.box(g, dw, dh, 0.02, x, cy, D / 2 + 0.01, C_DOOR);

    /* 拉手：贴在两扇门相遇的那一侧 —— 偶数号门靠右、奇数号门靠左，两两成对；
     * 单门（n=1）靠右。这样不管几扇门，视觉上都是「成对的把手」，不会一边倒 */
    const sign = n === 1 ? 1 : (i % 2 === 0 ? 1 : -1);
    ctx.box(g, 0.014, 0.18, 0.012, x + sign * (dw / 2 - 0.03), cy + 0.04, D / 2 + 0.026, C_HANDLE);
  }

  /* 静态家具：没有实体、没有开合动画，只返回 group 就够（引擎会补 update/dispose 空实现）。
   * 如果以后想让柜门响应门磁，在这里加 update() + ctx.animate() 即可，契约与 door 插件一致。 */
  return { group: g };
}

/* ---------------- 2D 平面符号（俯视：矩形柜体 + 前缘门板带 + 门缝分格） ----------------
 * 编辑器已把画布平移到设备锚点、按 rot 旋转好（局部 +Y = 局部 +Z = 柜子正面），
 * 所以这里以原点为中心画，尺寸一律「米 × p.ppm」。
 * 颜色只用抽象层的 p.fill / p.ink / p.accent（家具没有实体，p.ink 不再是「未连接红」） */
function planWardrobe(c, p) {
  const d = dimsOf(p.options);
  const pw = d.L * p.ppm;     // 宽（X）
  const pd = d.D * p.ppm;     // 深（Y）
  const n = d.n;

  /* 柜体：状态色填在封闭矩形内部（关=白 / 开=暖琥珀；家具恒为关，即白） */
  c.fillStyle = p.fill || '#fff';
  c.strokeStyle = p.ink || '#2a3346';
  c.lineWidth = p.lw || 1.6;
  c.fillRect(-pw / 2, -pd / 2, pw, pd);
  c.strokeRect(-pw / 2, -pd / 2, pw, pd);

  /* 前缘门板带：贴前边（+Y）一条窄带，让平面图一眼看出柜门朝哪一侧 */
  const t = Math.max(2, Math.min(pd * 0.2, 0.05 * p.ppm));
  const fy = pd / 2 - t;
  c.fillStyle = p.accent || '#c3cad6';
  c.fillRect(-pw / 2, fy, pw, t);
  c.strokeStyle = p.ink || '#2a3346';
  c.strokeRect(-pw / 2, fy, pw, t);

  /* 门缝分格：门数变了，竖线数量跟着变（这条线就是「几扇门」在平面图上的表达） */
  if (n > 1) {
    c.beginPath();
    for (let i = 1; i < n; i++) {
      const x = -pw / 2 + (pw * i) / n;
      c.moveTo(x, fy);
      c.lineTo(x, pd / 2);
    }
    c.stroke();
  }

  /* 返回包围半径（像素）：编辑器据此画选中虚线圈 */
  return Math.hypot(pw, pd) / 2 + 2;
}

/* ---------------- 注册 ---------------- */
PluginEngine.register({
  builtin: true,        // 内置插件标记（custom/ 下的自定义插件不带这行）
  id: 'wardrobe',
  kind: 'device',       // 家具不是新 kind，仍然是 device，靠 type 区分
  type: 'furniture',    // 家具类型：无 HA 实体、缺省无标签、缺省不可点、贴地
  ftype: 'cabinet',     // 家具分类：对应 assets/catalog.json 的 types 键（柜架）——
                        // 属性面板标题据此显示「柜架 · 平开门衣柜」，家具库也能按分类归组。
                        // 可选字段，没写就只显示「家具」；styles[].ftype 可逐个造型覆盖。
  name: '衣柜',

  z: 0,                 // 锚点离地高度：家具贴地（引擎对 furniture 读这个声明，缺省也是 0）
  hitY: 1.0,            // 保底拾取热球球心高度（柜体中部，1.0m 落在任何高度档位内）
  placeholder: { w: 1.8, h: 2.2, color: 0xdcd0bd, y: 1.1 },   // 插件加载失败时的占位薄板

  plan2d: planWardrobe,
  styles: [
    {
      id: 'swing',
      name: '平开门衣柜',
      desc: '高度/长度/宽度(进深)可调；门数按长度自动计算（每扇约 0.55m，1~6 扇）',
      icon: ICON,
      /* 样式参数：面板改一次 → 存实例 obj.styleOpts → 插件在 ctx.options / p.options 读到
       * 「默认值 ∪ 已存值」的合并结果，所以插件里不用给缺省值兜底。
       * 命名口径：长度 = 正面跨度（决定门数），宽度 = 进深（柜子厚度，平面图的 Y 向） */
      options: OPTIONS,
    },
  ],

  /* 无 fields（家具不绑实体）、无 click（缺省不可点）、无 isOn（平面图恒为「关」白底） */
  model3d: buildWardrobe,
});

})();
