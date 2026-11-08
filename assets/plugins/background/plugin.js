/*
 * background — 户外地面背景插件（kind: 'background'）
 *
 * 与其他插件同构: 一个 plugin.js 顶层调用 PluginEngine.register({...}) 完成注册，
 * plugin.json 提供清单（服务端 /api/plugins 读取，界面按清单加载本文件）。
 * 引擎不规定「背景长什么样」，apply **统一返回一个 3D 模型**: { group: THREE.Group }。
 * 不存在「平面 / 立体」两种模式 —— 扁平背景只是「比较扁的 3D 模型」，上面贴的图想画多丰富都行：
 *   - 扁平地面:  g.add(ctx.plane(canvas))      把画好的整图贴到 120m 平面网格（最常用）
 *   - 立体造型:  在同一个 group 里再放草丛/石头/起伏地形等体块（参考草原）
 * 静态 / 动态由插件声明：
 *   refresh: 0（缺省）→ 静态，只画一次
 *   refresh: 15       → 每秒回调 update(t, api) 15 次（水面波动）
 *
 * ============================================================================
 * 〇、styles[] 条目里能写什么（每个条目 = 面板里的一个背景选项）
 * ============================================================================
 *   {
 *     id: 'grass',                  // 必填，本插件内唯一。引擎聚合时加前缀
 *                                   //   → 数据里是 'background:grass'；插件只在 apply 里写代码，
 *                                   //     拿不到也不需要这个前缀
 *     name: '草地',                  // 必填，面板按钮文案
 *     icon: '🌿',                    // 可选，按钮图标（emoji 或短文本）。不写 = 🖼
 *     refresh: 0,                   // 可选，刷新率 Hz。0 / 不写 = 静态只画一次；
 *                                   //   1..30 = 每秒回调 update 这么多次（引擎会把 >30 压到 30）
 *     options: [ … ],               // 可选，参数 schema，见第五节（面板据此渲染控件）
 *     apply(ctx) { … }              // 必填，返回 { group, refresh?, update?, size? }，见第二节
 *   }
 *   注意：**不要**在条目顶层写 repeat / 平铺次数之类自定义字段 —— 引擎只认上表这几个键，
 *   其余一律忽略。要可配置的平铺次数，就放进 options 里声明同名 key，apply 里用 ctx.options 读。
 *
 * ============================================================================
 * 一、ctx —— 引擎递给你的「素材包」（apply(ctx) 的参数）
 * ============================================================================
 * ctx = { THREE, size, house, safe, options, refresh, plane }
 *
 *   THREE    three.js 命名空间。一律用 ctx.THREE 或全局 window.THREE，
 *            不要自己再引一份 CDN，否则会出现两套互不认识的类和常量。
 *   size     建议的画布边长（当前 512 像素）。画贴图时照这个开 canvas：
 *              const cv = document.createElement('canvas');
 *              cv.width = cv.height = ctx.size;
 *   refresh  这个背景的刷新率（Hz）：0 = 静态只画一次；15 = 每秒调用 update 15 次。
 *            引擎会把大于 30 的值压到 30，避免插件把主线程写爆。
 *   options  右侧属性面板里的参数值，已经和插件声明的默认值合并好了：
 *              { repeat: 26 }   // 面板上「颗粒密度」这一项当前是 26
 *            你在 options: [...] 里声明哪些 key，这里就会有哪些 key（schema 见第五节）。
 *            合并规则：用户存过且非空的值优先，否则用条目里的 def ——
 *            所以插件里直接 ctx.options.repeat 用，不用再写 `|| 26` 兜底。
 *            参数值存在 project.settings.backgroundOptions['<插件id>:<背景id>'] 里。
 *
 * ---------------------------------------------------------------------------
 * house —— 全屋包围盒（所有楼层墙体的并集），单位：米
 * ---------------------------------------------------------------------------
 * ⚠ 坐标系：原点 = **背景中心**，不是房屋中心。房屋可以偏在画面一侧
 *   （偏移由样式参数 offsetX / offsetZ 决定，见第五节），所以 house.cx / cy
 *   就是「房屋相对背景中心的偏移量」：0 / 0 = 房屋正落在画面中心。
 *   画布要这么对：canvas 中心 ↔ 背景中心（= ctx.plane 的平面中心），
 *   把房屋画在 (house.cx, house.cy) 对应的像素位置上即可。
 *
 * 坐标怎么对应（新手最容易在这里翻车，务必先看这三行）：
 *   · 2D 编辑器里的平面坐标 (x, y)  →  3D 世界坐标 (x, z)
 *   · 3D 里的高度方向是 y 轴（向上）
 *   · 所以平面上的 y（南北向）在 3D 里叫 z，house.minY/maxY/cy 都是「平面 y = 3D z」
 *
 *   minX / maxX   房屋最西 / 最东的墙边（背景坐标系里的 x 最小 / 最大值）
 *   minY / maxY   房屋最北 / 最南的墙边（对应 3D z 的最小 / 最大值，名字沿用编辑器的 y）
 *   w  /  d       东西向宽 / 南北向深（= maxX - minX / maxY - minY）
 *   cx / cy       房屋中心在背景坐标系里的位置 = 偏移量（米）。
 *                 偏移 0 时房屋在画面正中；把它当地面摆放的锚点：
 *                   base.position.set(house.cx, -0.05, house.cy)  ← 只在你故意想让平面跟着房子时用
 *                 引擎给的 ctx.plane() 已经把平面中心放在背景中心，直接 add 就是对的。
 *   floors        有墙的楼层数（没画墙的层不算）
 *   hash          尺寸指纹（字符串）。墙/楼层变了它才会变。
 *                 引擎发现它变化时会自动重放背景（你不需要自己监听重建时机）。
 *                 拿它当随机种子，可以让「同一栋房子每次重建，草的位置完全一样」：
 *                   const K = PluginEngine.bgKit;
 *                   const rnd = K.rand(K.seed(house.hash));
 *   项目里一堵墙都没有时，引擎给的是 0~8 米的正方形兜底值。
 *
 * ---------------------------------------------------------------------------
 * safe —— 安全边界（帮你的道具避开房子），平面坐标 + 米
 * ---------------------------------------------------------------------------
 *   ⚠ 和 house 同一套坐标系（原点 = 背景中心，已含偏移），所以照它撒点，
 *     不管偏移调成多少，道具都不会压到房子。
 *   inner = 1.5   房屋占地向外扩多少米算「禁放区」（留一条走廊，别贴到墙上）
 *   outer = 45    建议最远布置半径（以房屋中心为圆心，超出这个圈再撒东西玩家也看不见）
 *   x0,x1,y0,y1   禁放矩形的四条边（= 上面 house 的四条边各向外 ±inner）
 *   forbidden(x, z)   传平面坐标，返回 true = 落在禁放区里（会压到房子，别放）
 *   allowed(x, z)     传平面坐标，返回 true = 在房子外面、且离房屋中心不超过 45m
 *
 *   典型用法（撒任何东西之前先问一句）：
 *     if (ctx.safe && !ctx.safe.allowed(x, z)) continue;   // 这个点不合适，换一个
 *
 * ============================================================================
 * 二、apply(ctx) 的返回值 —— 统一返回一个 3D 模型
 * ============================================================================
 *   { group: new ctx.THREE.Group() }   整块地面一个模型，怎么搭全部自己定：
 *
 *   扁平地面（最常用）——平面网格 + 画好的整图:
 *     const g = new ctx.THREE.Group();
 *     g.add(ctx.plane(cv));            // 引擎组装好的 120m 平面网格（已摆正、中心对准背景中心、防闪面）
 *     return { group: g };
 *     是否平铺、颗粒密度…都在画 cv 时自己消化，引擎不做任何 UV 假设
 *
 *   立体造型 —— 同一个 group 里再放体块（起伏地形 / 草丛 / 石头…）:
 *     g.add(自己的体块网格);            // 参考「草原」的草丛实现
 *
 *   可额外带:
 *     refresh: 20      覆盖条目上声明的刷新率
 *     update(t, api)   动态背景的每帧回调，t = 从挂载开始累计的秒数；
 *                      改了贴图自己标脏: tex.needsUpdate = true（贴图引用自己持有）
 *
 * ============================================================================
 * 三、api —— 动态背景 update(t, api) 的第二个参数
 * ============================================================================
 * api = { group, mesh, size }
 *
 *   group   apply 返回的那个 group（根节点）
 *   mesh    同上（引擎挂进场景的根节点）
 *   size    数值，缺省 512；apply 返回值里带 size 时取它
 *   没有 texture / material / needsUpdate —— 动态改图请自己持有 CanvasTexture，
 *   改完直接 tex.needsUpdate = true（闭包里存着引用即可）
 *
 *   顶层 onData(fields, api) 拿到的是同一份 api 再加 overlayGroup（数据专属子树），
 *   见第七节；时间通道的 update 与数据通道的 onData 各管各的元素。
 *
 * ============================================================================
 * 四、最小可跑示例（复制到 register 的 styles 数组里就能用）
 * ============================================================================
 * { id: 'mygrass', name: '我的草地', icon: '🌿', refresh: 0,
 *   options: [{ key: 'dots', label: '颗粒密度', type: 'range', min: 4, max: 20, step: 1, def: 8 }],
 *   apply: (ctx) => {
 *     // 画一张 2048² 的整图: 底色 + 按 options.dots 控制颗粒数量
 *     const cv = document.createElement('canvas');
 *     cv.width = cv.height = 2048;
 *     const c = cv.getContext('2d');
 *     c.fillStyle = '#7ea864';
 *     c.fillRect(0, 0, cv.width, cv.height);
 *     const dots = (ctx.options || {}).dots || 8;
 *     for (let i = 0; i < dots * 400; i++) { ... }   // 撒颗粒
 *     const g = new ctx.THREE.Group();
 *     g.add(ctx.plane(cv));      // 贴到 120m 平面网格上（引擎已摆正/中心=背景中心/防闪面）
 *     return { group: g };   // 统一返回 3D 模型（动态背景加 update，见水面）
 *   } }
 *
 * ============================================================================
 * 五、options[] —— 参数 schema（面板控件）与取值存储
 * ============================================================================
 *   options: [
 *     { key: 'repeat', label: '颗粒密度', type: 'range', min: 8, max: 40, step: 2, def: 26 },
 *     { key: 'seed',   label: '随机种子', type: 'number', step: 1, def: 3 },
 *     { key: 'mode',   label: '纹理', type: 'select', def: 'soft',
 *       choices: [{ value: 'soft', label: '柔和' }, { value: 'hard', label: '硬朗' }] },
 *     { key: 'shadow', label: '画阴影', type: 'checkbox', def: true, tip: '关掉可省一点绘制时间' },
 *   ]
 *   每项的字段：
 *     key    必填，取值键名（apply 里 ctx.options[key] 读）
 *     label  必填，面板上显示的名字
 *     type   控件类型（下表），不写或写错都按 text 渲染（注册时引擎统一归一化）
 *     def    默认值。⚠ 用户没改过、或存的是 null / '' 时都会回退到它，
 *            所以「0 和 false」这类合法假值也能正常保留（判空只看 null / '' / undefined）
 *     min / max / step   range / number 用
 *     choices            select 用：[{ value, label }]，value 是实际存的值
 *     tip                checkbox 的勾选框旁文字；其它类型可当作行内说明
 *
 *   控件类型：'range' 滑块+数字框 · 'number' 数字框 · 'select' 下拉 ·
 *            'checkbox' 复选框 · 'text' 文本框
 *   （与门窗/设备的「样式参数」是同一套 schema、同一份渲染代码，写法完全通用）
 *
 *   取值怎么流转：
 *     面板改一项 → 引擎写 project.settings.backgroundOptions['<插件id>:<背景id>'][key]
 *                → 立刻重放本背景（apply 重新执行，不重建户型）
 *     apply 里   → ctx.options.key 直接读（默认值已合并）
 *   同一插件下不同背景各自存各自的参数，互不影响。
 *
 *   —— PluginEngine.bgKit：背景插件共享底座（多个背景插件共用，别自己再抄一遍）——
 *     canvas(size)                    空白正方形画布（缺省 256）
 *     speckle(c, colors, n, min, max) 在画布上下文 c 上均匀撒噪点
 *     seed(str)                       字符串 → 数值种子（配合 house.hash 用）
 *     rand(seed)                      → () => 0..1 的确定性随机序列
 *     retile(cv, tile, n) / fullPlane(tile, n)   tile 平铺 n×n / 铺满 2048² 大图
 *     flat(ctx, cv, name?)            扁平背景组装：group + ctx.plane(整图)
 *     repeatOpt(def)                  「颗粒密度」参数条目（key 固定 repeat）
 *   内置 background 与 custom/plugins/garden 都在用，直接参考写法即可。
 *
 * ============================================================================
 * 六、两个常见坑
 * ============================================================================
 *   · 地面高度：ctx.plane() 已经把平面压在 y = -0.05（略低于楼层地板，避免 z-fighting）。
 *     自己加的立体体块贴着地面放即可（y=0 起步）。
 *   · apply() 是同步调用的：里面不要 fetch 大文件或等异步结果。
 *     要用图片素材，就在插件加载时预加载成 Image 存起来，apply 里直接画进 canvas。
 *
 * ============================================================================
 * 七、动态实体字段 fields + 顶层 onData（本插件自带的可运行验证样例）
 * ============================================================================
 * 与 styles[].apply 返回值里的「时间通道」update(t, api) 并行，还有一条「数据通道」：
 *   fields  写在**注册对象顶层**，声明订阅哪些 HA 实体（不是 styles[].options 的手工参数）
 *   onData  写在**注册对象顶层**，绑定的实体 state / attributes 变化时才回调
 * 引擎自动把专属子树 api.overlayGroup 挂在背景 group 下，重放时随 group 一起销毁重建；
 * 本插件只往里放一块朝向相机的「天气牌」，地面/水波仍归各自的 apply 管，互不干扰。
 * **静态背景（refresh:0）同样生效**；未绑定实体或 HA 还没连上时牌子自动隐藏，
 * 原有 7 种地面的外观零改动。
 *
 * 验证步骤（home 编辑页）：选任意一个背景 → 右侧「实体绑定 · 背景」把
 *   · 天气实体 → weather.home（演示模式下就是 partlycloudy / 18°C）
 *   · 数值实体 → 任意 sensor.*（演示模式下 sensor.living_temp 每 3 秒变一次）
 * 绑完房屋右上方的空中立刻出现天气牌，数值会自己刷新；接真实 HA 改天气状态，顶部色条与图标同步变。
 * 完整契约见 PLUGIN-DEV.md 4.9。设备/门窗的实例级 fields 是另一套机制，不要混用。
 */
