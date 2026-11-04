/*
 * window — 窗户插件（推拉窗 / 对开窗，kind: 'opening'）
 *
 * 坐标系: group 原点 = 窗洞地面投影中心（墙面线上），Y 为绝对高度（窗台 0.9 → 窗顶 2.1）
 * 组合: frame.glb(静态窗框) + 玻璃扇(代码网格, 半透明)，两种造型:
 *   - sliding 推拉窗: 固定扇占左半、活动扇占右半，沿轨道水平滑动重叠
 *   - double  对开窗: 两扇铰链在左右两端，绕竖轴向外旋转开启（平开窗）
 * 绑定:
 *   - entityId   开关实体 on/off（或 open/closed）: on=开窗
 *   - posEntityId 开度实体（数值状态）: 表示开了多少
 *       ≤1 按小数比例（0.4=40%），>1 按百分比（40=40%），钳制 0~100%
 * 开度优先级: 开关 off → 必关；开关 on → 开度实体有值用其比例，无则全开(100%)；
 *            只绑开度实体不绑开关 → 直接按开度；两个都没绑 → 常闭
 *
 * —— 参数速查（门窗类插件通用；完整逐项说明见 assets/plugins/door/plugin.js 头部手册）——
 * 注册: id / kind:'opening' / type（洞口类型：'door' 或 'window'）/ name 必填
 *       type 在门窗里的含义是「洞口类型」—— 同 type 的多个插件，styles 会合并进同一个
 *       样式下拉（内置 window + custom/plugins/window_fixed 就是一例）
 *       styles 造型 [{ id, name, desc?, icon?, model?, options?（样式参数 schema）}]
 *              门窗不写 z：高度由洞口决定、从地面算起；造型 id 聚合时加 '<插件id>:' 前缀
 *              options 用来表达同一造型的差异（手向左右 / 开向内开外开 / 推拉方向…），
 *              取值 = 条目 def ∪ 实例 obj.styleOpts，3D 里读 ctx.options、2D 里读 p.options
 *       fields 主绑定实体 [{ key, label, domains?, placeholder?, tip? }]
 *              门窗没有「设备绑定」入口，门磁 / 开度等实体都写在这里；
 *              绑定值存 obj[key]，用 ctx.getState(obj[key]) 或 ctx.field*() 读
 *       isOn(obj, get) 可选，「现在是否开着」→ 只影响 2D 平面填充色；
 *              不写则回退「主实体 on/open 即开」。3D 的开合动画由 model3d 自己按开度算
 *       plan2d(c, p) 可选，2D 平面符号自绘（推拉画中梃、对开画开启弧），不写用通用兜底；
 *              只画中性线稿，开/关底色用 p.fill 填进封闭形状内部，选中圈由编辑器画
 *              p = { L（洞口像素宽度）, sel, on, ppm, ink, fill, style, options, kind,
 *                    entityId, state, obj, getState, rrect(x,y,w,h,rad), draw(fn, opts) }
 * model3d(ctx) 必填，可 async，返回 { group, update?, dispose? }
 *       group   根节点（原点 = 洞口地面中心（窗在墙面线上）；+X 沿洞口宽度、+Y 向上、
 *               +Z 垂直墙面）
 *       update  任一绑定实体变化时调用：只读状态算目标开度，插值交给 animate
 *       dispose 场景重建时释放自建贴图/监听（几何由引擎回收）
 * obj 里的字段: id / x / y（平面坐标，引擎已用于摆放）/ rot（已应用）/ w（洞口宽度，窗默认 1.2）
 *              style（'<插件id>:<造型id>'）/ styleOpts（样式参数取值）
 *              + fields 里声明的 key（entityId / posEntityId …）
 * ctx 常用: THREE / obj / style / options / wallH（当前层墙高，米）/ baseUrl
 *           glb('models/x.glb') → Promise<Group|null>（内部已 clone）/ frame(g,L,ref) 门窗框
 *           box() cyl() sphere() lambert() / getState(eid) / isOn(eid) / binaryRatio(eid)
 *           field*(key) 扩展实体 / animate(fn(dt秒)) 逐帧 / render()
 * 本插件用到: THREE、obj(w/entityId/posEntityId)、style、options、glb、box、lambert、getState、animate
 * 完整手册（注册全表、ctx 全表、坐标系与摆放、生命周期、常见坑、最小模板）：
 *   assets/plugins/door/plugin.js 头部注释。
 */
'use strict';

