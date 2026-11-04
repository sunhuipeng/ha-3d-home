/*
 * plugins.js — 有状态模型插件引擎
 *
 * 解决两类模型:
 *   1) 固定类型且无状态变化（家具）—— 静态 GLB，走 view3d 原有逻辑，不经过本引擎
 *   2) 固定类型且有状态变化（门/窗/灯/开关/空调…）—— 插件实现:
 *      - 静态部分用插件目录下的 GLB（可多个组合），动态部分（光圈/门扇/扇叶）由代码控制
 *      - 插件目录: assets/plugins/<id>/（内置）或 custom/plugins/<dir>/（自定义，同目录名覆盖内置），
 *        含 plugin.json（清单）+ plugin.js（注册代码）+ models/*.glb
 *      - 插件坐标系: model3d() 返回的 group 原点即锚点（门窗=门洞地面中心，设备=锚点离地点），
 *        摆放/旋转由引擎按户型数据设置，插件内部只管局部组装
 *      - 生命周期: model3d(ctx) → { group, update(), dispose() }；引擎在场景重建时 dispose，
 *        在 HA 实体状态变化时统一回调 update()
 *      - 实体监听: 插件在定义里声明 fields（界面把字段绑定到实体）+ obj.entityId；
 *        引擎只订阅一次 HA 'change'，任意实体变化都会对所有实例调 update()（不按键过滤，
 *        插件自己判断相关性即可）
 *
 * —— 一句话看懂「插件」是什么 ——
 *   插件 = 一个目录（清单 + 注册代码 + 可选模型），plugin.js 里调用一次
 *   PluginEngine.register({...}) 把「造型清单 + 画法」交给引擎。引擎只管：
 *   发现并加载插件、聚合造型、按实例创建 3D 对象、把状态变化分发下去、驱动逐帧动画、
 *   插件缺失/失败时放占位。**引擎里没有任何具体造型知识**（外形、图标、2D 符号全在插件）。
 *
 *   三类插件的注册面（逐字段手册见 assets/plugins/door/plugin.js 头部注释）：
 *     kind:'device'      model3d(ctx) → { group, update?, dispose? }
 *                        可选 click（点击控制）/ stateText（标签文案）/ plan2d（2D 符号）
 *     kind:'opening'     model3d(ctx) 同上，可选 plan2d / isOn（没有 click）
 *     kind:'background'  不写 model3d，styles[] 每项 apply(ctx) → { group, update?, refresh? }
 *
 *   加载与缓存: 服务端 /api/plugins 扫清单 → loadAll() 用 <script> 逐个加载，
 *   URL 带 ?v=<plugin.json 的 version>，而服务端对带 ?v= 的资源长缓存 immutable ——
 *   所以改过 plugin.js 必须同时升 plugin.json 的 version，否则浏览器不会拉新文件。
 *
 * 插件注册示例:
 *   PluginEngine.register({
 *     id: 'door', kind: 'opening', type: 'door', name: '门',
 *     fields: [{ key: 'entityId', label: '门磁实体' }],
 *     async model3d(ctx) { ...; return { group, update(), dispose() }; }
 *   });
 *   id  = 插件标识（同 id 覆盖内置）
 *   builtin = 内置插件标记（assets/plugins 下的插件都要带）；不带 = 自定义，
 *             样式面板据此显示「自定义」角标
 *   kind= 'device' | 'opening' | 'background'
 *   type= 插件归属的类型键：device 填 HA 实体类型（light/switch…），opening 填 door/window；
 *         同 type 的多个插件 styles 会合并展示（门窗「多插件」就是靠它）
 *
 * —— 本文件分区（按顺序读即可）——
 *   一、注册与加载     register / loadAll
 *   二、造型查询       defOf / defFor / styles / styleOf
 *   三、参数聚合       mergeOptions / styleOptionsOf / prefixItem（三类插件共用同一套）
 *   四、背景插件       bgKit / safeZone / applyBackground / 动态背景刷新
 *   五、点击与文案     clickSpec / labelOf / fieldBits / boundEntities
 *   六、上下文         _makeCtx —— 插件拿到的那一整套能力（THREE/几何/状态/扩展实体/animate）
 *   七、生命周期       _spawn / spawnOpening / spawnDevice / 占位 / updateAll / tick / reset
 */
'use strict';

/* 背景插件 id 变更记录: 旧 id → 当前 id（旧项目里的 settings.background 据此自动迁移） */
const BG_ID_ALIAS = { backdrop_ground: 'background' };

/* ---------------- options schema 的控件类型（唯一的类型白名单） ----------------
 * 只认 5 种：'range'（滑块+数字框）/ 'number'（数字框）/ 'select'（下拉，配 choices）/
 *            'checkbox'（复选框）/ 'text'（文本框）
 * 归一化在 register() 里做一次，下游（面板 / MCP / 预览）读到的 type 一定是这 5 个之一：
 *   · 没写 type、或写了不认识的值 → 'text'（文本框兜底，不再靠渲染层 v-else 猜）
 *   · 历史写法 'bool' → 'checkbox'（老插件代码不用改） */
const OPT_TYPES = ['range', 'number', 'select', 'checkbox', 'text'];
function normalizeOption(o) {
  if (!o || typeof o !== 'object') return o;
  const raw = String(o.type == null ? '' : o.type).toLowerCase();
  const type = raw === 'bool' ? 'checkbox' : (OPT_TYPES.indexOf(raw) >= 0 ? raw : 'text');
  return type === o.type ? o : Object.assign({}, o, { type });
}
function normalizeOptions(list) {
  return (Array.isArray(list) ? list : []).map(normalizeOption);
}