'use strict';

/* 包一层 IIFE：多个 plugin.js 是独立 <script>、共享全局作用域，顶层 const/function 重名会 SyntaxError */
(function () {

/* ---------------- 贴图绘制（程序化生成，零资源文件） ----------------
 * 画布/噪点/确定性随机/平铺铺满/扁平组装/面板参数等通用底座
 * 已收敛到 PluginEngine.bgKit（与 garden 插件共用），本文件只保留本插件特有的画法。 */

const K = PluginEngine.bgKit;

/* 草叶: 短线段，跨边界补笔保证平铺无断裂 */
function bgBlades(c, colors, count) {
  const S = c.canvas.width;
  for (let i = 0; i < count; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const len = 3 + Math.random() * 5;
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 0.9;
    const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
    c.strokeStyle = colors[(Math.random() * colors.length) | 0];
    c.lineWidth = 0.8 + Math.random() * 0.7;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x2, y2);
    c.stroke();
    if (x2 < 0 || x2 > S || y2 < 0 || y2 > S) {
      c.beginPath();
      c.moveTo((x + S) % S, (y + S) % S);
      c.lineTo((x2 + S) % S, (y2 + S) % S);
      c.stroke();
    }
  }
}

function bgGrass(size) {
  const cv = K.canvas(size), c = cv.getContext('2d');
  c.fillStyle = '#7ea864';
  c.fillRect(0, 0, cv.width, cv.height);
  K.speckle(c, ['#749f5b', '#87b26c', '#6d9854', '#8fb974'], 900, 1.2, 3.4);
  bgBlades(c, ['#6a9350', '#8cbc70', '#5f8a49', '#9ac57e'], 1400);
  return cv;
}

function bgSand() {
  const cv = K.canvas(), c = cv.getContext('2d');
  c.fillStyle = '#e6d3ab';
  c.fillRect(0, 0, 256, 256);
  K.speckle(c, ['#dfc99c', '#eddbb6', '#d8c08f', '#f2e4c6'], 1600, 0.6, 1.8);
  c.globalAlpha = 0.12;
  for (let y = 0; y < 256; y += 6) {
    c.strokeStyle = '#c9ad78';
    c.lineWidth = 1.4;
    c.beginPath();
    for (let x = 0; x <= 256; x += 8) {
      const yy = y + Math.sin((x / 256) * Math.PI * 2) * 2.2;
      x === 0 ? c.moveTo(x, yy) : c.lineTo(x, yy);
    }
    c.stroke();
  }
  c.globalAlpha = 1;
  return cv;
}

function bgStone() {
  const cv = K.canvas(), c = cv.getContext('2d');
  c.fillStyle = '#cfd3d8';   // 缝隙底色
  c.fillRect(0, 0, 256, 256);
  const n = 4, cell = 256 / n, gap = 3;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const tone = 0.86 + Math.random() * 0.16;
      const base = Math.round(196 * tone);
      c.fillStyle = 'rgb(' + base + ',' + (base + 3) + ',' + (base + 7) + ')';
      c.fillRect(i * cell + gap, j * cell + gap, cell - gap * 2, cell - gap * 2);
      c.globalAlpha = 0.1;
      K.speckle(c, ['#9aa2ac', '#f2f5f8'], 60, 1, 3);
      c.globalAlpha = 1;
    }
  }
  return cv;
}

