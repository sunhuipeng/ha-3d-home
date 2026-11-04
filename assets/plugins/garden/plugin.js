/*
 * garden — 庭院铺装背景插件（kind: 'background'，位于 custom/plugins/garden）
 *
 * 原内置背景插件，已挪到自定义目录：面板里与内置 background 并列分组，
 * 两者同一套契约（PluginEngine.register + apply/update），互不影响。
 * 放在这里即可随便改——升级内置资产（assets/）不会覆盖本文件。
 * 插件 id 仍是 'garden'，所以已有的 style / backgroundOptions（'garden:stream' 等）全部照旧。
 *
 * apply 统一返回 { group: THREE.Group }（见 background/plugin.js 头部手册）：
 *   ① 扁平背景  → 鹅卵石 / 青砖 / 白砂: K.flat(ctx, 整图) —— 平面网格贴画好的 2048² 整图，
 *                 tile 平铺与否、颗粒密度都在插件内部消化，引擎不做 UV 假设
 *   ② 动态扁平  → 溪水（refresh: 12，即每秒回调 12 次：重绘 tile → 重铺 → 自己持有的贴图标脏）
 *   ③ 立体背景  → 汀步小径（ctx.plane(底图) + 按房屋尺寸确定性撒石板，同一个 group）
 *
 * ctx 由引擎提供: { THREE, size, house, safe, options, refresh, plane(src, sizeM?) }
 *   house   全屋墙包围盒（所有楼层并集，米）：minX/maxX/w=东西向，minY/maxY/d=南北向，
 *           cx/cy=房子中心（平面坐标，3D 里是 (cx, 0, cy)），hash=尺寸指纹（可当随机种子）
 *           注意坐标换算：平面 (x, y) → 3D (x, z)，高度才是 y 轴
 *   safe    安全边界：inner=1.5（房屋外扩禁放区）、outer=45（最远布置半径）、
 *           forbidden(x,z) 是否压到房子、allowed(x,z) 是否在可布置环带内
 *   options 面板参数（默认值 ∪ 用户已存值，合并好直接用，不用再写 || 兜底）
 *           参数在条目里用 options: [{ key, label, type, def, min?, max?, step?, choices?, tip? }]
 *           声明（type: range / number / select / checkbox / text），值存
 *           project.settings.backgroundOptions['<插件id>:<背景id>']（这里即 'garden:pebble'）
 *   refresh=刷新率(Hz)：0/不写 = 静态只画一次；1..30 = 每秒回调 update 这么多次
 *   plane   引擎工厂: canvas|Texture → 120m 平面网格（已摆正/居中到房屋下方/防闪面）
 *
 * 条目字段（每个 styles 条目 = 面板里的一个背景选项）：
 *   id（本插件内唯一）/ name（按钮文案）/ icon（emoji 或短文本）/ refresh / options /
 *   apply(ctx) → { group, refresh?, update?, size? }
 *   除这几个键以外，引擎不认条目上的其它字段（例如想把平铺次数写成顶层 repeat 是无效的，
 *   要可配置就放进 options 并声明同名 key）。
 *
 * 逐字段详细说明 + 最小示例见 assets/plugins/background/plugin.js 头部注释。
 */
'use strict';