const PluginEngine = {
  defs: [],          // 已注册插件定义
  byId: {},          // id -> def
  instances: [],     // { def, obj, inst, anim }
  _ready: false,
  _loading: null,
  _glowTex: null,

  /* ---------------- 注册 ---------------- */
  register(def) {
    // 设备/门窗插件需要 model3d()；背景插件不需要 model3d，但要声明 styles 数组
    // （每项实现 apply(ctx) → { group }，扁平/立体/动态都走这一套；三类插件注册参数统一叫 styles）
    const isBg = def && def.kind === 'background';
    if (!def || !def.id || (!isBg && typeof (def.model3d || def.create) !== 'function')) return;
    if (isBg && !Array.isArray(def.styles)) return;
    // 门窗靠 type（'door' / 'window'）归入洞口类型 —— 漏写不会报错，但样式聚合不到面板，这里提示一下
    if (def.kind === 'opening' && !def.type && window.__HA_DBG !== false) {
      console.warn('[PluginEngine] opening 插件缺 type（应为 door 或 window），styles 不会出现在样式面板:', def.id);
    }
    // 资源基准目录: 插件自带模型按 <base>models/xxx 引用；默认跟随 plugin.js 实际所在目录
    // （内置 /assets/plugins/<id>/，用户自定义 /custom/plugins/<dir>/），插件也可显式传 base 覆盖
    def.base = def.base || ((typeof document !== 'undefined' && document.currentScript && document.currentScript.src)
      ? document.currentScript.src.replace(/\?.*$/, '').replace(/plugin\.js$/, '')
      : '/assets/plugins/' + def.id + '/');
    // 自定义标记以注册参数为准：内置插件显式声明 builtin:true，不带此参数的注册一律视为
    // 自定义 —— 样式面板 / 同类模型网格据此显示「自定义」角标。不依赖清单 id 与注册 id 的匹配，
    // 自定义代码爱用什么 id 注册都行。
    def.custom = !def.builtin;
    /* styles[].options 的 type 归一化（bool → checkbox；没写/写错 → text）：
       在这里做一次，样式面板、MCP 描述、预览引擎下游都不必再各自兜底 */
    if (Array.isArray(def.styles)) {
      def.styles = def.styles.map((s) => (s && Array.isArray(s.options))
        ? Object.assign({}, s, { options: normalizeOptions(s.options) })
        : s);
    }
    if (this.byId[def.id]) {   // 重复加载（热刷新）时替换
      const i = this.defs.indexOf(this.byId[def.id]);
      if (i >= 0) this.defs.splice(i, 1);
    }
    this._defCache = null;   // 插件集变了，defFor 查询缓存整体失效
    this.byId[def.id] = def;
    this.defs.push(def);
  },

  /* ---------------- 加载 assets/plugins 下所有插件 ---------------- */
  loadAll() {
    if (this._loading) return this._loading;
    this._loading = (async () => {
      let list = [];
      try {
        const r = await fetch('/api/plugins');
        list = (await r.json()).plugins || [];
      } catch (e) { /* 服务端不支持时无插件 */ }
      await Promise.all(list.map((p) => new Promise((res) => {
        const s = document.createElement('script');
        // 缓存: 用插件自带的 version 作为 ?v= 版本号（服务端对带 ?v= 的资源一律长缓存 immutable）。
        // 未声明 version 时回退 1，但 URL 仍带 ?v=1、同样长缓存一年 ——
        // 所以改过 plugin.js 就必须同时升 plugin.json 的 version，否则浏览器不会拉新。
        s.src = (p.entry || '/assets/plugins/' + encodeURIComponent(p.dir) + '/plugin.js') + '?v=' + encodeURIComponent(p.version || '1');
        s.onload = res; s.onerror = res;
        document.head.appendChild(s);
      })));
      // 引擎统一监听 HA 实体状态变化，分发给所有插件实例
      if (window.HA && HA.on) {
        HA.on('change', () => this.updateAll());
      }
      this._ready = true;
      this.updateAll();
    })();
    return this._loading;
  },

  get ready() { return this._ready; },

  /* ---------------- 造型/插件查询 ---------------- */
  /* 某类型的默认插件（typeOrKind 传设备 HA 类型或洞口类型 door/window）:
   * 同 id 的插件优先（内置 door/window/light 都是 id 与 type 同名），否则取第一个 type 匹配的 */
  defOf(typeOrKind) {
    const same = this.byId[typeOrKind];
    if (same && (same.kind === 'device' || same.kind === 'opening')) return same;
    return this.defs.find((d) => (d.kind === 'device' || d.kind === 'opening') && d.type === typeOrKind) || null;
  },

  /* 某个实例最终用哪个插件：样式条目自带 plugin（样式所属插件，如 mylamp 的造型），
   * 缺省回退默认插件。设备与门窗共用这一条规则 —— 切样式 = 换插件（含 fields / plan2d / click）。
   * 查询走 Map 缓存（2D 重绘每设备一次、3D 标签每帧一次，styles() 聚合不便宜）；
   * register / 热刷新时整体失效。 */
  defFor(typeOrKind, styleId) {
    if (!this._defCache) this._defCache = new Map();
    const k = typeOrKind + '|' + (styleId || '');
    if (this._defCache.has(k)) return this._defCache.get(k);
    const s = this.styleOf(typeOrKind, styleId);
    const v = (s && s.plugin && this.byId[s.plugin]) || this.defOf(typeOrKind);
    this._defCache.set(k, v);
    return v;
  },

  /* ---------------- 插件常用小工具（插件里不要再各写一份） ---------------- */
  /* 造型图标: 24×24 线性 SVG，颜色跟随主题（样式按钮里 v-html 渲染，不写 width/height） */
  ico(inner) {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" '
      + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  },
  /* 二态判定: on / open 都算「开」（门磁、窗磁、人体感应的通用口径） */
  isOnState(st) { return !!(st && (st.state === 'on' || st.state === 'open')); },
  /* 运行态: 只要不是 off / unavailable 就算在运行（空调、热水器这类有多模式值的域）
   * opts.countOff=true 时 'off' 也按运行处理（个别域用 off 表示待机） */
  runningState(st, opts) {
    if (!st || !st.state) return false;
    if (st.state === 'off' && !(opts && opts.countOff)) return false;
    return st.state !== 'unavailable';
  },
  /* 标签文案底座: on/off → 中文，其余状态原样；插件 stateText 第一句几乎都是它 */
  baseStateText(st, map) {
    if (!st) return '';
    const m = map || { on: '已开启', off: '已关闭' };
    return m[st.state] || st.state;
  },
  /* 某设备类型的全部插件造型（供 catalog.js 聚合到右侧样式面板）
   * 聚合 id 加插件前缀 '<插件id>:<造型id>'：多个插件（如 light / light_strip）都可能定义
   * id='strip' 的造型，前缀保证唯一；sid 保留插件内部原始 id，传给 model3d(ctx) 用
   * 参数 type 是「插件归属的类型键」：设备传 HA 实体类型（obj.type），门窗传 kind（door/window） */
  styles(type) {
    const out = [];
    this.defs.forEach((def) => {
      // device 与 opening 都按插件注册的 type 匹配，只是取值含义不同:
      //   device  → 实体类型（light / switch / fan …）
      //   opening → 洞口类型（door / window）
      // 所以一个洞口类型可以由多个插件共同提供造型：内置 door 之外，另建插件写
      // type:'door' 即可把自己的 styles 聚合进同一个门样式下拉（见 custom/plugins/door_rolling）。
      const hit = (def.kind === 'device' || def.kind === 'opening') && def.type === type;
      if (!hit) return;
      (def.styles || []).forEach((s) => {
        if (s && s.id) out.push(this.prefixItem(def, s));
      });
    });
    return out;
  },

  /* 某个造型定义（d.style 形如 '<插件id>:<造型id>'，缺省取该类型第一个） */
  styleOf(type, styleId) {
    const list = this.styles(type);
    return (styleId && list.find((s) => s.id === styleId)) || list[0] || null;
  },

  /* ---------------- 参数与条目聚合（背景 / 门窗 / 设备三抽象层共用） ---------------- */

  /* options schema 归一化（见文件头 OPT_TYPES）：bool → checkbox、缺省/未知 type → text。
   * register() 已对插件声明的 styles.options 做过一次；面板拿到的自定义数据再走一遍更稳。
   * 属性简写直接指向模块级函数，不另包一层 */
  normalizeOptions,

  /* 参数取值合并: 插件 schema 声明默认值，已保存值覆盖（null/undefined/'' 回退默认）。
   * 背景参数（存 project.settings.backgroundOptions）与造型条目参数（存 obj.styleOpts）
   * 是同一套 schema（range/number/select/checkbox/text），合并规则一致 → 收敛在一个实现 */
  mergeOptions(schema, saved) {
    const out = {};
    (schema || []).forEach((o) => {
      const v = (saved || {})[o.key];
      out[o.key] = (v === undefined || v === null || v === '') ? o.def : v;
    });
    return out;
  },

  /* 造型条目 options 当前值 = 条目声明的默认值 + 实例已存值（obj.styleOpts）合并。
   * 同一样式（如门「单开门」）可声明 options（左/右开门、内开/外开…），
   * 每个实例各自的取值存在 obj.styleOpts = { key: value } 上，面板据此渲染控件，
   * model3d(ctx) / plan2d(c, p) 里通过 ctx.options / p.options 读到合并后的值。 */
  styleOptionsOf(style, obj) {
    return this.mergeOptions(style && style.options, obj && obj.styleOpts);
  },

  /* 聚合条目加插件命名空间: id = '<插件id>:<条目id>'（多个插件可能定义同 id 条目），
   * sid 保留插件内部原始 id —— 传给 model3d/plan2d 的插件代码不感知聚合命名空间 */
  prefixItem(def, it) {
    /* custom 随 def 透传：造型来自 custom/plugins 时，样式/同类模型网格显示「自定义」角标 */
    return Object.assign({}, it, { id: def.id + ':' + it.id, sid: it.id, plugin: def.id, custom: !!def.custom });
  },

  /* ---------------- 背景插件共享工具（PluginEngine.bgKit） ----------------
   * kind:'background' 的插件几乎都要「程序化画一张无缝 tile → 铺满 2048² 大图 →
   * ctx.plane() 贴到 120m 平面」。这些底座原先在 background / garden 里各抄一份，
   * 收敛到这里，背景插件按需取用（不需要的函数可以不用）。 */
  bgKit: {
    /* 空白画布（正方形，缺省 256） */
    canvas(size) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = size || 256;
      return cv;
    },
    /* 均匀噪点: 在 (canvas 上下文 c) 上撒 count 个颜色随机的小圆 */
    speckle(c, colors, count, sizeMin, sizeMax) {
      const S = c.canvas.width;
      for (let i = 0; i < count; i++) {
        c.fillStyle = colors[(Math.random() * colors.length) | 0];
        const r = sizeMin + Math.random() * (sizeMax - sizeMin);
        c.beginPath();
        c.arc(Math.random() * S, Math.random() * S, r, 0, Math.PI * 2);
        c.fill();
      }
    },
    /* 确定性随机（种子 → 可复现序列）: 同一栋房子每次重建道具位置不变 */
    seed(str) {
      let h = 2166136261;
      const s = String(str || '');
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      return h >>> 0;
    },
    rand(seed) {
      let s = (seed || 1) >>> 0;
      return function () {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
      };
    },
    /* 无缝 tile 铺满: 把 tile 画布 n×n 次画到大画布 cv 上 */
    retile(cv, tile, n) {
      const c = cv.getContext('2d'), S = cv.width, step = S / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          c.drawImage(tile, i * step, j * step, step, step);
        }
      }
      return cv;
    },
    /* tile → 铺满一张 2048² 大图（n = 每边平铺次数，自动夹取 1~40） */
    fullPlane(tile, n) {
      n = Math.max(1, Math.min(40, Math.round(n || 20)));
      return this.retile(this.canvas(2048), tile, n);
    },
    /* 扁平背景 = 平面网格贴画好的整图（ctx.plane 由引擎提供，已摆正/中心=背景中心/防闪面）
     * name 给 group 起个可辨识的名字（'background:flat' / 'garden:flat'） */
    flat(ctx, cv, name) {
      const g = new ctx.THREE.Group();
      g.name = name || 'background:flat';
      g.add(ctx.plane(cv));
      return g;
    },
    /* 右侧面板「颗粒密度」参数（range 控件，key 固定 repeat） */
    repeatOpt(def) {
      return { key: 'repeat', label: '颗粒密度', type: 'range', min: 8, max: 40, step: 2, def };
    },
    /* 背景整体偏移参数（引擎保留键 offsetX/offsetZ，米，默认 0 = 房屋落在背景中心）：
     * 偏移会算进 ctx.house / ctx.safe（背景坐标系里房屋的位置），插件照 house.cx/cy 构图即可。
     * 返回数组，展开进样式的 options: [...K.offsetOpts()] */
    offsetOpts(range) {
      const m = range || 30;
      return [
        { key: 'offsetX', label: '东西偏移', type: 'range', min: -m, max: m, step: 0.5, def: 0, tip: '房屋在背景画面里东/西偏多少米（+西 = 往右拖背景左移，房屋相对偏东）' },
        { key: 'offsetZ', label: '南北偏移', type: 'range', min: -m, max: m, step: 0.5, def: 0, tip: '房屋在背景画面里南/北偏多少米（+北 = 往右拖背景上移，房屋相对偏南）' },
      ];
    },
  },

  /* 标题标签相对设备锚点的抬升高度（造型可声明 labelOffset，缺省 0.3m）。
   * 设备实例可用 obj.labelOffset 覆盖（属性面板「标签高度」），View3D 取实例值优先 */
  labelOffset(type, styleId) {
    const s = this.styleOf(type, styleId);
    return s && s.labelOffset != null ? s.labelOffset : 0.3;
  },

  /* 门/窗的 2D 模型（平面符号）：造型差异（单开/双开/卷帘/推拉/固定…）交给插件自绘，
   * 编辑器只保留一份通用兜底。插件可选声明 plan2d(c, p)：
   *   c  CanvasRenderingContext2D，已 translate 到洞口中心、rotate 到墙方向（不要自己再变换）
   *   p  { L: 屏幕像素宽度, sel: 是否选中, on: 是否打开(插件 isOn 优先，缺省主实体 on/open),
   *        ink: 默认描边色, fill: 默认填充色(开=暖琥珀/关=白，填进封闭形状内部),
   *        ppm: 像素/米, style: 造型内部 id, kind: 'door'|'window',
   *        entityId: 绑定实体 id, state: 绑定实体状态对象, obj: 放置数据(含拓展实体字段),
   *        getState: (entityId) => 状态对象|null —— 查任意/拓展实体状态,
   *        rrect(x,y,w,h,rad) / draw(fn): 圆角矩形路径、建路径后统一填色+描边（见 planKit） }
   * 返回 (c, p) => void；插件没写 plan2d 时返回 null，编辑器退回通用符号。 */
  openingPlan(kind, styleId) {
    const def = this.defFor(kind, styleId);
    const fn = def && def.plan2d;
    if (!fn) return null;
    const style = this.styleOf(kind, styleId);
    const sid = (style || {}).sid;
    return (c, p) => {
      try {
        /* style: 造型内部 id；options: 造型条目参数合并默认值（p.obj.styleOpts），2D 符号据此画差异 */
        fn(c, planKit(c, Object.assign({ style: sid, kind, options: this.styleOptionsOf(style, p.obj) }, p)));
      } catch (e) {
        console.warn('[plugins] plan2d 绘制失败:', kind, sid, e);
      }
    };
  },

  /* 门/窗的「开」判定: 插件可选声明 isOn(obj, get)（放在 register 顶层，与 plan2d 同级），
   * 按自己 fields 绑定的一个或多个实体组合判断是否打开（如窗 = 开关 on 且开度>0）。
   *   obj  放置数据（obj.entityId / fields 里声明的拓展实体 key 都在上面）
   *   get  (entityId) => 状态对象|null
   * 返回 boolean|null：插件没实现返回 null → 调用方用默认规则（主实体 on/open）。
   * 插件实现抛异常时 warn 并回退默认，不会中断渲染。 */
  openingIsOn(kind, styleId, obj, get) {
    const def = this.defFor(kind, styleId);
    if (def && typeof def.isOn === 'function') {
      try {
        return !!def.isOn(obj, get);
      } catch (e) {
        console.warn('[plugins] opening isOn 判定失败:', kind, e);
      }
    }
    return null;
  },

  /* 设备 2D 模型的统一调色板: 状态/选中视觉全部由抽象层接管，插件 plan2d 只画中性线稿模型。
   *   st  { sel, on, hasState }
   * 返回:
   *   fill    状态填充色: 开=#fdeecb(暖琥珀) / 关=#fff —— **填在线稿封闭形状内部**（贴合线框，
   *           透明角落不着色），没有封闭形状的符号（灯带/窗帘）画一条贴合的圆角底条
   *   ink     描边主色: 正常=中灰 / 未连接=红（选中态由抽象层画蓝色虚线圈，不经 ink）
   *   accent  固定中性浅灰（活动部件）
   *   accent2 固定中性中灰（感应波/栅条/气流等次级部件）
   *   lw      固定 1.6（选中强调由虚线圈承担，线宽不变）
   * p.sel / p.on / p.hasState 仍会传入，插件只在「结构」上用（如某细节画不画），不再管颜色。 */
  devicePalette(st) {
    const on = !!st.on, has = st.hasState !== false;
    return {
      fill: on ? '#fdeecb' : '#fff',
      ink: has ? '#6b7280' : '#d94f4f',
      accent: '#c3cad6',
      accent2: '#9aa3b2',
      lw: 1.6,
    };
  },

  /* 设备的 2D 模型（平面简笔）: 与门窗一样交给插件自绘（def.plan2d(c, p)），编辑器只保留兜底。
   * 注意区别: 门窗插件有宽度属性（编辑器传 L = w*ppm，符号沿墙展开），
   * 设备是「点状物」没有宽度，插件按尺寸(米) × p.ppm 画自己的图形。
   *   c  CanvasRenderingContext2D，已 translate 到设备锚点并按水平旋转 rotate（不要自己再变换）
   *   p  { sel: 是否选中, on: 是否开启（插件 click.isOn 优先）, hasState: 是否连上实体,
   *        ppm: 像素/米, type: 设备类型, style: 造型内部 id,
   *        entityId: 绑定实体 id, state: 绑定实体状态对象, obj: 放置数据(含拓展实体字段),
   *        getState: (entityId) => 状态对象|null —— 查任意/拓展实体状态,
   *        fill / ink / accent / accent2 / lw: 抽象层算好的调色板（见 devicePalette）}
   *   插件只画中性线稿：状态色用 p.fill 填进封闭形状内部，选中圈/描边强调由编辑器负责；
   *   不要再铺整圆背景，也不要画随机装饰（每次重绘会闪）。
   * 返回 (c, p) => 包围半径(像素)；插件没写 plan2d 时返回 null。
   * styleId 传设备的 obj.style：同 type 多插件时，2D 符号取「当前样式所属插件」那一份 */
  devicePlan(type, styleId) {
    const def = this.defFor(type, styleId);
    const fn = def && def.plan2d;
    if (!fn) return null;
    return (c, p) => {
      try { return fn(c, planKit(c, p)); }
      catch (e) { console.warn('[plugins] 设备 plan2d 绘制失败:', type, e); return null; }
    };
  },

  /* ---------------- 背景插件（kind: 'background'） ----------------
   * 背景 = 房屋外围的地面。**统一返回 3D 模型**: apply(ctx) → { group: THREE.Group }。
   * 不存在「平面 / canvas」两种模式 —— 扁平背景只是「比较扁的 3D 模型」:
   *   - 扁平地面: g.add(ctx.plane(画布|贴图))  ← 把画好的整图贴到 120m 平面网格上（最常用）
   *     是否平铺、颗粒密度等参数都在画图时自己消化，引擎不做任何 UV 假设
   *   - 立体造型: 在同一个 group 里再放起伏地形 / 草丛 / 石头等体块（参考草原插件）
   * 静态 / 动态由插件声明：
   *   refresh: 0 / 缺省  → 静态，只在切换时画一次（零每帧开销）
   *   refresh: 1..30     → 每秒回调 update(t, api) 这么多次（水面波动 / 落叶 / 云影）
   * ctx = { THREE, size, house, safe, options, refresh, plane(画布|贴图, 尺寸M?), planeSize }
   *   house: 背景坐标系里的房屋包围盒 { minX,maxX,minY,maxY,w,d,cx,cy,floors,hash }
   *          ⚠ 坐标系原点 = **背景中心**（不是房屋中心）：房屋可能偏在一边，
   *          cx/cy 就是偏移量（米），0/0 = 房屋正落在背景中心。
   *          画布/平面都要按它摆：canvas 中心 ↔ 背景中心，房屋画在 (cx, cy)
   *   safe : 安全边界 { inner, outer, x0,x1,y0,y1, forbidden(x,z), allowed(x,z) }
   *          同样在背景坐标系里算（房屋外扩 1.5m = 禁放区），撒点照着它就不会压到房子
   *   plane(): 引擎组装好的地面网格（默认 120m、中心对准背景中心、y=-0.05），add 进 group 即用
   * update(t, api) 的 api = { group, mesh, size }；动态改图请插件自己持有 CanvasTexture，
   *   改完直接 tex.needsUpdate = true（引擎不提供贴图回写通道）
   * → 每个字段的含义、坐标换算、可复制示例见 assets/plugins/background/plugin.js 头部注释
   * 房屋尺寸变化（改墙/加层）时引擎自动重放背景（见 view3d.build），插件不需要感知重建时机。
   */

  bgAnim: null,     // 当前动态背景的运行记录 { id, hz, interval, acc, t, fn, api, errs }
  bgOptions: {},    // 背景参数值: { '<插件id>:<背景id>': { key: value } }（app 注入 project.settings.backgroundOptions 的引用）

  /* 全部背景（带插件前缀；条目聚合与设备/门窗样式共用 prefixItem） */
  backgrounds() {
    const out = [];
    this.defs.forEach((def) => {
      if (def.kind !== 'background') return;
      (def.styles || []).forEach((b) => {
        if (!b || !b.id) return;
        out.push(Object.assign(this.prefixItem(def, b), {
          group: def.name || def.id,
          icon: b.icon || '🖼',
          hz: this.refreshOf(b),
        }));
      });
    });
    return out;
  },

  /* 刷新率: 声明 refresh（Hz）；0/非法 = 静态。上限 30，避免插件把主线程写爆 */
  refreshOf(item) {
    const n = Number(item && item.refresh);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.max(1, Math.min(30, Math.round(n)));
  },

  /* 安全边界: 房屋占地外扩 inner(m) 为禁放区，outer(m) 为建议最远布置半径。
   * 传进来的 house 已经在「背景坐标系」里（cx/cy = 房屋相对背景中心的偏移），
   * 所以禁放矩形和可布置圆都自动跟着偏移走。 */
  safeZone(house) {
    const inner = 1.5, outer = 45;
    const x0 = house.minX - inner, x1 = house.maxX + inner;
    const y0 = house.minY - inner, y1 = house.maxY + inner;
    const z = {
      inner, outer, x0, x1, y0, y1,
      /* 是否落在禁放区（房屋占地 + 走廊） */
      forbidden(x, zz) { return x > x0 && x < x1 && zz > y0 && zz < y1; },
      /* 是否在可布置环带内（禁放区外 + 半径 outer 内） */
      allowed(x, zz) {
        if (x > x0 && x < x1 && zz > y0 && zz < y1) return false;
        const dx = x - house.cx, dz = zz - house.cy;
        return dx * dx + dz * dz <= outer * outer;
      },
    };
    return z;
  },

  /* 按插件分组（面板直接渲染: [{ plugin, name, items:[...] }]） */
  backgroundGroups() {
    const map = new Map();
    this.backgrounds().forEach((b) => {
      if (!map.has(b.plugin)) map.set(b.plugin, { plugin: b.plugin, name: b.group, items: [] });
      map.get(b.plugin).items.push(b);
    });
    return Array.from(map.values());
  },

  /* 背景聚合 id 归一化: 早期插件目录/注册 id 为 backdrop_ground，已更名为 background；
   * 旧项目里存的 'backdrop_ground:grass' 自动映射到 'background:grass'，参数键同步迁移。 */
  migrateBgId(id) {
    if (typeof id !== 'string' || !id) return '';
    const i = id.indexOf(':');
    if (i < 0) return id;
    const pid = BG_ID_ALIAS[id.slice(0, i)];
    return pid ? pid + id.slice(i) : id;
  },

  /* 就地迁移项目设置（settings.background / settings.backgroundOptions 的键） */
  migrateProjectBg(settings) {
    if (!settings || typeof settings !== 'object') return;
    if (settings.background) settings.background = this.migrateBgId(settings.background);
    const opts = settings.backgroundOptions;
    if (opts && typeof opts === 'object') {
      Object.keys(opts).forEach((k) => {
        const nk = this.migrateBgId(k);
        if (nk === k) return;
        opts[nk] = Object.assign({}, opts[k], opts[nk] || {});   // 新键已有的值优先
        delete opts[k];
      });
    }
  },

  backgroundOf(id) {
    if (!id) return null;
    const key = this.migrateBgId(id);
    return this.backgrounds().find((b) => b.id === key) || null;
  },

  /* 某个背景的参数定义（属性面板据此渲染控件） */
  optionsSchema(id) {
    const bd = this.backgroundOf(id);
    return (bd && bd.options) || [];
  },

  /* 参数当前值 = 插件声明的默认值 + 已保存值的合并（与造型条目参数共用 mergeOptions） */
  optionsOf(bd) {
    const saved = (this.bgOptions && this.bgOptions[bd.id]) || {};
    return this.mergeOptions(bd && bd.options, saved);
  },

  /* 应用背景: 只换地面；找不到插件/背景 → 回退默认地面（网格）。返回是否命中插件背景。
   * apply 只接受一种成品: { group }（扁平背景 = group 里放 ctx.plane(整图)）。
   * 没有 group 视为插件没画好，直接清空背景并返回 false。 */
  applyBackground(id, view3d) {
    const v3 = view3d || window.View3D || null;
    this.stopBackground();                       // 先停旧动画，避免它继续写已释放的贴图
    if (!v3 || !v3.scene) return false;

    const clearAll = () => {
      if (v3.clearBackdrop) v3.clearBackdrop();
      if (v3.setGridVisible) v3.setGridVisible(true);
    };

    if (!id) { v3.bgId = ''; clearAll(); return false; }
    const bd = this.backgroundOf(id);
    if (!bd) { v3.bgId = ''; clearAll(); return false; }
    v3.bgId = bd.id;   // 记住当前背景（已归一化）: 房屋尺寸变化时 view3d.build 会据此重放

    /* 真实房屋包围盒（世界坐标）。背景自己在「背景坐标系」里画，房屋可以不在画面中心，
     * 所以下面要把它换算到背景坐标系（原点 = 背景中心），换算量就是偏移参数。 */
    const real = v3.houseBounds ? v3.houseBounds() : null;

    /* 背景参数（含引擎保留偏移键 offsetX / offsetZ，米）：
     *   = 房屋相对「背景中心」的偏移，0 = 房屋居中（默认）。
     *   正值手感沿用「往右拖 = 背景往左/往上」，即 +X = 房屋偏东、+Z = 房屋偏南。
     * 偏移直接算进 ctx.house / ctx.safe —— 插件拿到的是背景坐标系里的房屋位置，
     * 构图、撒点都能知道房子不在画面正中央。 */
    const bgOpts = this.optionsOf(bd);
    const clampOff = (v) => Math.max(-60, Math.min(60, Number(v) || 0));
    const offX = clampOff(bgOpts.offsetX);
    const offZ = clampOff(bgOpts.offsetZ);

    /* house：背景坐标系里的房屋（cx/cy = 偏移量，不再是「世界中心」） */
    const house = real ? {
      minX: real.minX - real.cx + offX, maxX: real.maxX - real.cx + offX,
      minY: real.minY - real.cy + offZ, maxY: real.maxY - real.cy + offZ,
      w: real.w, d: real.d,
      cx: offX, cy: offZ,
      floors: real.floors,
      hash: real.hash,
    } : null;

    /* 平面默认边长：至少 120m；偏移把房子推到边缘时才自动放大，保证房屋整块踩在地面上 */
    const needHalf = house
      ? Math.max(Math.abs(offX) + house.w / 2, Math.abs(offZ) + house.d / 2) + 4
      : 0;
    const planeM = Math.max(120, needHalf * 2);

    /* ctx: 引擎把「房屋尺寸 + 安全边界 + 用户参数 + 地面网格工厂」交给插件，
     * 插件不需要自己测尺寸、摆平面，也不需要感知"何时该重建" */
    const mkPlane = (src, sizeM) => {
      const T = window.THREE;
      const tex = (src && src.isTexture) ? src : new T.CanvasTexture(src);
      if (v3.renderer && v3.renderer.capabilities) {
        tex.anisotropy = Math.min(4, v3.renderer.capabilities.getMaxAnisotropy());
      }
      tex.needsUpdate = true;
      const m = sizeM || planeM;
      const mesh = new T.Mesh(
        new T.PlaneGeometry(m, m),
        new T.MeshLambertMaterial({ map: tex })
      );
      mesh.rotation.x = -Math.PI / 2;
      /* 平面中心 = 背景中心（原点），不是房屋中心：房屋按 house.cx/cy 偏到一边 */
      mesh.position.set(0, -0.05, 0);   // 压到地板下方一点，避免 z-fighting
      return mesh;
    };
    const ctx = {
      THREE: window.THREE, size: 512, house,
      safe: house ? this.safeZone(house) : null,
      options: bgOpts,
      refresh: this.refreshOf(bd),
      plane: mkPlane,
      planeSize: planeM,   // 默认平面边长（米）：画布 ↔ 米 的换算用得上
    };

    let out = null;
    try {
      out = (typeof bd.apply === 'function' ? bd.apply(ctx) : bd) || {};
    } catch (e) {
      console.warn('[PluginEngine] 背景插件执行失败:', bd.id, e);
      clearAll();
      return false;
    }

    /* 刷新率: 条目声明优先，apply 返回值可覆盖；0 = 静态 */
    const hz = this.refreshOf(out.refresh != null ? out : bd);
    const upd = typeof out.update === 'function' ? out.update : null;

    /* 挂载: 统一 3D 模型 —— apply 必须返回 { group, update? }（扁平背景也是一个平面网格的 group） */
    if (!out.group) { clearAll(); return false; }

    /* 落位：group 的局部原点 = 背景中心，摆到世界里的「房屋中心 − 偏移」处。
     * 于是世界里的房屋纹丝不动，背景整体绕着它偏 —— 等价于「房屋偏离背景中心」。
     * 方向沿用统一手感（往右拖 = 背景往左/上）：
     * offsetX +西 = 屏幕左，offsetZ +北 = 屏幕上（内部换算到 three.js +X=东 / +Z=南）。 */
    const base = real || { cx: 0, cy: 0 };
    out.group.position.set(base.cx - offX, 0, base.cy - offZ);

    const handle = v3.setBackdrop(out.group);
    if (!handle) return false;
    if (upd && hz > 0) this._startBackground(bd.id, hz, upd, handle, out);
    return true;
  },

  /* ---------------- 动态背景（refresh > 0 才会走到这里） ---------------- */
  _startBackground(id, hz, fn, handle, out) {
    /* api 只暴露只读引用：动态改图由插件自己持有 CanvasTexture 并标脏，
     * 引擎不再提供 needsUpdate()/texture 回写（统一 group 模型下没有"当前贴图"的概念） */
    const api = {
      group: handle.group || (out.group || null),
      mesh: handle.mesh || null,
      size: out.size || 512,
    };
    const rec = { id, hz, interval: 1 / hz, next: 1 / hz, t: 0, fn, api, errs: 0 };
    this.bgAnim = rec;
    try { fn(0, api); } catch (e) { this._bgFail(rec, e); }   // 立刻画一帧，避免首帧空白
    return rec;
  },

  stopBackground() { this.bgAnim = null; },

  /* 由 view3d.startLoop → tick 每帧驱动，按各自刷新率节流；静态背景不进这里，零开销。
   * 用「下一次触发时刻」而不是累加器：60fps 下跑 10Hz 不会因为浮点漂移少触发。 */
  tickBackground(dt) {
    const a = this.bgAnim;
    if (!a) return;
    const d = Math.min(0.25, Math.max(0, dt || 0));   // 切回标签页时的长 dt 不追帧
    a.t += d;
    if (a.t < a.next) return;
    const steps = Math.floor((a.t - a.next) / a.interval) + 1;
    // 掉帧（steps 偏大）时只补一次并对齐到下一个间隔，避免连续补帧雪崩
    a.next = steps > 2 ? a.t + a.interval : a.next + steps * a.interval;
    try { a.fn(a.t, a.api); } catch (e) { this._bgFail(a, e); }
  },

  _bgFail(a, e) {
    a.errs++;
    if (a.errs === 1) console.warn('[PluginEngine] 背景刷新出错:', a.id, e);
    if (a.errs >= 3) { console.warn('[PluginEngine] 背景连续出错，已停止刷新:', a.id); this.bgAnim = null; }
  },

  /* ---------------- 点击控制规格 ----------------
   * 插件可在注册对象里声明 click:
   *   click: {
   *     on:  'turn_on' | { service: 'media_play', domain: 'media_player' },
   *     off: 'turn_off',
   *     isOn: (state) => boolean,   // 可选: 判定"当前已开启"，缺省按 state != off/unavailable
   *     label: '播放 / 暂停',        // 可选: 属性面板勾选文案
   *     defaultOn: false            // 可选: 未勾选时是否默认可点击（默认 true）
   *   }
   * 未声明 click 时按 type 取内置默认（灯/开关/风扇/窗帘 toggle，热水器/空调 turn_on/off）。
   * 返回 null 表示该类型不支持点击控制（如纯展示设备）。
   */
  CLICK_DEFAULTS: {
    light:        { on: 'toggle', off: 'toggle', label: '开 / 关' },
    switch:       { on: 'toggle', off: 'toggle', label: '开 / 关' },
    fan:          { on: 'toggle', off: 'toggle', label: '开 / 关' },
    cover:        { on: 'toggle', off: 'toggle', label: '开 / 关' },
    water_heater: { on: 'turn_on', off: 'turn_off', label: '开 / 关' },
    climate:      { on: 'turn_on', off: 'turn_off', label: '开 / 关' },
  },

  /* 点击规格: 插件注册的 click 优先，其次内置默认。
   * styleId 传设备 obj.style —— 同 type 多插件时按「当前样式所属插件」的 click 声明走 */
  clickSpec(type, styleId) {
    const def = this.defFor(type, styleId);
    const raw = (def && def.click) || this.CLICK_DEFAULTS[type];
    if (!raw) return null;
    const svc = (v, fb) => (typeof v === 'string' ? v : (v && v.service) || fb);
    const domainOf = (v) => (v && typeof v === 'object' && v.domain) || (def && def.type) || type;
    return {
      domain: domainOf(raw.on) || domainOf(raw.off),
      on: svc(raw.on, 'toggle'),
      off: svc(raw.off, 'toggle'),
      isOn: typeof raw.isOn === 'function' ? raw.isOn : null,
      label: raw.label || '开 / 关',
      feedback: raw.feedback === true,   // 无可见状态变化的动作（如刷新读数）执行后弹提示
      defaultOn: raw.defaultOn !== false,
    };
  },

  /* ---------------- 状态文案 ----------------
   * 插件可声明 stateText(st, obj, get) → 返回标题标签上显示的状态文案（自带单位/百分比/图标），
   * 返回空值则调用方回退到通用规则（on/off + unit）。
   * 文案是各设备的领域知识（空调模式、扫地机状态、音量百分比…），放插件里，
   * 避免 view3d 里堆积按 type 分支的映射表。
   * st  = 主实体状态；obj = 设备/门窗数据（含扩展实体绑定字段）；
   * get = 便捷读取函数 (eid) => state，插件用它把扩展实体的数据拼进文案。
   * styleId 传设备 obj.style —— 同 type 多插件时文案由「当前样式所属插件」出
   */
  labelOf(type, st, obj, get, styleId) {
    const def = this.defFor(type, styleId);
    if (!def || typeof def.stateText !== 'function' || !st) return null;
    const read = typeof get === 'function' ? get : (eid) => (window.HA ? HA.getState(eid) : null);
    try {
      const t = def.stateText(st, obj || {}, read);
      return t || null;
    } catch (e) {
      console.warn('[plugin:' + def.id + '] stateText 出错', e);
      return null;
    }
  },

  /* 插件定义的绑定字段（驱动属性面板 UI）
   * device/opening 通用：fields 里的字段一律渲染成实体搜索框（entity-input），
   * 值存在 obj[field.key] 上，引擎据此监听状态并分发 update（见 boundEntities）。
   * 主实体（obj.entityId）由「设备绑定」单独管理，不要重复声明在 fields 里。 */
  fieldsOf(def) { return (def && def.fields) || []; },

  /* 扩展实体读数拼接（供插件 stateText 复用）
   * list: [[fieldKey, (state, num|null) => '有人'|'45W'|''], ...]
   * 未绑定 / 实体不存在 / 格式化返回空 → 跳过；结果形如 ' · 有人 · 320lx' */
  fieldBits(obj, get, list) {
    if (!obj || typeof get !== 'function') return '';
    const parts = [];
    (list || []).forEach(([key, fmt]) => {
      const eid = obj[key];
      if (!eid) return;
      const st = get(eid);
      if (!st) return;
      const n0 = parseFloat(st.state);
      let t = '';
      try { t = fmt(st, isNaN(n0) ? null : n0) || ''; } catch (e) { t = ''; }
      if (t) parts.push(t);
    });
    return parts.length ? ' · ' + parts.join(' · ') : '';
  },

  /* 实例绑定的实体集合: obj.entityId + fields 声明字段的值 */
  boundEntities(obj, def) {
    const set = new Set();
    if (obj && obj.entityId) set.add(obj.entityId);
    this.fieldsOf(def).forEach((f) => { if (obj && obj[f.key]) set.add(obj[f.key]); });
    return set;
  },

  /* ---------------- 上下文（传给插件 model3d 的能力集） ---------------- */
  _makeCtx(def, obj, view, extra) {
    const T = window.THREE;   // Three.js 命名空间（插件页面加载时已就绪）
    const self = this;
    const lambertF = (color, opts) => new T.MeshLambertMaterial(Object.assign({ color: new T.Color(color) }, opts || {}));
    let glowCache = null;   // 径向渐变光晕贴图（跨实例共享）
    const glowTexF = () => {
      if (!glowCache) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        const g = cv.getContext('2d');
        const rg = g.createRadialGradient(32, 32, 2, 32, 32, 30);
        rg.addColorStop(0, 'rgba(255,220,150,.9)');
        rg.addColorStop(1, 'rgba(255,200,100,0)');
        g.fillStyle = rg;
        g.fillRect(0, 0, 64, 64);
        glowCache = new T.CanvasTexture(cv);
      }
      return glowCache;
    };
    const ctx = Object.assign({
      THREE: window.THREE,
      obj,                    // 门窗/设备数据对象（x/y/rot/entityId…）
      view,                   // View3D 引用
      wallH: view.wallH,
      baseUrl: def.base,
      /* 加载插件目录下 models/xx.glb（返回 Promise<scene|null>）
       * 注意: 缓存的是原型对象，每次返回 clone —— Three.js 对象只能有一个父节点，
       * 同一插件多实例（如 3 扇门共用 frame.glb）若直接 add 会互相"抢走"模型 */
      glb(file) { return view.loadModel(def.base + file).then((s) => (s ? s.clone(true) : null)); },
      /* 洞口框（门/窗通用）: 优先取插件目录下 models/frame.glb，按洞宽等比缩放
       *   ref     glb 对应的标准洞宽（窗 1.2m / 门 0.9m），L/ref 即缩放系数
       *   fallback(L) 可选，GLB 缺失时用代码盒条兜底；不传则用引擎内置兜底
       *           —— ref ≤ 1m 按门框（通高门套 '#d9d4c8'），否则按窗框（1.5m 居中窗套 '#9aa7b5'），
       *              几何与 door/window 插件原各自实现的兜底一致，插件无需再维护
       * 返回是否用上了 GLB */
      async frame(g, L, ref, fallback) {
        const proto = await this.glb('models/frame.glb');
        if (proto) { proto.scale.x = L / (ref || 1.2); g.add(proto); return true; }
        if (typeof fallback !== 'function') fallback = frameFallback(this, g, ref || 1.2);
        fallback(L);
        return false;
      },
      /* 几何/材质 helpers */
      lambert(color, opts) { return new T.MeshLambertMaterial(Object.assign({ color: new T.Color(color) }, opts || {})); },
      box(parent, w, h, d, x, y, z, color, opts) {
        const m = new T.Mesh(new T.BoxGeometry(w, h, d), lambertF(color, opts));
        m.position.set(x, y, z);
        parent.add(m);
        return m;
      },
      cyl(parent, rt, rb, h, seg, x, y, z, color, opts) {
        const m = new T.Mesh(new T.CylinderGeometry(rt, rb, h, seg), lambertF(color, opts));
        m.position.set(x, y, z);
        parent.add(m);
        return m;
      },
      sphere(parent, r, x, y, z, color, opts) {
        const m = new T.Mesh(new T.SphereGeometry(r, 16, 10), lambertF(color, opts));
        m.position.set(x, y, z);
        parent.add(m);
        return m;
      },
      /* 径向渐变光晕贴图（共享） */
      glowTexture() { return glowTexF(); },
      /* 发光灯 kit: 灯泡 + 光晕 + 点光源 + 方向性聚光，set(on, rgb) 一键切换（灯具类插件用）
       * opts.dir 发光方向:
       *   'down'  向下锥形扩散（吸顶灯/吊灯/筒灯——从天花板向地面和四周）
       *   'wall'  向墙外斜下扩散（壁灯，局部 +Z 为墙外方向）
       *   'omni'  全向点光源（落地灯/灯带——灯罩四周透光）
       * opts.angle 锥角(弧度) / opts.dist 照射距离 / opts.strength 聚光强度 */
      lightKit(parent, y, glowSize, opts) {
        const mat = (c, o) => lambertF(c, o);
        const dir = opts && opts.dir ? opts.dir : 'omni';
        const bulbMat = mat(0xfff3d6);
        const bulb = new T.Mesh(new T.SphereGeometry(0.08, 16, 12), bulbMat);
        bulb.position.y = y;
        const glowMat = new T.SpriteMaterial({ map: glowTexF(), transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending });
        const glow = new T.Sprite(glowMat);
        const gs = glowSize || 0.8;
        glow.scale.set(gs, gs, 1);
        glow.position.y = y;
        /* 点光源作近场补光；方向性灯型降低强度，主照明交给聚光 */
        const plight = new T.PointLight(0xffc247, 0, 4.5);
        plight.position.y = y - 0.05;
        parent.add(bulb, glow, plight);
        /* 方向性聚光 */
        let spot = null;
        if (dir === 'down' || dir === 'wall') {
          spot = new T.SpotLight(0xffc247, 0, (opts && opts.dist) || 5.5, (opts && opts.angle) || 1.0, 0.55, 1.1);
          spot.position.set(0, y, dir === 'wall' ? 0.15 : 0);
          const tgt = new T.Object3D();
          if (dir === 'wall') tgt.position.set(0, y - 0.9, 2.6);   // 墙外斜向下
          else tgt.position.set(0, y - 2.8, 0);                    // 垂直向下
          parent.add(tgt);
          spot.target = tgt;
          parent.add(spot);
        }
        const ptBase = dir === 'omni' ? 0.9 : dir === 'wall' ? 0.3 : 0.35;
        const extraMats = [];
        const kit = {
          bulbMat, glowMat, plight, spot,
          addMat(m) { extraMats.push(m); return m; },
          set(on, rgb) {
            bulbMat.emissive.setHex(on ? 0xffc247 : 0x000000);
            if (on && rgb && rgb.length >= 3) bulbMat.emissive.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
            glowMat.opacity = on ? 0.85 : 0;
            plight.intensity = on ? ptBase : 0;
            if (spot) spot.intensity = on ? (opts && opts.strength) || 0.9 : 0;
            if (on && rgb && rgb.length >= 3) {
              plight.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
              if (spot) spot.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
            }
            extraMats.forEach((m) => {
              m.emissive.setHex(on ? 0xffc247 : 0x000000);
              if (on && rgb && rgb.length >= 3) m.emissive.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
            });
          },
        };
        parent.userData.pluginLightKit = kit;
        return kit;
      },
      /* 状态读取 */
      getState(eid) { return window.HA ? HA.getState(eid) : undefined; },
      isOn(eid) { return window.HA ? HA.isOn(eid) : false; },
      /* 二态开度: on/open = 1，其余 = 0；未绑定/无状态返回 null（调用方保持静态姿态） */
      binaryRatio(eid) {
        const st = eid ? this.getState(eid) : null;
        if (!st) return null;
        return (st.state === 'on' || st.state === 'open') ? 1 : 0;
      },
      /* 任意值 → 数字: 非数值 / unknown / unavailable 一律 null，便于 `x != null` 判断 */
      toNum(v) {
        if (v == null) return null;
        const s = String(v);
        if (s === '' || s === 'unknown' || s === 'unavailable') return null;
        const n = parseFloat(s);
        return isNaN(n) ? null : n;
      },

      /* ------ 扩展实体字段（插件 fields 声明，界面绑定后值存在 obj[key]） ------
       * 用途：一个设备除了主实体，还能挂功率/电量/温湿度/人体/曲目等实体，
       * 插件把这些数据呈现在模型屏幕、标签或动画上。未绑定一律返回空/ null，
       * 插件不需要自己判空串。示例：
       *   const w = ctx.fieldNum('powerEntity');            // 45.2
       *   ctx.fieldText('powerEntity')                      // '45.2 W'
       *   if (ctx.fieldOn('motionEntity')) { ... }          // 人体感应为 on
       */
      field(key) { return (obj && obj[key]) || null; },
      hasField(key) { return !!(obj && obj[key]); },
      fieldState(key) { const eid = obj && obj[key]; return eid ? ctx.getState(eid) : null; },
      fieldOn(key) { const eid = obj && obj[key]; return eid ? ctx.isOn(eid) : false; },
      /* 字段数值: 非数值 / unknown / unavailable 一律 null，便于 `x != null` 判断 */
      fieldNum(key) {
        const st = ctx.fieldState(key);
        if (!st || st.state == null) return null;
        const s = String(st.state);
        if (s === '' || s === 'unknown' || s === 'unavailable') return null;
        const n = parseFloat(s);
        return isNaN(n) ? null : n;
      },
      /* 字段文本: '45.2 W' / '有雨' / 未绑定 '' */
      fieldText(key) {
        const st = ctx.fieldState(key);
        if (!st) return '';
        return st.state + HA.unitOf(st);
      },
      render() { view.render(); },
      /* 每帧回调（fn(dt秒)），场景重建或 dispose 时自动注销 */
      animate(fn) { rec.anim = fn; },
    }, extra || {});
    const rec = { def, obj, inst: null, anim: null };
    return { ctx, rec };
  },

  /* ---------------- 生命周期 ---------------- */
  /* 跑插件 model3d 并把结果统一成 { group, update, dispose }：
   * 插件省略 update / dispose 时代码补上（空实现），插件里就不用再写 `dispose() {}` 样板。
   * 返回 rec（异步接管），失败只打日志不抛。 */
  _spawn(def, obj, view, place, extra) {
    const { ctx, rec } = this._makeCtx(def, obj, view, extra);
    let inst;
    try { inst = (def.model3d || def.create)(ctx); } catch (e) { console.error('[plugin:' + def.id + ']', e); return null; }
    if (!inst) return null;
    Promise.resolve(inst).then((it) => {
      if (!it || !it.group) return;
      if (rec.dead) return;   // 场景已重建，丢弃过期实例（异步 GLB 加载完成时 build 可能已换代）
      const api = Object.assign({}, it, {
        group: it.group,
        update: typeof it.update === 'function' ? it.update : null,
        dispose: typeof it.dispose === 'function' ? it.dispose : () => {},
      });
      rec.inst = api;
      place(api.group);
      this.instances.push(rec);
      if (api.update) { try { api.update(); } catch (e) { console.error(e); } }
      view.render();
    }).catch((e) => console.error('[plugin:' + def.id + ']', e));
    return rec;   // 异步接管: 调用方视为已接管，插件失败仅打日志
  },

  /* 门窗与设备共用: 样式 → 所属插件 → model3d；没有插件（或实例创建失败）时走 fallback 占位 */
  _spawnFor(obj, typeOrKind, view, place, fallback) {
    const style = this.styleOf(typeOrKind, obj.style);
    const def = (style && style.plugin && this.byId[style.plugin]) || this.defOf(typeOrKind);
    if (def) {
      // 插件内部只认自己的造型 id（不带插件前缀），避免插件代码感知聚合命名空间
      const local = style ? Object.assign({}, style, { id: style.sid || style.id }) : null;
      // 样式条目 options（如门的开向/铰链侧）合并默认值后经 ctx.options 交给插件
      if (this._spawn(def, obj, view, place, { style: local, options: this.styleOptionsOf(style, obj) })) return true;
    }
    fallback();
    return true;
  },

  /* 门窗: obj = door/window 数据，kind = 'door'|'window'。
   * 造型: obj.style（形如 'door:double' / 'door_rolling:rolling'）→ 该 kind 全部插件 styles 里的一项，
   *       缺省取第一项；样式条目自带 plugin（它属于哪个插件），所以「一个门由多个插件分别提供造型」时
   *       各造型各自调自己的 model3d / plan2d / isOn。
   * 无对应插件（或插件创建失败）时由引擎放薄板占位 —— 调用方（view3d）不关心成败。 */
  spawnOpening(o, kind, view) {
    return this._spawnFor(o, kind, view, (g) => {
      g.position.set(o.x, 0, o.y);
      g.rotation.y = -(o.rot || 0);
      view.root.add(g);
    }, () => this.openingPlaceholder(o, kind, view));
  },

  /* 设备: 把插件造型画进 view3d 已建好的 body 组（缩放/旋转/热区仍由 view3d 管理）。
   * 无插件时走引擎的通用占位（含自定义 GLB），view3d 侧不再有任何造型分支。 */
  spawnDevice(d, type, view, body) {
    return this._spawnFor(d, type, view, (g) => body.add(g), () => this.devicePlaceholder(d, view, body));
  },

  /* ---------------- 通用占位（无插件 / 插件创建失败时） ----------------
   * 这是引擎的职责，不属于任何具体 type：不做造型还原，只保证「有东西可点、位置正确」，
   * 避免设备在场景里凭空消失。设备的真实外形一律以插件为准。 */
  devicePlaceholder(d, view, body) {
    const put = (obj) => { body.add(obj); view.render(); };
    if (d.model && window.THREE && THREE.GLTFLoader && view.loadModel) {
      view.loadModel(d.model).then((proto) => {
        if (!proto) { put(this._unknownBox()); return; }
        const inst = proto.clone(true);
        const box = new THREE.Box3().setFromObject(inst);
        const size = box.getSize(new THREE.Vector3());
        const s = (d.scale || 0.5) / (Math.max(size.x, size.y, size.z) || 1);
        inst.scale.multiplyScalar(s);
        inst.position.y = -box.min.y * s;
        put(inst);
      });
      return;
    }
    put(this._unknownBox());
  },

  /* 未知设备标记：锚点处的小立方（挂在 body 里，随比例/旋转走） */
  _unknownBox() {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.16, 0.16),
      new THREE.MeshLambertMaterial({ color: 0xdfe4ea, transparent: true, opacity: 0.55 })
    );
    return m;
  },

  /* 门窗占位：一块半透明薄板（窗在窗台高 0.9m 起，门落地；板厚方向与洞口一致） */
  openingPlaceholder(o, kind, view) {
    const L = o.w || (kind === 'door' ? 0.9 : 1.2);
    const H = kind === 'window' ? 1.2 : 2.0;
    const grp = new THREE.Group();
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(L, H, 0.04),
      new THREE.MeshLambertMaterial({
        color: kind === 'window' ? 0xbfe0f5 : 0xd8c9b4,
        transparent: true,
        opacity: 0.45,
      })
    );
    panel.position.y = kind === 'window' ? 1.5 : H / 2;
    grp.add(panel);
    grp.position.set(o.x, 0, o.y);
    grp.rotation.y = -(o.rot || 0);
    view.root.add(grp);
    view.render();
  },

  /* 实体状态变化 → 回调所有实例的 update() */
  updateAll() {
    this.instances.forEach((rec) => {
      if (rec.inst && rec.inst.update) {
        try { rec.inst.update(); } catch (e) { console.error('[plugin:' + rec.def.id + ']', e); }
      }
    });
  },

  /* 每帧动画（View3D.startLoop 调用） */
  tick(dt) {
    this.tickBackground(dt);   // 动态背景按自身刷新率节流（静态背景无开销）
    this.instances.forEach((rec) => {
      if (rec.anim) { try { rec.anim(dt); } catch (e) { /* 忽略帧错误 */ } }
    });
  },

  /* 场景重建: 注销所有实例（Three 资源由 view3d.disposeGroup 统一释放） */
  reset() {
    this.instances.forEach((rec) => {
      rec.dead = true;   // 作废仍在飞行中的异步加载回调
      if (rec.inst && rec.inst.dispose) { try { rec.inst.dispose(); } catch (e) { /* ignore */ } }
    });
    this.instances = [];
  },
};