/* 包一层 IIFE：独立 <script> 加载的经典脚本共享全局作用域，顶层 const 重名会 SyntaxError */
(function () {

const ico = PluginEngine.ico;   // 图标包装在引擎里统一实现（PluginEngine.ico）

/* 窗框: ctx.frame 优先取 models/frame.glb（标准洞宽 1.2m 等比缩放），
 * GLB 缺失时用引擎内置窗框兜底（ref > 1m 自动选窗套几何，见 plugins.js frameFallback） */

/* 开度计算（三种造型共用）:
 *   开关 off → 必关(0)；开关 on → 开度实体有值用其比例，无则全开(1)；
 *   只绑开度实体 → 直接按开度；两个都没绑 → 常闭(0)
 * 开度实体数值: ≤1 按小数比例（0.4=40%），>1 按百分比（40=40%），钳制 0~1 */
function openRatioOf(obj, get) {
  const st = obj.entityId ? get(obj.entityId) : null;
  const on = !!(st && (st.state === 'on' || st.state === 'open'));
  let p = null;
  const pst = obj.posEntityId ? get(obj.posEntityId) : null;
  if (pst && pst.state != null) {
    const v = parseFloat(pst.state);
    if (!isNaN(v)) p = Math.max(0, Math.min(1, v <= 1 ? v : v / 100));
  }
  if (st) return on ? (p != null ? p : 1) : 0;
  if (p != null) return p;
  return 0;
}

function computeTarget(ctx) {
  return openRatioOf(ctx.obj, (eid) => ctx.getState(eid));
}

/* 对开窗(平开窗): 两扇玻璃铰链在左右两端，绕竖轴向外(-Z)旋转开启
 * 每扇 = 一个铰链 pivot(位于窗框端部) + 玻璃 + 上下横梃 + 内侧竖梃 */
async function buildDouble(ctx, L) {
  const g = new ctx.THREE.Group();
  await ctx.frame(g, L, 1.2);

  const half = L / 2 - 0.04;   // 单扇宽（略留缝避免关窗时两扇共面闪烁）
  const mkPivot = (hingeX, dir) => {
    const pivot = new ctx.THREE.Group();
    pivot.position.set(hingeX, 1.5, 0);          // 铰链竖轴
    const glass = new ctx.THREE.Mesh(
      new ctx.THREE.BoxGeometry(half, 1.1, 0.03),
      ctx.lambert('#bfe0f5', { transparent: true, opacity: 0.28 })
    );
    glass.position.x = dir * half / 2;           // 玻璃从铰链伸向窗口中心
    pivot.add(glass);
    ctx.box(glass, half, 0.05, 0.05, 0, 0.55, 0, '#c7d3e0');            // 上横梃
    ctx.box(glass, half, 0.05, 0.05, 0, -0.55, 0, '#c7d3e0');           // 下横梃
    ctx.box(glass, 0.05, 1.1, 0.05, dir * (half / 2 - 0.025), 0, 0, '#c7d3e0'); // 内侧竖梃(中缝处)
    g.add(pivot);
    return pivot;
  };
  const left = mkPivot(-L / 2 + 0.03, 1);        // 左扇铰链在左端
  const right = mkPivot(L / 2 - 0.03, -1);       // 右扇铰链在右端

  let target = 0;
  const api = {
    group: g,
    update() { target = computeTarget(ctx); },
  };
  /* 旋转动画: 绕铰链轴开合。左扇 +角 → 自由边转向 -Z(室外)；右扇镜像 */
  const MAX = 70 * Math.PI / 180;                // 最大开启角 70°
  ctx.animate((dt) => {
    left.rotation.y += (target * MAX - left.rotation.y) * Math.min(1, dt * 4);
    right.rotation.y += (-target * MAX - right.rotation.y) * Math.min(1, dt * 4);
  });

  return api;
}

/* 推拉窗: 固定扇贴左、活动扇沿轨道水平滑动与固定扇重叠（轨道略错开 Z 防共面闪烁） */
async function buildSliding(ctx, L) {
  const g = new ctx.THREE.Group();

  /* 静态: 窗框 */
  await ctx.frame(g, L, 1.2);

  /* 双扇玻璃: 半扇宽，固定扇贴左、活动扇贴右 */
  const half = L / 2 - 0.02;
  const glassMatL = ctx.lambert('#bfe0f5', { transparent: true, opacity: 0.28 });
  const glassMatR = ctx.lambert('#bfe0f5', { transparent: true, opacity: 0.28 });
  const fixed = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(half, 1.1, 0.03), glassMatL);
  fixed.position.set(-L / 4, 1.5, -0.02);
  const moving = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(half, 1.1, 0.03), glassMatR);
  moving.position.set(L / 4, 1.5, 0.02);
  g.add(fixed, moving);

  /* 活动扇扇框（细边条，让推拉方向可辨识） */
  ctx.box(moving, half, 0.05, 0.05, 0, 0.55, 0, '#c7d3e0');
  ctx.box(moving, half, 0.05, 0.05, 0, -0.55, 0, '#c7d3e0');

  const CLOSED_X = L / 4;          // 活动扇关闭位（右半扇）
  const travel = L / 2 - 0.02;     // 最大滑动距离（与固定扇完全重叠）
  let target = 0;                  // 目标开度 0~1

  const api = {
    group: g,
    update() { target = computeTarget(ctx); },
  };
  /* 推拉动画: 活动扇沿 X 滑动（与固定扇重叠部分保持可见，透明度不降） */
  ctx.animate((dt) => {
    const tx = CLOSED_X - travel * target;
    moving.position.x += (tx - moving.position.x) * Math.min(1, dt * 4);
  });

  return api;
}