/* 包一层 IIFE：多个 plugin.js 是独立 <script>、共享全局作用域，顶层 const/function 重名会 SyntaxError */
(function () {

/* ---------------- 贴图绘制（程序化生成，零资源文件） ----------------
 * 画布/噪点/确定性随机/平铺铺满/扁平组装/面板参数等通用底座
 * 已收敛到 PluginEngine.bgKit（与内置 background 插件共用），本文件只保留本插件特有的画法。 */

const K = PluginEngine.bgKit;

/* 鹅卵石: 密集椭圆石粒，缝隙深灰，跨边界补画保证平铺无缝 */
function gdPebble() {
  const S = 256;
  const cv = K.canvas(S), c = cv.getContext('2d');
  c.fillStyle = '#8d8a83';                    // 石缝底色
  c.fillRect(0, 0, S, S);
  const tones = ['#cfc9bd', '#c2bcae', '#d8d2c6', '#b9b2a4', '#e0dbd0', '#a8a294'];
  const draw = (x, y, r) => {
    const rot = Math.random() * Math.PI;
    const rx = r * (0.8 + Math.random() * 0.5), ry = r * (0.55 + Math.random() * 0.35);
    c.save();
    c.translate(x, y);
    c.rotate(rot);
    c.beginPath();
    c.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    c.fillStyle = tones[(Math.random() * tones.length) | 0];
    c.fill();
    c.globalAlpha = 0.28;
    c.beginPath();
    c.ellipse(-rx * 0.25, -ry * 0.3, rx * 0.5, ry * 0.45, 0, 0, Math.PI * 2);
    c.fillStyle = '#ffffff';
    c.fill();
    c.globalAlpha = 1;
    c.restore();
  };
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const r = 5 + Math.random() * 8;
    draw(x, y, r);
    // 贴边石粒在对面补一颗，避免平铺时出现硬切口
    if (x < r) draw(x + S, y, r);
    if (x > S - r) draw(x - S, y, r);
    if (y < r) draw(x, y + S, r);
    if (y > S - r) draw(x, y - S, r);
  }
  return cv;
}

/* 青砖: 交错砖缝，砖面色差 + 轻微磨损 */
function gdBrick() {
  const S = 256;
  const cv = K.canvas(S), c = cv.getContext('2d');
  c.fillStyle = '#b9b6ad';                    // 砖缝
  c.fillRect(0, 0, S, S);
  const rows = 8, h = S / rows, gap = 2;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (S / 8);          // 错缝
    for (let i = -1; i < 4; i++) {
      const w = S / 4;
      const x = i * w + offset + gap / 2;
      const y = r * h + gap / 2;
      const tone = 0.84 + Math.random() * 0.22;
      c.fillStyle = 'rgb(' + Math.round(146 * tone) + ',' + Math.round(152 * tone) + ',' + Math.round(148 * tone) + ')';
      c.fillRect(x, y, w - gap, h - gap);
      c.globalAlpha = 0.1;
      K.speckle(c, ['#6f7672', '#e8ece9'], 22, 0.8, 2.4);
      c.globalAlpha = 1;
    }
  }
  return cv;
}

/* 白砂（枯山水）: 细砂 + 耙出的同心弧纹；相位可动 */
function gdSand(phase) {
  const S = 256;
  const cv = K.canvas(S), c = cv.getContext('2d');
  c.fillStyle = '#efe9dc';
  c.fillRect(0, 0, S, S);
  K.speckle(c, ['#e6dfd0', '#f7f3ea', '#ded6c5', '#fbf8f1'], 2200, 0.5, 1.5);
  c.strokeStyle = 'rgba(196,182,158,.55)';
  c.lineWidth = 1.3;
  const cx = S / 2, cy = S / 2;
  for (let r = 12; r < S * 0.78; r += 7) {
    c.beginPath();
    c.arc(cx, cy, r + Math.sin(r * 0.6 + (phase || 0)) * 1.2, 0, Math.PI * 2);
    c.stroke();
  }
  return cv;
}

/* 溪水: 偏青的水色 + 横向细波；phase 让波纹流动 */
function gdStream(phase, cv) {
  phase = phase || 0;
  const canvas = cv || K.canvas();
  const c = canvas.getContext('2d');
  const S = canvas.width;
  const g = c.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, '#8fd2c4');
  g.addColorStop(0.5, '#6fbcae');
  g.addColorStop(1, '#8fd2c4');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  c.globalAlpha = 0.22;
  c.strokeStyle = '#ffffff';
  c.lineWidth = 1.2;
  for (let y = 0; y < S; y += 11) {
    c.beginPath();
    for (let x = 0; x <= S; x += 8) {
      const yy = y + Math.sin((x / S) * Math.PI * 3 + y * 0.22 + phase) * 2.2;
      x === 0 ? c.moveTo(x, yy) : c.lineTo(x, yy);
    }
    c.stroke();
  }
  c.globalAlpha = 1;
  return canvas;
}

/* ---------------- 自绘: 汀步小径 ---------------- */

/* 青苔砖底图（1024²，整块不重复，避免平铺网格感） */
function gdCourtBase(size) {
  const S = size || 1024;
  const cv = K.canvas(S), c = cv.getContext('2d');
  c.fillStyle = '#93a07f';
  c.fillRect(0, 0, S, S);
  const tones = ['#8b9a76', '#9dab86', '#83926e', '#a6b491', '#7c8a68'];
  for (let i = 0; i < 220; i++) {
    const r = S * (0.03 + Math.random() * 0.14);
    const x = Math.random() * S, y = Math.random() * S;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, tones[(Math.random() * tones.length) | 0]);
    g.addColorStop(1, 'rgba(147,160,127,0)');
    c.globalAlpha = 0.45;
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;
  K.speckle(c, ['#7c8a68', '#a9b795', '#8b9a76', '#b3c0a0'], 4200, 1.2, 3.6);
  return cv;
}