function bgDeck() {
  const cv = K.canvas(), c = cv.getContext('2d');
  c.fillStyle = '#b98f60';
  c.fillRect(0, 0, 256, 256);
  const rows = 4, h = 256 / rows;
  for (let r = 0; r < rows; r++) {
    const tone = 0.9 + Math.random() * 0.16;
    c.fillStyle = 'rgb(' + Math.round(180 * tone) + ',' + Math.round(140 * tone) + ',' + Math.round(96 * tone) + ')';
    c.fillRect(0, r * h + 1.5, 256, h - 3);
    c.globalAlpha = 0.16;
    for (let k = 0; k < 12; k++) {
      c.strokeStyle = '#7a5632';
      c.lineWidth = 0.7;
      const y = r * h + 3 + Math.random() * (h - 6);
      c.beginPath();
      for (let x = 0; x <= 256; x += 16) {
        const yy = y + Math.sin((x / 24) + k) * 0.8;
        x === 0 ? c.moveTo(x, yy) : c.lineTo(x, yy);
      }
      c.stroke();
    }
    c.globalAlpha = 1;
  }
  return cv;
}

function bgSnow() {
  const cv = K.canvas(), c = cv.getContext('2d');
  c.fillStyle = '#f2f6fb';
  c.fillRect(0, 0, 256, 256);
  K.speckle(c, ['#e6eef8', '#ffffff', '#dbe7f5', '#eef4fb'], 1200, 1, 3.6);
  return cv;
}