/* ---------------- 2D 平面符号（编辑器调用，造型差异画在这里） ----------------
 * 编辑器把画布移到窗洞中心并按墙方向旋转好再调用，你只管以原点为中心画。
 * p = { L: 屏幕像素宽度, sel: 是否选中, on: 是否开(插件 isOn 判定结果), ink: 描边色, fill: 填充色,
 *       ppm: 像素/米, style: 造型内部 id('sliding'|'double'), kind: 'window',
 *       entityId / state / obj / getState: 绑定实体与其状态（拓展实体用 getState 查） }
 * 不实现 plan2d 也能用，编辑器会画一个通用「洞口矩形 + 中缝线」兜底。 */
function planWindow(c, p) {
  const L = p.L, ink = p.ink || '#7fb3e8';
  c.fillStyle = p.fill || '#fff';    // 开=暖琥珀/关=白（p.on 由编辑器按插件 isOn 判定后给出）
  c.strokeStyle = ink;
  c.lineWidth = 2;
  c.fillRect(-L / 2, -3, L, 6);      // 窗洞
  c.strokeRect(-L / 2, -3, L, 6);

  if (p.style === 'double') {
    /* 对开窗: 开启弧画在室外一侧（-Y，2D 的 -Y 即 3D 的 -Z），与 3D 外开方向一致 */
    const r = L / 4;
    c.beginPath();
    c.moveTo(-L / 2, 0); c.lineTo(L / 2, 0);            // 两扇关闭位
    c.moveTo(-L / 2, 0); c.lineTo(-L / 2, -r);
    c.arc(-L / 2, 0, r, -Math.PI / 2, 0, false);        // 左扇弧: (0,-r) → (r,0)
    c.moveTo(L / 2, 0); c.lineTo(L / 2, -r);
    c.arc(L / 2, 0, r, -Math.PI / 2, -Math.PI, true);   // 右扇弧: (0,-r) → (-r,0)
    c.stroke();
    return;
  }
  /* 推拉窗: 只画中梃，表示两扇可错动 */
  c.beginPath(); c.moveTo(-L / 2, 0); c.lineTo(L / 2, 0); c.stroke();
}

PluginEngine.register({
  builtin: true,   // 内置插件标记：不带此参数的注册一律视为自定义（「自定义」角标）
  id: 'window',
  kind: 'opening',
  type: 'window',      // 洞口类型（门窗用），同 type 的多个插件 styles 会合并
  name: '窗户',
  plan2d: planWindow,
  styles: [
    { id: 'sliding', name: '推拉窗', desc: '双扇推拉，活动扇沿轨道与固定扇重叠；开度实体控开合比例', icon: ico('<rect x="3" y="7" width="18" height="10" rx="1"/><line x1="12" y1="7" x2="12" y2="17"/><line x1="8" y1="12" x2="11" y2="12" opacity=".55"/>') },
    { id: 'double', name: '对开窗', desc: '两扇铰链在左右两端，绕竖轴向外旋转开启（平开窗）；开关/开度实体同样生效', icon: ico('<rect x="3" y="7" width="18" height="10" rx="1"/><line x1="8" y1="7" x2="8" y2="17"/><line x1="16" y1="7" x2="16" y2="17"/><line x1="8" y1="12" x2="16" y2="12" opacity=".4"/>') },
  ],
  fields: [
    { key: 'entityId', label: '开关实体', placeholder: 'binary_sensor.xxx / switch.xxx（on=开窗）' },
    { key: 'posEntityId', label: '开度实体', placeholder: 'sensor.xxx（数值: 0~100 或 0~1）' },
  ],

  /* 2D「开」判定: 与 3D 开度计算同一逻辑——开关 on/open 且(开度>0 或未绑开度)=开；
   * 只绑开度实体时 数值>0=开；都没绑=关。编辑器画平面图时用它决定填充色 */
  isOn(obj, get) { return openRatioOf(obj, get) > 0; },

  async model3d(ctx) {
    const L = ctx.obj.w || 1.2;
    const sid = (ctx.style && ctx.style.id) || 'sliding';
    if (sid === 'double') return buildDouble(ctx, L);
    return buildSliding(ctx, L);
  },
});

})();