/* 自绘庭院: 底图平面 + 安全区内撒汀步石板（InstancedMesh 合批，1 个 draw call） */
function gdBuildCourt(ctx) {
  const T = ctx.THREE;
  const h = ctx.house || { cx: 0, cy: 0, w: 8, d: 8, hash: 'x' };
  const o = ctx.options || {};
  const stones = o.stones != null ? o.stones : 40;
  const sizeK = o.size != null ? o.size : 1;

  const g = new T.Group();
  g.name = 'backdrop:court';

  // 底图: 120m 一张图（引擎 helper 已摆正/居中/防闪面），1024² 保证近处不至于太糊
  g.add(ctx.plane(gdCourtBase(1024)));

  const rnd = K.rand(K.seed(h.hash || (h.cx + ',' + h.cy)));
  const mats = [];
  const dummy = new T.Object3D();
  let guard = 0;
  while (mats.length < stones && guard++ < stones * 60) {
    const ang = rnd() * Math.PI * 2;
    const rad = 2.2 + Math.sqrt(rnd()) * 26;
    const x = h.cx + Math.cos(ang) * rad;
    const z = h.cy + Math.sin(ang) * rad;
    if (ctx.safe && !ctx.safe.allowed(x, z)) continue;
    const w = (0.5 + rnd() * 0.55) * sizeK;
    dummy.position.set(x, 0.015, z);
    dummy.rotation.set(0, rnd() * Math.PI, 0);
    dummy.scale.set(w, 0.03, w * (0.7 + rnd() * 0.5));
    dummy.updateMatrix();
    mats.push(dummy.matrix.clone());
  }
  if (mats.length) {
    const geo = new T.CylinderGeometry(0.5, 0.5, 1, 7);   // 七棱扁石，比圆形更像汀步
    const mat = new T.MeshLambertMaterial({ color: 0xb9b3a6 });
    const inst = new T.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.matrixAutoUpdate = false;
    g.add(inst);
  }
  return g;
}

/* ---------------- 注册 ----------------
 * 铺满/扁平组装/面板参数等底座全部来自 PluginEngine.bgKit（见文件顶部说明）。 */
PluginEngine.register({
  id: 'garden',
  kind: 'background',
  name: '庭院铺装',

  /* 背景样式列表：与门窗/设备插件统一叫 styles（每项 apply(ctx) → { group }） */
  styles: [
    /* ① 扁平背景: tile 内部铺满，repeat=颗粒密度在这里消化 */
    { id: 'pebble', name: '鹅卵石', icon: '🪨', refresh: 0,
      options: [K.repeatOpt(18)],
      apply: (ctx) => ({ group: K.flat(ctx, K.fullPlane(gdPebble(), (ctx.options || {}).repeat), 'garden:flat') }) },

    { id: 'brick', name: '青砖', icon: '🧱', refresh: 0,
      options: [K.repeatOpt(20)],
      apply: (ctx) => ({ group: K.flat(ctx, K.fullPlane(gdBrick(), (ctx.options || {}).repeat), 'garden:flat') }) },

    { id: 'sand', name: '白砂枯山水', icon: '⛩', refresh: 0,
      options: [K.repeatOpt(14)],
      apply: (ctx) => ({ group: K.flat(ctx, K.fullPlane(gdSand(0), (ctx.options || {}).repeat), 'garden:flat') }) },

    /* ② 动态扁平背景: 溪水，引擎按 12Hz 回调；重画 tile → 重铺 → 自己持有的贴图标脏 */
    { id: 'stream', name: '溪水', icon: '🌊', refresh: 12,
      options: [
        K.repeatOpt(12),
        { key: 'speed', label: '流速', type: 'range', min: 0, max: 3, step: 0.1, def: 1.2 },
      ],
      apply(ctx) {
        const T = ctx.THREE, o = ctx.options || {};
        const tile = gdStream(0);                         // 无缝 tile: 动态时只重画这一小块
        const n = Math.max(1, Math.min(40, Math.round(o.repeat || 12)));
        const canvas = K.fullPlane(tile, n);
        const tex = new T.CanvasTexture(canvas);
        const g = new T.Group();
        g.name = 'garden:stream';
        g.add(ctx.plane(tex));
        return {
          group: g,
          /* 引擎按 refresh=12 调这个: 重画 tile → 内部重新铺满 → 贴图标脏 */
          update(t) {
            gdStream(t * (0.4 + (o.speed != null ? o.speed : 1.2) * 1.6), tile);
            K.retile(canvas, tile, n);
            tex.needsUpdate = true;
          },
        };
      } },

    /* ③ 立体背景: 底图平面 + 真 3D 汀步石板（同一个 group，扁平 + 立体混搭） */
    { id: 'court', name: '汀步小径（立体）', icon: '🪴', refresh: 0,
      options: [
        { key: 'stones', label: '石板数量', type: 'range', min: 0, max: 120, step: 5, def: 40 },
        { key: 'size', label: '石板大小', type: 'range', min: 0.5, max: 2, step: 0.1, def: 1 },
      ],
      apply(ctx) { return { group: gdBuildCourt(ctx) }; } },
  ],
});

})();