/* 水面: phase 为相位，动态背景按刷新率改它就能让波纹流动（画在同一张 canvas 上） */
function bgWater(phase, cv) {
  phase = phase || 0;
  const canvas = cv || K.canvas();
  const c = canvas.getContext('2d');
  const S = canvas.width;
  const g = c.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, '#8fc4de');
  g.addColorStop(1, '#6fa9c9');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  c.globalAlpha = 0.18;
  for (let y = 0; y < S; y += 9) {
    c.strokeStyle = '#ffffff';
    c.lineWidth = 1;
    c.beginPath();
    for (let x = 0; x <= S; x += 10) {
      const yy = y + Math.sin((x / S) * Math.PI * 4 + y * 0.35 + phase) * 2.6;
      x === 0 ? c.moveTo(x, yy) : c.lineTo(x, yy);
    }
    c.stroke();
  }
  c.globalAlpha = 1;
  return canvas;
}

/* ---------------- 自绘地面（不平铺）用到的工具 ---------------- */

/* 大尺度斑块底图（1024²，整块不重复）: 解决平铺贴图那种"一眼看出网格"的拼接感 */
function bgMeadowBase(size) {
  const S = size || 1024;
  const cv = K.canvas(S), c = cv.getContext('2d');
  c.fillStyle = '#7ba363';
  c.fillRect(0, 0, S, S);
  const tones = ['#6f9956', '#86b06b', '#779f5f', '#93b877', '#648d4c'];
  for (let i = 0; i < 260; i++) {
    const r = S * (0.04 + Math.random() * 0.16);
    const x = Math.random() * S, y = Math.random() * S;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const col = tones[(Math.random() * tones.length) | 0];
    g.addColorStop(0, col);
    g.addColorStop(1, 'rgba(123,163,99,0)');
    c.globalAlpha = 0.5;
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;
  K.speckle(c, ['#6f9956', '#8ab56f', '#63894b', '#9dbf82'], 5200, 1.4, 4.2);
  bgBlades(c, ['#5f8a49', '#8cbc70', '#6a9350', '#a3cb87'], 2600);
  return cv;
}

/* 单丛草/杂草贴片（带 alpha），供十字面片使用 */
function bgTuft() {
  const S = 64;
  const cv = K.canvas(S), c = cv.getContext('2d');
  c.clearRect(0, 0, S, S);
  const cols = ['#5f8a49', '#74a05a', '#89b86e', '#4f7a3d'];
  for (let i = 0; i < 26; i++) {
    const x = S / 2 + (Math.random() - 0.5) * S * 0.72;
    const h = S * (0.32 + Math.random() * 0.6);
    const bend = (Math.random() - 0.5) * S * 0.3;
    c.strokeStyle = cols[(Math.random() * cols.length) | 0];
    c.lineWidth = 1.4 + Math.random() * 1.4;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(x, S);
    c.quadraticCurveTo(x + bend * 0.4, S - h * 0.6, x + bend, S - h);
    c.stroke();
  }
  return cv;
}

/* 把一堆"十字双面片"合进一个 BufferGeometry → 整片草原只占 1 个 draw call */
function bgTuftGeometry(T, spots) {
  const pos = [], uv = [], idx = [];
  const quad = (cx, cz, ry, w, hgt) => {
    const cos = Math.cos(ry), sin = Math.sin(ry);
    const base = pos.length / 3;
    const corners = [[-w / 2, 0, 0, 0], [w / 2, 0, 1, 0], [w / 2, hgt, 1, 1], [-w / 2, hgt, 0, 1]];
    corners.forEach(([lx, ly, u, v]) => {
      pos.push(cx + lx * cos, 0 + ly, cz + lx * sin);
      uv.push(u, v);
    });
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  spots.forEach((s) => {
    quad(s.x, s.z, s.ry, s.w, s.h);                    // 第一片
    quad(s.x, s.z, s.ry + Math.PI / 2, s.w, s.h);      // 交叉第二片（任意角度看都有体积）
  });
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* 自绘草原: 底图平面 + 安全区内逐丛撒草（扁平 + 立体混在同一个 group 里） */
function bgBuildMeadow(ctx) {
  const T = ctx.THREE;
  const h = ctx.house || { cx: 0, cy: 0, w: 8, d: 8, hash: 'x' };
  const o = ctx.options || {};
  const clumps = o.clumps != null ? o.clumps : 70;
  const sizeK = o.size != null ? o.size : 1;

  const g = new T.Group();
  g.name = 'backdrop:meadow';

  // 底图: 120m 一张图（引擎 helper 已摆正/中心=背景中心/防闪面），1024² 保证近处不至于太糊
  g.add(ctx.plane(bgMeadowBase(1024)));

  // 草丛: 只在安全环带里撒（引擎给的 safe.allowed 已排除房屋占地 + 1.5m 走廊）
  const rnd = K.rand(K.seed(h.hash || (h.cx + ',' + h.cy)));
  const spots = [];
  let guard = 0;
  while (spots.length < clumps && guard++ < clumps * 60) {
    const ang = rnd() * Math.PI * 2;
    const rad = 2.4 + Math.sqrt(rnd()) * 30;          // 2.4 ~ 32m
    const x = h.cx + Math.cos(ang) * rad;
    const z = h.cy + Math.sin(ang) * rad;
    if (ctx.safe && !ctx.safe.allowed(x, z)) continue;
    spots.push({ x, z, ry: rnd() * Math.PI, w: (0.7 + rnd() * 0.9) * sizeK, h: (0.5 + rnd() * 0.7) * sizeK });
  }
  if (spots.length) {
    const tuftTex = new T.CanvasTexture(bgTuft());
    tuftTex.needsUpdate = true;
    const mat = new T.MeshLambertMaterial({
      map: tuftTex, transparent: true, alphaTest: 0.35, side: T.DoubleSide, depthWrite: false,
    });
    g.add(new T.Mesh(bgTuftGeometry(T, spots), mat));
  }
  return g;
}

/* ---------------- 顶层 onData：数据驱动的「天气牌」 ----------------
 * 这是 fields / onData 契约的一个最小样例：只往 api.overlayGroup 里放东西，
 * 与时间通道（apply 返回值里的 update）物理隔离。Sprite 始终朝向相机，
 * 建一次复用：每次回调只重画它手里的 canvas 并标脏贴图，不反复分配 GPU 资源；
 * 引用挂在 overlayGroup.userData 上，背景重放时会随 group 一起销毁（不做模块级缓存）。 */

/* HA weather condition → 中文（没收录的原样显示，避免未知状态变成空白） */
const BG_WEATHER = {
  sunny: '晴', 'clear-night': '晴夜', partlycloudy: '局部多云', cloudy: '多云',
  rainy: '雨', pouring: '大雨', snowy: '雪', fog: '雾', windy: '大风',
  lightning: '雷电', 'lightning-rainy': '雷雨', hail: '冰雹',
};

/* 降水 / 雷电 → 冷色；阴天 / 雾 / 风 → 灰蓝；其余（晴）→ 暖黄 */
function bgWet(state) {
  return /rain|pouring|snow|hail|lightning|sleet/i.test(String(state || ''));
}
function bgAccent(w) {
  if (!w) return '#7aa7d8';
  const st = String(w.state || '');
  if (bgWet(st)) return '#5ba7e8';
  return /cloud|fog|wind|night/i.test(st) ? '#9fb4c9' : '#ffc85c';
}

/* 单行文字按可用宽度截断：浏览器用 measureText 量真实宽度，
 * 没有 measureText 的环境（测试桩）按字宽粗估，保证长状态 / 长实体 id 不会画出牌子。 */
function bgFitText(c, text, x, y, maxW) {
  let s = String(text == null ? '' : text);
  const widthOf = (t) => {
    const m = c.measureText ? c.measureText(t) : null;
    return m && isFinite(m.width) ? m.width : t.length * 14;
  };
  while (s.length > 4 && widthOf(s) > maxW) s = s.slice(0, s.length - 2) + '…';
  c.fillText(s, x, y);
}

function bgMakeBadge(T) {
  const cv = K.canvas(720);
  cv.height = 260;                        // 720×260 ≈ 牌子比例，配合 sprite.scale 6.5×2.35
  const tex = new T.CanvasTexture(cv);
  const sprite = new T.Sprite(new T.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  sprite.scale.set(6.5, 2.35, 1);
  sprite.renderOrder = 999;               // 总在房屋 / 地面之上，方便一眼看到状态变化
  sprite.visible = false;                 // 未绑定实体 / HA 未连上时保持原生地面
  return { cv, tex, sprite };
}

/* w / m 都是 { entity_id, state, attributes } 或 null；两者都为 null 时不会调用到这里 */
function bgDrawBadge(badge, w, m) {
  const c = badge.cv.getContext('2d'), W = badge.cv.width, H = badge.cv.height;
  const st = w ? String(w.state || '') : '';
  const at = (w && w.attributes) || {};
  const accent = bgAccent(w);
  c.clearRect(0, 0, W, H);
  c.fillStyle = 'rgba(16, 24, 36, 0.86)';
  c.fillRect(0, 0, W, H);
  c.fillStyle = accent;
  c.fillRect(0, 0, W, 9);                 // 顶部色条：天气一变最先看到它换色

  /* 左侧圆形图标：晴 = 纯色日轮，降水 = 加三道白色雨丝 */
  c.beginPath(); c.arc(92, 130, 54, 0, Math.PI * 2);
  c.fillStyle = accent; c.fill();
  if (bgWet(st)) {
    c.strokeStyle = '#ffffff'; c.lineWidth = 7; c.lineCap = 'round';
    for (let i = -1; i <= 1; i++) {
      const x = 92 + i * 26;
      c.beginPath(); c.moveTo(x + 4, 106); c.lineTo(x - 8, 150); c.stroke();
    }
  }

  const font = (px, bold) => (bold ? 'bold ' : '') + px + 'px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
  c.textBaseline = 'middle';
  c.fillStyle = '#ffffff';
  c.font = font(46, true);
  c.fillText(w ? ('天气 · ' + (BG_WEATHER[st] || st || '未知')) : '数值', 178, 74);

  /* 第二行：天气原始 condition + 温度（取 attributes，验证 attributes 变化也能触发回调） */
  const unit = at.temperature_unit || '°C';
  const temp = at.temperature != null ? at.temperature + unit : '';
  const sub = w ? [st || w.entity_id, temp].filter(Boolean).join('   ·   ') : (m ? m.entity_id : '');
  c.fillStyle = '#b9c9dc';
  c.font = font(28, false);
  c.fillText(sub, 178, 132);

  /* 第三行：数值实体（任意 sensor.*）。演示模式下 sensor.living_temp 每 3 秒漂移，
   * 不用接真实 HA 也能看到「状态变化 → onData → 牌子刷新」整条链路。 */
  c.font = font(26, false);
  if (m) {
    const u = (m.attributes && m.attributes.unit_of_measurement) || '';
    c.fillStyle = accent;
    bgFitText(c, '数值 ' + m.state + (u ? ' ' + u : '') + '   ←   ' + m.entity_id, 178, 194, W - 178 - 24);
  } else {
    c.fillStyle = '#7d8ea3';
    c.fillText('可再绑定数值实体，验证实时刷新', 178, 194);
  }
}

/* ---------------- 注册 ----------------
 * 铺满/扁平组装/面板参数等底座全部来自 PluginEngine.bgKit（见文件顶部说明）。 */
PluginEngine.register({
  builtin: true,   // 内置插件标记：不带此参数的注册一律视为自定义（「自定义」角标）
  id: 'background',
  kind: 'background',
  name: '户外地面',

  /* 顶层动态实体订阅（第七节）：所有 7 种背景共用这一份声明，值按背景 id 独立存
   * 在 settings.backgroundFields['background:<样式id>'] 里。options 是手工参数，别混。 */
  fields: [
    { key: 'weather', label: '天气实体', domains: ['weather'], placeholder: 'weather.home',
      tip: '绑定 weather.* 实体；状态或温度变化会重画天气牌，静态背景同样生效' },
    { key: 'metric', label: '数值实体', domains: ['sensor'], placeholder: 'sensor.living_temp',
      tip: '任意 sensor.*，用于验证多字段订阅；演示模式下 sensor.living_temp 每 3 秒变化' },
  ],
  /* 背景样式列表：与门窗/设备插件统一叫 styles（每项 apply(ctx) → { group }） */
  styles: [
    /* --- 扁平背景: 平面网格 + 画好的整图（tile 铺满在插件内部完成） --- */
    { id: 'grass', name: '草地', icon: '🌿', refresh: 0,
      options: [K.repeatOpt(26), ...K.offsetOpts()],
      apply: (ctx) => ({ group: K.flat(ctx, K.fullPlane(bgGrass(256), (ctx.options || {}).repeat), 'background:flat') }) },

    { id: 'sand', name: '沙滩', icon: '🏖', refresh: 0,
      options: [K.repeatOpt(22), ...K.offsetOpts()],
      apply: (ctx) => ({ group: K.flat(ctx, K.fullPlane(bgSand(), (ctx.options || {}).repeat), 'background:flat') }) },

    { id: 'stone', name: '石板', icon: '🧱', refresh: 0,
      options: [K.repeatOpt(20), ...K.offsetOpts()],
      apply: (ctx) => ({ group: K.flat(ctx, K.fullPlane(bgStone(), (ctx.options || {}).repeat), 'background:flat') }) },

    { id: 'deck', name: '木栈道', icon: '🪵', refresh: 0,
      options: [K.repeatOpt(18), ...K.offsetOpts()],
      apply: (ctx) => ({ group: K.flat(ctx, K.fullPlane(bgDeck(), (ctx.options || {}).repeat), 'background:flat') }) },

    { id: 'snow', name: '雪地', icon: '❄️', refresh: 0,
      options: [K.repeatOpt(24), ...K.offsetOpts()],
      apply: (ctx) => ({ group: K.flat(ctx, K.fullPlane(bgSnow(), (ctx.options || {}).repeat), 'background:flat') }) },

    /* --- 动态扁平背景: 水面按 refresh 频率重绘 tile 再铺满，自己持有贴图引用标脏 --- */
    { id: 'water', name: '水面', icon: '💧', refresh: 15,
      options: [
        K.repeatOpt(16),
        { key: 'speed', label: '流速', type: 'range', min: 0, max: 3, step: 0.1, def: 1 },
        ...K.offsetOpts(),
      ],
      apply(ctx) {
        const T = ctx.THREE, o = ctx.options || {};
        const tile = bgWater(0);                          // 无缝 tile: 动态时只重画这一小块
        const n = Math.max(1, Math.min(40, Math.round(o.repeat || 20)));
        const canvas = K.fullPlane(tile, n);
        const tex = new T.CanvasTexture(canvas);
        const g = new T.Group();
        g.name = 'background:water';
        g.add(ctx.plane(tex));
        return {
          group: g,
          /* 引擎按 refresh=15 调这个: 重画 tile → 内部重新铺满 → 贴图标脏 */
          update(t) {
            bgWater(t * (0.5 + (o.speed != null ? o.speed : 1) * 1.5), tile);
            K.retile(canvas, tile, n);
            tex.needsUpdate = true;
          },
        };
      } },

    /* --- 立体背景: 底图平面 + 真 3D 草丛体块（同一个 group，扁平 + 立体混搭） --- */
    { id: 'meadow', name: '草原（立体）', icon: '🌾', refresh: 0,
      options: [
        { key: 'clumps', label: '草丛数量', type: 'range', min: 0, max: 160, step: 10, def: 70 },
        { key: 'size', label: '草丛大小', type: 'range', min: 0.5, max: 2, step: 0.1, def: 1 },
        ...K.offsetOpts(),
      ],
      apply(ctx) { return { group: bgBuildMeadow(ctx) }; } },
  ],

  /* 顶层数据通道：只负责天气牌这一小块元素，与上面每个 apply 的地面 / 水波完全隔离。
   * fields 表里每个声明过的 key 都有值；未绑定 / HA 未连接时为 null ——
   * 此时把牌子隐藏（回退成原生地面），不抛错、不画到已释放对象上。 */
  onData(fields, api) {
    const g = api && api.overlayGroup, ctx = api && api.ctx;
    if (!g || !ctx || !ctx.THREE) return;
    g.userData = g.userData || {};
    let badge = g.userData.weatherBadge;
    if (!badge) {
      badge = bgMakeBadge(ctx.THREE);
      g.userData.weatherBadge = badge;
      /* overlay 的局部原点 = 背景中心；house.cx/cy 是房屋相对背景中心的偏移，
       * 照它摆牌子，不管 offsetX/offsetZ 调成多少，牌子都跟在房屋右上方。
       * 默认机位是 (9,10,11) 俯视，(+4, 5, -3) 落在画面里且不会压住屋顶。 */
      const h = ctx.house || { cx: 0, cy: 0 };
      badge.sprite.position.set(h.cx + 4, 5, h.cy - 3);
      g.add(badge.sprite);
    }
    const w = (fields && fields.weather) || null;
    const m = (fields && fields.metric) || null;
    badge.sprite.visible = !!(w || m);
    if (!badge.sprite.visible) return;
    bgDrawBadge(badge, w, m);
    badge.tex.needsUpdate = true;
  },
});

})();