/* ctx.frame 的内置代码兜底: ref ≤ 1m 按门框（通高门套），否则按窗框（1.5m 居中窗套）。
 * 几何取自 door/window 插件原各自的兜底实现，收敛到引擎后插件不必再维护 */
function frameFallback(ctx, g, ref) {
  const door = ref <= 1.0;
  const col = door ? '#d9d4c8' : '#9aa7b5';
  const d = door ? 0.12 : 0.1;
  return (W) => {
    if (door) {
      ctx.box(g, 0.07, 2.1, d, -W / 2 - 0.035, 1.05, 0, col);
      ctx.box(g, 0.07, 2.1, d, W / 2 + 0.035, 1.05, 0, col);
      ctx.box(g, W + 0.14, 0.07, d, 0, 2.085, 0, col);
    } else {
      ctx.box(g, W + 0.08, 0.07, d, 0, 0.925, 0, col);
      ctx.box(g, W + 0.08, 0.07, d, 0, 2.075, 0, col);
      ctx.box(g, 0.07, 1.22, d, -W / 2 - 0.035, 1.5, 0, col);
      ctx.box(g, 0.07, 1.22, d, W / 2 + 0.035, 1.5, 0, col);
      ctx.box(g, 0.05, 1.1, 0.07, 0, 1.5, 0, col);
    }
  };
}

/* plan2d 的公共绘制原语: 插件不用再各自复制圆角矩形，也不用每次手写 fill+stroke 三行。
 *   p.rrect(x, y, w, h, rad)  只建路径（不 fill/stroke），可继续接自己的 c.stroke()
 *   p.draw(fn, opts)          fn 里只建路径，结束后统一按调色板填色 + 描边
 *                             opts.fill/opts.stroke 传 false 可只填或只描 */
function planKit(c, p) {
  return Object.assign({}, p, {
    rrect(x, y, w, h, rad) {
      rad = Math.min(rad || 0, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x + rad, y);
      c.arcTo(x + w, y, x + w, y + h, rad);
      c.arcTo(x + w, y + h, x, y + h, rad);
      c.arcTo(x, y + h, x, y, rad);
      c.arcTo(x, y, x + w, y, rad);
      c.closePath();
    },
    draw(fn, opts) {
      const o = opts || {};
      c.beginPath();
      fn();
      if (o.fill !== false) { c.fillStyle = p.fill || '#fff'; c.fill(); }
      if (o.stroke !== false) { c.strokeStyle = p.ink || '#2a3346'; c.lineWidth = p.lw || 1.6; c.stroke(); }
    },
  });
}

window.PluginEngine = PluginEngine;
