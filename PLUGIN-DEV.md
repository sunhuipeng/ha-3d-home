# 插件开发手册 · PLUGIN-DEV

> 适用: `assets/plugins/`（内置）与 `custom/plugins/`（自定义）下的所有 3D 表现插件。
> 读完这一份就能写设备、门窗、地面背景三类插件；每节都带可直接跑的最小示例。

三类插件一目了然：

| kind | 管什么 | 注册要点 | 现成插件 |
|---|---|---|---|
| `device` | 有状态的设备造型（灯、开关、空调、窗帘…） | `type` + `styles[]` + `model3d(ctx)`，可选 `click` / `stateText` / `plan2d` | light / switch / fan / cover / climate（内置） |
| `opening` | 门、窗（洞口内的动态开合） | `type` 为 `door` / `window`，实体全部用 `fields` 绑；可选 `plan2d` / `isOn` | door / window（内置）+ door_rolling / window_fixed（自定义） |
| `background` | 房屋外围地面 | `styles[]`，每项一个可选背景，`apply(ctx)` 返回 3D 模型 | background（内置）+ garden（自定义） |

> **`type` 是唯一的类型键（device / opening 共用）**：device 填 HA 实体类型（`light` / `switch`…），opening 填洞口类型（`door` / `window`）。**同一个 `type` 可以由多个插件共同提供造型**，引擎把它们的 `styles` 合并展示——门窗的「多插件」（如内置 `door` + `custom/plugins/door_rolling`）就是靠这个机制。
> **选中某个样式 = 交给该样式所属插件全权负责**：`model3d` / `plan2d` / `click` / `stateText` / `fields` 都取那一份（统一入口 `PluginEngine.defFor(type, styleId)`；不确定样式时 `PluginEngine.defOf(type)` 拿该 `type` 的第一个插件），未选样式才回退到该 `type` 的第一个插件。所以各插件可以声明**数量不同的 `fields`**：属性面板的扩展实体区会随样式切换，切到没有 `fields` 的插件时整区隐藏。
> 注意区分三个同名字段，它们属于不同对象：插件注册里的 `type`（归属类型）、实例数据里的 `obj.type`（设备 = HA 实体类型，门窗没有该字段）、家具目录里的 `item.type`（家具类型枚举）。

---

## 0. 目录、清单与加载

### 0.1 插件目录结构

```
custom/plugins/<目录名>/
├─ plugin.json          清单（服务端 /api/plugins 读取，决定是否加载本插件）
├─ plugin.js            注册代码（顶层调用 PluginEngine.register({...})）
└─ models/              可选，插件自带 GLB，用 ctx.glb('models/xx.glb') 加载
```

内置插件在 `assets/plugins/<id>/`，自定义插件在 `custom/plugins/<目录名>/`。两边结构完全一样，**同插件 `id` 时自定义覆盖内置**（升级镜像不会丢你的改动）。

### 0.2 `plugin.json` 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 插件唯一标识。内置门窗用 `door` / `window`，自定义门窗插件 id 任意（靠 `type` 归类）；与内置同 id 即覆盖 |
| `name` | ✅ | 面板显示名 |
| `version` | ✅ | **缓存版本号**。plugin.js 以 `plugin.js?v=<version>` 加载并长缓存，**改了代码必须升这个号**，否则浏览器用旧文件 |
| `kind` | ✅ | `device` / `opening` / `background` |
| `type` | device / opening 必填 | 插件归属的类型键。device = 设备类型，必须是 `DEVICE_TYPES` 的键：`light` `switch` `sensor` `climate` `water_heater` `cover` `fan` `media_player` `vacuum` `camera` `other`；opening = 洞口类型 `door` / `window` |
| `description` | — | 插件说明，仅展示 |
| `entry` | — | 自定义入口路径，默认 `<插件目录>/plugin.js`，一般不用写 |

### 0.3 加载与调用顺序

```
服务端 /api/plugins 合并 assets/plugins + custom/plugins 的 plugin.json
        ↓
前端按清单注入 <script src="…/plugin.js?v=<version>">
        ↓
plugin.js 顶层执行 PluginEngine.register(def)     ← 只注册，不创建模型
        ↓
用户摆放设备/门窗 → 引擎 spawn → def.model3d(ctx)    ← 此时才建 3D 对象
        ↓
HA 实体状态变化 → 引擎回调实例 update()
每一帧       → ctx.animate(fn) 里注册的 fn(dt)
场景重建/删除 → dispose()（随后 Three 资源由引擎统一释放）
```

---

## 1. 通用部分（三类插件都适用）

### 1.1 坐标与单位

| 概念 | 说明 |
|---|---|
| 单位 | 全部是米（m），角度一律弧度 |
| 2D → 3D | 2D 编辑器平面 `(x, y)` → 3D 世界 `(x, z)`；3D 的高度方向是 **y 轴** |
| group 原点 | 门/窗 = 洞口地面中心；设备 = 该设备的锚点（离地高度 `d.z` 或造型 `styles[].z`） |
| 谁负责摆位 | **引擎**负责 `position` 与 `rotation.y`，插件只在自己的 group 内部组装，不要再加整体偏移 |
| 尺寸来源 | 门窗宽度用 `obj.w`，高度用 `ctx.wallH`（数据里**没有** `obj.h`）；设备用造型的设计尺寸（米），「整体比例」由引擎施加在 body 上，插件不要再乘 `d.pct` |

### 1.2 `ctx` 通用 API 总表

`ctx` 是引擎传给 `model3d(ctx)` 的能力集合，**不要自己从 CDN 引 Three**，否则会有两套不兼容的类。

#### 基础引用

| 成员 | 类型 | 说明 |
|---|---|---|
| `ctx.THREE` | 命名空间 | Three.js，创建 Group / 几何 / 材质 / 灯光都用它 |
| `ctx.obj` | object | 当前实例数据（设备或门窗），字段见第 2.4 / 3.2 节 |
| `ctx.style` | object \| undefined | **device 与 opening 都会传**：当前造型条目 `{ id, name, sid, plugin, z?, labelOffset?, icon?, model?, desc?, options? }`。`id` 已去掉插件前缀（`sid` 是插件内部原始 id，两者一般相同），`plugin` 是这条造型属于哪个插件，`options` 是参数的原始 schema（当前值看 `ctx.options`）。opening 没有 `z` |
| `ctx.options` | object | **当前样式的参数取值**，如 `{ hand:'left', open:'in' }`。已经「条目 `def` ∪ 实例 `obj.styleOpts`」合并好，直接读即可；样式没声明 `options` 时是 `{}`。详见 2.2.1 |
| `ctx.wallH` | number | 当前楼层净高（米），吸顶灯/吊灯贴顶、门窗按层高兜底都用它 |
| `ctx.baseUrl` | string | 插件目录 URL，一般不用直接拼，用 `ctx.glb()` 即可 |
| `ctx.view` | View3D | 高级用法：`view.scene`、`view.loadModel()`、`view.render()`。日常只需 `ctx.render()` |

#### 几何与材质（当前 group 内部绘制）

| 函数 | 参数 | 返回 | 作用 |
|---|---|---|---|
| `ctx.glb(file)` | `file` 相对插件目录，如 `'models/frame.glb'` | `Promise<Object3D \| null>` | 加载插件自带模型。**内部按 URL 缓存原型并返回 clone**，多实例互不干扰；失败返回 `null`，必须自己兜底 |
| `ctx.box(parent, w, h, d, x, y, z, color, opts?)` | 宽高深、相对 parent 的位置、颜色 | `Mesh` | 画一个长方体 |
| `ctx.cyl(parent, rt, rb, h, seg, x, y, z, color, opts?)` | 上半径、下半径、高、分段、位置、颜色 | `Mesh` | 画圆柱/圆台 |
| `ctx.sphere(parent, r, x, y, z, color, opts?)` | 半径、位置、颜色 | `Mesh` | 画球体 |
| `ctx.lambert(color, opts?)` | 颜色、材质参数（如 `{ transparent:true, opacity:0.5 }`） | `MeshLambertMaterial` | 统一材质入口。**别用高 metalness 的 Standard 材质**，本场景无环境贴图会发黑 |
| `ctx.glowTexture()` | — | `CanvasTexture` | 共享的径向渐变光晕贴图（灯类插件做光晕） |
| `ctx.frame(g, L, ref, fallback?)` | 父节点、洞口长度 L（米）、参考宽度 ref（米）、兜底绘制函数 | `Promise<boolean>` | **门窗框统一入口**：加载共享 `models/frame.glb`，按 `L / ref` 缩放后 add 进 `g`；GLB 缺失时执行 `fallback(L)` 并返回 `false`。门 `ref` 用 0.9、窗用 1.2 |
| `ctx.lightKit(parent, y, glowSize, opts?)` | `y` 光源高度、`glowSize` 光晕直径、`opts` 见下 | `kit` | 灯泡 + 光晕 + 点光源 + 聚光的一体化套件 |

`lightKit` 的 `opts`：

| 字段 | 取值 | 说明 |
|---|---|---|
| `dir` | `'down'` / `'wall'` / `'omni'` | 向下锥形（吸顶灯）、向墙外斜下（壁灯）、全向（落地灯） |
| `angle` | 弧度，默认 `1.0` | 聚光锥角 |
| `dist` | 米，默认 `5.5` | 照射距离 |
| `strength` | 数字，默认 `0.9` | 聚光强度 |

返回的 `kit`：`kit.set(on, rgb)` 一键开 / 关并同步色温，`kit.addMat(m)` 把额外材质纳入发光联动。

#### 读实体状态

| 函数 | 参数 | 返回 | 作用 |
|---|---|---|---|
| `ctx.getState(eid)` | 实体 id | `{ entity_id, state, attributes, last_changed }` 或 `undefined` | 读任意实体完整状态。**必须传 id**，不传返回 `undefined` |
| `ctx.isOn(eid)` | 实体 id | boolean | 开关判定：`state==='on'`，或该实体属 `light`/`switch`/`fan` 且状态不是 `off`/`unavailable`/`closed` |
| `ctx.binaryRatio(eid)` | 实体 id | `1` / `0` / `null` | 二态开合比例：`on`/`open` → `1`，其它 → `0`，未绑或实体不存在 → `null`。门窗插件的「开合动画目标值」直接用它 |
| `ctx.toNum(v)` | 任意值 | number 或 `null` | 宽松数值解析：`''`/`'unknown'`/`'unavailable'`/非数字 → `null`，写扩展实体数值时用 |
| `ctx.field(key)` | `fields` 里的 key | 实体 id 或 `null` | 取扩展实体绑定值本身 |
| `ctx.hasField(key)` | key | boolean | 是否已绑定 |
| `ctx.fieldState(key)` | key | 状态对象或 `null` | 扩展实体的完整状态 |
| `ctx.fieldOn(key)` | key | boolean | 扩展实体是否 on，未绑 → `false` |
| `ctx.fieldNum(key)` | key | number 或 `null` | 扩展实体数值；`''`/`unknown`/`unavailable`/非数字 → `null` |
| `ctx.fieldText(key)` | key | string | 扩展实体文本，自动拼单位（`'45.2 W'`），未绑 → `''` |

#### 时序与渲染

| 函数 | 参数 | 作用 |
|---|---|---|
| `ctx.animate(fn)` | `fn(dt)`，`dt` 为秒 | 注册每帧回调（缓动动画、旋转）。**每个实例只保留最后一个 fn**，多个动画写在一个 fn 里 |
| `ctx.render()` | — | 手动请求一次重绘；引擎在状态变化后本就会渲染，只有你在异步回调里改了东西才需要调 |

### 1.3 怎么读实体状态（最容易出错的一块）

**主实体**（设备自身 / 门窗主绑定）就是 `obj.entityId`：

```js
update() {
  const st = ctx.getState(ctx.obj.entityId);   // 必须传 id
  if (!st) return;                             // 未绑定 / 未连 HA / 实体不存在
  const on = ctx.isOn(ctx.obj.entityId);
  const attrs = st.attributes || {};            // brightness / rgb_color / current_temperature …
}
```

几个必须知道的点：

- **返回 `undefined` 是正常情况**：未连 HA、演示模式、实体不存在、字段没绑定都会这样，先判空再取值。
- **`ctx.isOn()` 只覆盖开关类**：`cover` 是 `open/closed`、`vacuum` 是 `cleaning/docked`、`media_player` 是 `playing/paused`，这些要自己读 `st.state` 比对。
- **不要在 `animate` 里读状态**：`update()` 已经是「状态变化」的精确时机，每帧读没有意义。
- **不要缓存状态对象**：HA 推送是增量合并，同一个实体对象会被复用，只读值、不留引用。

**扩展实体**：在注册对象里用 `fields` 声明，用户绑定后实体 id 存在 `obj[key]`：

```js
fields: [
  { key: 'powerEntity', label: '功率', domains: ['sensor'], tip: '显示实时功率' },
]

update() {
  const w = ctx.fieldNum('powerEntity');        // 没绑 / 没数据 → null
  if (w != null) label.textContent = w.toFixed(0) + ' W';
}
```

`fields` 条目字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `key` | ✅ | 存值用的键，最终落在 `obj[key]` |
| `label` | ✅ | 属性面板里的标签 |
| `domains` | — | 限定实体域，如 `['sensor','binary_sensor']` |
| `placeholder` | — | 输入框提示 |
| `tip` | — | 行尾说明文字 |

> `device` 插件的主实体由「设备绑定」管理，**不要再把 `entityId` 写进 `fields`**；`opening`（门/窗）没有主实体概念，所以字段全部用 `fields` 声明。
>
> **同 `type` 多插件时，`fields` 是「每个插件各写各的」**：属性面板展示的永远是**当前选中样式所属插件**声明的那份字段（切换样式即换一份，该插件没声明 `fields` 就整区隐藏）。别把一个形状的专属实体写进同 `type` 的另一个插件里——宁可每个插件各自声明，也不要为了「合并显示」去堆共享字段。

### 1.4 生命周期回调一览

| 回调 | 签名 | 何时被调用 | 必须实现 |
|---|---|---|---|
| `model3d(ctx)` | `(ctx) => { group, update?, dispose? }` 或 Promise | 实例创建时（每次场景重建一次） | ✅ |
| `update()` | `() => void` | HA 实体状态变化后（引擎批量回调所有实例） | 建议 |
| `dispose()` | `() => void` | 场景重建 / 设备删除前 | 可选 |
| `ctx.animate(fn)` | `fn(dt: number)` | 每帧 | 可选 |
| `stateText(st, obj, get)` | 返回 string | 每条状态更新时算标签文案 | 可选（device） |
| `click.on/off` | 服务名或 `{service, domain}` | 用户点击设备时 | 可选（device） |
| `click.isOn(st)` | 返回 boolean | 判断「当前是否开启」：决定点哪个服务、3D 高亮、**2D 平面图开/关底色**；插件没声明时回退默认判定（`state` 非 `off`/`unavailable` 等） | 可选（device） |
| `apply(ctx)` | 返回 `{ group }`（可附 `refresh` / `update` / `size`） | 背景被选用时 | background ✅ |
| `update(t, api)` | `t` 秒、`api` 句柄 | `refresh > 0` 时按 Hz 调用 | 可选（background） |
| `plan2d(c, p)` | `(CanvasRenderingContext2D, p) => number \| void`（device 返回包围半径 px，opening 可无返回） | 编辑器重绘 2D 平面图时（按需渲染，不是 rAF 每帧） | 可选（opening 见 3.2.2，device 见 2.8） |
| `isOn(obj, get)` | 返回 boolean | 编辑器画 2D 平面图时判定门窗是否打开（决定填充色） | 可选（opening 见 3.2.3；device 用 `click.isOn`） |

### 1.5 通用注意事项

1. **别自己摆位置**：引擎已经设置 `group.position` 和 `rotation.y`，你在 group 里加偏移会导致摆放错位。
2. **GLB 必须判空**：`await ctx.glb()` 可能返回 `null`（文件缺失/网络失败），要有代码兜底几何，否则设备凭空消失。
3. **多实例用 `ctx.glb`**：它内部 `clone(true)`；直接 `view.loadModel()` 后 `add` 会让第二个实例把模型「抢走」。
4. **改代码升版本**：`plugin.json` 的 `version` 不变，浏览器会一直用缓存的旧 plugin.js。
5. **异步 `model3d` 要注意场景已换代**：引擎会丢弃过期实例，但你自己的定时器/事件监听要在 `dispose()` 里清掉。
6. **调试日志**：生产模式 `window.__HA_DBG === false` 会静默，开发时可在控制台置 `true`；错误统一前缀 `[plugin:<id>]`。
7. **整个文件包一层 IIFE**：所有 `plugin.js` 都是用 `<script>` 独立加载的**经典脚本**，共享同一个全局作用域。两个插件都写顶层 `const ico = …` 会直接 SyntaxError，后面的插件全部注册不上。内置 13 个插件（10 个设备 + 门 + 窗 + 1 个背景；庭院铺装 `garden` 已挪到 `custom/plugins/`）现在都是 `'use strict';` + `(function () { … })();` 的写法，照抄即可。

### 1.6 引擎提供的小工具（`PluginEngine.*`）

下面这些是**引擎统一实现、插件直接复用**的通用逻辑。历史上每个插件各写一份（15 份 `ico`、6 份本地 `rrect`、10 处 on/off 中文三元…），现已全部下沉，写新插件**不要再复制这些代码**。

| 工具 | 签名 | 作用 |
|---|---|---|
| `PluginEngine.ico(inner)` | SVG 内片段 → string | 包成 24×24、`fill:none`、`stroke:currentColor`、`stroke-width:1.7` 的线性 SVG（跟随主题色）。`const ico = PluginEngine.ico;` 后照常 `ico('<path …/>')` |
| `PluginEngine.fieldBits(obj, get, list)` | 见 1.3 | 把扩展实体数值拼成 `' · 320W'` 这样的尾巴 |
| `PluginEngine.isOnState(st)` | 状态对象 → boolean | **二态开判定**：`state === 'on'` 或 `'open'` 算开（门磁 / 窗磁 / 人体感应的通用口径）。`click.isOn` 想声明「就看 on/open」可直接引用它 |
| `PluginEngine.runningState(st, opts?)` | 状态对象 → boolean | **运行态判定**：只要不是 `off` / `unavailable` 就算在运行，覆盖 `cleaning` / `playing` / `cool` / `heat` 这类多模式域；个别域用 `off` 表示待机时传 `{ countOff: true }` |
| `PluginEngine.baseStateText(st, map?)` | 状态对象、可选映射表 → string | 标签文案底座：默认 `{ on:'已开启', off:'已关闭' }`，表里没有的状态原样返回（`unavailable` → `'unavailable'`）。要换词就传 `map`，如 `baseStateText(st, { off: '已断电' })`（传了 map 就整体替换默认表） |
| `PluginEngine.defFor(type, styleId)` | 类型 + 聚合样式 id → 插件定义 \| null | 查「这个造型由哪个插件负责」，`fields` / `plan2d` / `click` / `stateText` 全走它；调试时很好用 |
| `PluginEngine.styles(type)` | 类型 → 造型数组 | 某类型的全部造型（`id` 带 `<插件id>:` 前缀，`sid` 是插件内部 id，`plugin` 是所属插件） |
| `PluginEngine.labelOffset(type, styleId)` | 类型 + 样式 → number | 该造型的标签抬升高度（米），缺省 0.3 |

```js
const ico = PluginEngine.ico;

PluginEngine.register({
  /* … */
  stateText(st) {
    if (!st) return '';
    if (st.state === 'playing') { /* 复杂状态自己拼 */ }
    return PluginEngine.baseStateText(st, { off: '待机' });   // '已开启' / '待机' / 'unavailable'
  },
  model3d(ctx) { /* … */ },
});
```

---

## 2. `device` 插件（设备造型）

### 2.1 注册对象字段

```js
PluginEngine.register({
  id: 'myplug',            // 唯一 id，同 id 覆盖内置
  kind: 'device',
  type: 'switch',         // 必须与 HA 实体域对应，决定出现在哪个设备分类
  name: '我的插座',
  styles: [ /* 造型列表，见 2.2 */ ],
  fields: [ /* 扩展实体，见 1.3 */ ],
  click: { /* 点击控制，见 2.3 */ },
  stateText(st, obj, get) { /* 标签文案，见 2.3 */ },
  model3d(ctx) { /* 见 2.5 */ },
});
```

> **`builtin` 参数**：只有 `assets/plugins/` 下的内置插件在注册时带 `builtin: true`。
> 不带此参数的注册一律视为自定义插件 —— 样式面板 / 同类模型网格会显示「自定义」角标。
> 自定义插件**不要**带这个参数；注册 id 与 plugin.json 清单 id 不要求一致。

### 2.2 `styles` 造型条目

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 插件内唯一；聚合到面板时引擎加前缀变成 `<插件id>:<造型id>`，`ctx.style.id` 仍是本插件内的 id |
| `name` | ✅ | 面板显示名 |
| `z` | 建议填 | 该造型默认离地高度（米），也就是锚点高度：吸顶灯 `2.78`、壁灯 `1.8`、落地灯 `0`。设备实例的 `obj.z` 可覆盖；不写时编辑器按 1.2m 兜底 |
| `desc` | — | 样式按钮下方的说明小字（如「单扇平开，铰链在左」） |
| `icon` | — | 面板样式按钮的图标，**由插件自己提供**（与门窗 `styles[].icon` 完全一致）：SVG 字符串或 emoji。不写只显示 ⚙️ 兜底，引擎不再维护内置图标表 |
| `labelOffset` | — | 状态标签相对锚点的抬升，默认 `0.3` 米；设备实例可在属性面板「3D 位置与大小 → 标签高度」里单独覆盖（存 `obj.labelOffset`，优先于造型值） |
| `model` | — | 默认 GLB 路径（也可由设备自身的 `obj.model` 覆盖） |
| `options` | — | 该造型的可调参数 schema（同一造型的差异项，如「单开门」再分左右开、内外开），见 2.2.1 |

`icon` 用引擎的 SVG 包装器 `PluginEngine.ico`（24×24 视框、`fill:none`、`stroke:currentColor`，颜色自动跟随主题，别写死 `width/height`）：

```js
const ico = PluginEngine.ico;   // 文件顶部取一次引用，下面照常当函数用

styles: [
  { id: 'pendant', name: '吊灯', z: 2.25,
    icon: ico('<line x1="12" y1="3" x2="12" y2="8"/><path d="M7.5 8 h9 l-2 6 h-5 z"/>') },
  { id: 'floor', name: '落地灯', z: 0, labelOffset: 1.75,
    icon: ico('<path d="M9.5 4 h5 l1.5 5.5 h-8 z"/><line x1="12" y1="9.5" x2="12" y2="19"/>') },
],
```

### 2.2.1 样式参数 `styles[].options`

> **背景插件保留键**：`offsetX`（东西）/ `offsetZ`（南北）—— 表示**房屋在背景画面中偏离中心多少米**
> （默认 0 = 房屋落在背景中心，钳制 ±60）。引擎会把它算进 `ctx.house` / `ctx.safe`，
> 所以插件里 `house.cx / cy` 就是房屋相对背景中心的偏移、`safe.allowed()` 也已经带上偏移；
> 方向仍是统一手感：滑块「往右拖 = 背景 往左/往上」，即 +X = 房屋相对偏东、+Z = 房屋相对偏南。
> 声明这两个参数，右侧面板就会出现偏移滑条。内置背景插件已全部带上（`bgKit.offsetOpts()` 可复用）。


同一种造型的**差异项**用 `options` 表达，不必为每种差异另开一个造型。典型例子是门：一个「单开门」样式再分左/右开门、内/外开，四种画法共用一份造型和一份代码。

```js
styles: [
  { id: 'single', name: '单开门', desc: '一扇平开门', icon: ico('…'),
    options: [
      { key: 'hand', label: '手向', type: 'select', def: 'left',
        choices: [{ value: 'left', label: '左开门' }, { value: 'right', label: '右开门' }] },
      { key: 'open', label: '开向', type: 'select', def: 'in',
        choices: [{ value: 'in', label: '内开' }, { value: 'out', label: '外开' }] },
    ] },
],
model3d(ctx) {
  const o = ctx.options;                       // { hand: 'left', open: 'in' }（默认值已合并）
  const right = o.hand === 'right';
  // …
},
plan2d(c, p) {
  const right = p.options.hand === 'right';           // 2D 里同样能读到（默认值也已合并）
  // …
},
```

控件类型（与背景参数是**同一套 schema、同一份渲染代码**）：

| `type` | 控件 | 必带字段 |
|---|---|---|
| `range` | 滑条 + 数字框 | `min` `max` `step` `def` |
| `number` | 数字框 | `def`，可选 `step` |
| `select` | 下拉 | `choices: [{ value, label }]` `def` |
| `checkbox` | 复选框 | `def`，可选 `tip`（勾选框右侧文字） |
| 其它 / 缺省 | 文本框（按 `text` 处理） | `def` |

取值流转：

- 面板改一项 → 写进**实例**的 `obj.styleOpts = { hand:'right' }`
- 插件读 `ctx.options.hand`（3D）/ `p.options.hand`（2D），值 = 条目 `def` ∪ `obj.styleOpts`，缺省值不用自己兜
- 同一造型的**不同实例各存各的**：A 门左开、B 门右开互不影响
- 面板「样式参数」区只在当前样式声明了 `options` 时出现

### 2.3 `click` 与 `stateText`

```js
click: {
  on: 'turn_on',                        // 或 { service: 'media_play', domain: 'media_player' }
  off: 'turn_off',
  isOn: (st) => !!(st && st.state === 'playing'),   // 参数是状态对象，不是实体 id
  label: '播放 / 暂停',                  // 属性面板勾选文案
  defaultOn: false,                     // 默认不启用点击（纯展示设备用）
  feedback: true,                       // 执行后弹一条提示（动作没有可见状态变化时用）
}
```

未声明 `click` 时按 `type` 取内置默认：`light` / `switch` / `fan` / `cover` 用 `toggle`，`water_heater` / `climate` 用 `turn_on` / `turn_off`；其余类型默认「不可点击」。

`stateText(st, obj, get)`：`st` 是主实体状态，`obj` 是实例数据（含 `fields` 绑定值），`get(eid)` 可直接读任意实体。返回空字符串则回退通用文案。

```js
stateText(st, obj, get) {
  if (!st) return '';
  return PluginEngine.baseStateText(st, { on: '通电', off: '断电' })   // 底座文案（见 1.6）
    + PluginEngine.fieldBits(obj, get, [
      ['powerEntity', (s, n) => (n == null ? '' : n.toFixed(0) + 'W')],
    ]);   // → '通电 · 320W'
}
```

### 2.4 `obj` 字段（设备实例数据）

| 字段 | 说明 |
|---|---|
| `entityId` | 主实体 id |
| `type` | 设备类型（可缺省，引擎会按实体域推导） |
| `style` | 当前造型聚合 id（`<插件id>:<造型id>`） |
| `styleOpts` | 该实例的样式参数取值（`{ hand:'left' }`）。面板改参数时写入；插件读 `ctx.options` 即可，一般不用直接碰它 |
| `name` | 自定义名称 |
| `x` / `y` | 平面坐标（引擎已应用，插件不要再用） |
| `z` | 离地高度，`null` 时用造型的 `z` |
| `rot` | 水平旋转角度（度，引擎已应用） |
| `pct` | 整体比例（百分比，引擎已应用） |
| `model` | 设备级自定义 GLB 路径（可选） |
| `click` | `true` / `false` 强制可点/不可点，未设置跟随插件 |
| `fields` 里的 key | 各自绑定的实体 id |

### 2.5 `model3d(ctx)` 返回值

```js
model3d(ctx) {
  const T = ctx.THREE;
  const g = new T.Group();
  // …在 g 内部组装…
  return {
    group: g,        // ✅ 必填：挂到引擎的 body 节点上
    update() {},     // 状态变化时刷新外观（可省）
    dispose() {},    // 释放自己 new 的纹理/材质/监听（可省）
  };
}
```

**引擎会做返回值归一**，所以上面两项可以省：

| 你返回的 | 引擎怎么处理 |
|---|---|
| 只给 `{ group }` | `update` 置 `null`（状态变化时跳过），`dispose` 补空实现 |
| 给 `update` | **引擎在实例挂上场景后立刻替你调一次**，插件里不要再写 `api.update()` 做初值 |
| 给 `dispose` | 场景重建 / 设备删除时调用，之后 Three 资源由引擎统一释放 |
| 返回 `null` / 抛错 / Promise 被 reject | 只打 `[plugin:<id>]` 日志，不中断其他实例（门窗/设备会走引擎占位） |
| `async model3d` | 支持。await 期间若场景已重建，这个实例会被丢弃，`group` 不会挂上去 |

> 所以**不要**再写 `dispose() {}` 这种空函数，也不要手动首调 `update()` —— 这两处样板曾散落在 15 个插件里，现已统一到引擎。

### 2.6 完整示例：一个最小可用的墙壁插座插件

```js
// custom/plugins/myplug/plugin.js
PluginEngine.register({
  id: 'myplug',
  kind: 'device',
  type: 'switch',
  name: '我的插座',
  styles: [{ id: 'wall', name: '墙壁插座', z: 0.35 }],
  fields: [
    { key: 'powerEntity', label: '功率', domains: ['sensor'], tip: '可选，显示实时功率' },
  ],
  click: { on: 'turn_on', off: 'turn_off', label: '通电 / 断电' },

  stateText(st, obj, get) {
    if (!st) return '';
    return PluginEngine.baseStateText(st, { on: '通电', off: '断电' })
      + PluginEngine.fieldBits(obj, get, [
        ['powerEntity', (s, n) => (n == null ? '' : n.toFixed(0) + 'W')],
      ]);
  },

  model3d(ctx) {
    const T = ctx.THREE;
    const g = new T.Group();

    // 面板（原点 = 墙面锚点，+Z 朝室内）
    ctx.box(g, 0.12, 0.12, 0.02, 0, 0, 0, '#eeeae2');
    ctx.box(g, 0.05, 0.035, 0.008, 0, 0.025, 0.012, '#cfc9bd');
    ctx.box(g, 0.05, 0.035, 0.008, 0, -0.025, 0.012, '#cfc9bd');

    // 指示灯
    const ledMat = ctx.lambert('#333333');
    const led = ctx.sphere(g, 0.01, 0, -0.05, 0.012, '#333333');
    led.material = ledMat;

    return {
      group: g,
      update() {
        ledMat.color.set(ctx.isOn(ctx.obj.entityId) ? '#22ff88' : '#333333');
        ctx.render();
      },
      dispose() { ledMat.dispose(); },
    };
  },
});
```

配套 `custom/plugins/myplug/plugin.json`：

```json
{
  "id": "myplug",
  "name": "我的插座",
  "version": "1.0.0",
  "kind": "device",
  "type": "switch",
  "description": "程序化绘制的墙壁插座，指示灯随通电状态变化"
}
```

> 同一个 `type` 可以有多个插件（造型库里会合并展示），用户选哪个造型就用哪个插件的 `model3d`。默认取**先注册**的那个。

### 2.7 内置 device 插件（可直接抄）

`light`（7 种灯型 + lightKit）、`switch`、`fan`、`cover`、`climate`、`water_heater`、`camera`、`sensor`、`vacuum`、`speaker`（media_player，默认不响应点击，需在面板勾选）。其中 **`door/plugin.js` 头部是完整参数手册**，写新插件建议先读它。

---

### 2.8 设备的 2D 简笔模型 `plan2d(c, p)`

和门窗（3.2.2）同一套机制：2D 平面图上的设备符号由插件自绘一个**俯视简笔模型** —— 空调画内机长条、热水器画储水罐、风扇画三叶扇……让用户一眼认出设备类型。

**职责分工（重要）**：`plan2d` 只画「中性线稿模型」，状态和选中视觉全部由抽象层（编辑器 + 引擎调色板）接管：

| 视觉 | 谁负责 | 怎么做 |
|---|---|---|
| 开 / 关（判定） | 插件声明则优先 | 状态判定跟随 `click.isOn(st)`（窗帘 `open`、扫地机 `cleaning`、音箱 `playing` 等复杂状态由插件判断）；没声明时回退默认规则（`HA.isOn`）。插件不用在 `plan2d` 里重复判断，只管拿 `p.on`/`p.fill` 画 |
| 开 / 关（上色） | 抽象层给色 + 插件填充 | 调色板按状态给 `p.fill`（开=`#fdeecb` 暖琥珀 / 关=`#fff`），`plan2d` 把它填进**线稿封闭形状内部**——贴合线框，透明角落不着色；没有封闭形状的符号（灯带/窗帘）画一条贴合的圆角底条 |
| 选中 / 未选中 | 抽象层 | 模型画完后叠加**蓝色虚线圆环**：线稿小 → 贴合包裹（包围半径+4px）；线稿大 → 封顶 `SEL_RING_MAX`(26px) 后叠加画在线稿之上，作为选中标记 |
| 实体未连接 | 抽象层 | 调色板把 `p.ink` 换成红色，插件不用管 |
| 模型本身 | 插件 `plan2d` | 用 `p.ink / p.fill / p.accent / p.accent2 / p.lw` 画中性线稿；用绘制助手 `p.draw(() => p.rrect(...))` 一步填色+描边；最后 `return` 包围半径 |

其他约定：

- **尺寸按真实比例**：画布已经 translate 到设备锚点并按「水平旋转」rotate 过（rotate 后画布上方 = 设备朝向），用「米 × `p.ppm`」算尺寸，别写死像素；**方向敏感的细节（视场扇、感应波、前向缓冲）画在上方（-Y）即可**，旋转由编辑器统一处理
- **返回包围半径**（像素）：`plan2d` 最后 `return` 一个数字，抽象层据此画选中虚线圈。选中圈半径会封顶（26px）：大模型（视场扇、长条内机）的圈是叠加在线稿上的选中标记，不必也不该撑到和模型一样大
- **状态色只进线框内部**：机身/底条用 `p.fill` 填充即可，别再画整圆背景 —— 编辑器不画任何背景，线稿外的透明角落保持透明
- `p.on` 仍会传入，但**只用于结构性决策**（如空调按造型画不画气流弧），不要再用它选颜色
- 设备是「点状物」，没有门窗那种宽度属性（门窗传 `L = w × ppm`），也没有长宽调节 —— 视觉区分交给背景色和虚线圈就够了，不用画太精细

```js
PluginEngine.register({
  id: 'myac', kind: 'device', type: 'climate', name: '我的空调',
  /* …styles / model3d … */
  plan2d(c, p) {
    const w = 0.85 * p.ppm, h = 0.22 * p.ppm;   // 内机 0.85m × 0.22m
    /* 圆角机身：draw 内部自动填 p.fill（开=暖琥珀 / 关=白）再描 p.ink */
    p.draw(() => p.rrect(-w / 2, -h / 2, w, h, h * 0.35));
    /* 出风口：只描边 */
    p.draw(() => { c.moveTo(-w * 0.35, h * 0.18); c.lineTo(w * 0.35, h * 0.18); }, { fill: false });
    return w / 2;                                // 包围半径
  },
  async model3d(ctx) { /* … */ },
});
```

`p` 的字段：

| 字段 | 含义 |
|---|---|
| `ppm` | 像素/米，尺寸都按它换算 |
| `sel` | 是否选中（**只用于结构判断**；选中圈由抽象层统一画，颜色不用插件管） |
| `on` / `hasState` | 实体是否开启 / 是否有状态（**只用于结构判断**，如某细节画不画；开/关视觉看下面的 `fill`） |
| `fill` | 状态填充色（开=`#fdeecb` / 关=`#fff`），填进线稿封闭形状内部 —— 这就是「开/关」的视觉来源 |
| `ink` | 描边主色：正常=中灰 `#6b7280` / 未连接=红 `#d94f4f` |
| `accent` / `accent2` | 固定中性灰（`#c3cad6` / `#9aa3b2`），活动部件 / 次级细节 |
| `lw` | 描边线宽，固定 1.6 |
| `type` / `style` | 设备类型 / 当前造型的内部 id（`styles[].id`）。**2D 符号要跟造型走就在 `plan2d` 里按 `style` 分支**，内置 light/switch/sensor/climate/camera/speaker 都这么干 |
| `options` | 当前样式的参数取值（同 `ctx.options`，默认值已合并）；按它画「左开/右开」「横装/竖装」这类差异 |
| `entityId` | 该设备绑定的主实体 id |
| `state` | 主实体的状态对象（HA 原样，`{ state, attributes… }` 或 `null`），想读数值/单位用它 |
| `obj` | 设备放置数据本体 —— **拓展实体字段都在上面**（fields 里声明什么 key 就有什么 key，如 `obj.posEntityId`） |
| `getState` | `(entityId) => 状态对象\|null`，查任意实体（含拓展实体）的当前状态 |

注意事项：

- 例: 在 2D 里读拓展实体状态 —— `const pst = p.getState(p.obj.posEntityId)`（窗的开度实体），`pst && pst.state` 即当前值
- 每次重绘都会被调用（编辑器按需渲染，不是 rAF 每帧）：只画线，别加载图片、别发请求
- 插件没写 `plan2d` 时，编辑器画「圆角方块 + 圆点」的中性符号兜底 —— 不写也能用
- 内置 10 个设备插件都实现了 `plan2d`（灯/开关/传感器/空调/摄像头/窗帘/风扇/扫地机/音箱/热水器），直接抄最方便

## 3. `opening` 插件（门 / 窗）

### 3.1 与 device 的区别

| | device | opening |
|---|---|---|
| `kind` | `'device'` | `'opening'` |
| `type` | 实体类型（`light` / `switch` / `fan`…），必填 | **洞口类型**（`'door'` / `'window'`），必填 |
| `id` | 自定义（同 type 可有多个插件） | 自定义（内置为 `door` / `window`，同 type 可有多个插件） |
| 造型 | `styles[]` 多造型 | **`styles[]` 也支持**（单开门/双开门/卷帘门…），区别是没有 `z`（高度由洞口决定） |
| 主实体 | `obj.entityId`（设备绑定） | 无，实体全部用 `fields` 声明（`entityId` / `posEntityId`） |
| 位置 | 设备锚点（可改离地高度） | 洞口中心，落地，旋转跟随墙 |

> 门窗的多造型与设备**完全同一套机制**：`register` 里声明 `styles`，引擎聚合时加 `<插件id>:` 前缀，用户选中后写入 `obj.style`，`model3d(ctx)` 读 `ctx.style.id` 决定画哪种；没选过就走 `styles[0]`（老数据自动落到第一项，不会坏）。

> **`type` 是唯一的分组键，设备与门窗共用**：设备的 `type` 是实体类型，门窗的 `type` 是洞口类型。所以「一个洞口类型由多个插件共同提供造型」就是**多个插件写同一个 `type`**：内置 `door`（`type:'door'`）与 `custom/plugins/door_rolling`（同样 `type:'door'`）的 `styles` 自动合并进同一个门样式下拉。拆出去的插件自带 `model3d` / `plan2d` / `isOn`，互不干扰——现成例子：`door_rolling`（卷帘门）、`window_fixed`（固定窗）。

### 3.2 `obj` 字段（门窗实例数据）

| 字段 | 说明 |
|---|---|
| `x` / `y` | 洞口中心的平面坐标（引擎已应用） |
| `rot` | 沿墙方向（度，引擎已应用） |
| `w` | 洞口宽度（米），门框/窗框要按它自适应 |
| `swing` | 可选字段：未绑门磁时 **3D** 门扇的静态开角（rad，缺省 1.1）。旧实例可能没有这个字段，读的时候写 `obj.swing != null ? obj.swing : 1.1` |
| `style` | 用户选中的样式，形如 `'door:double'` / `'door_rolling:rolling'`；**可能不存在**，缺省 = 该 kind 的 `styles[0]` |
| `styleOpts` | 该实例的样式参数取值（如 `{ hand:'right', open:'in' }`），插件读 `ctx.options` / `p.options` 即可 |
| `entityId` | `fields` 里声明的实体（门磁 / 窗磁） |
| `posEntityId` | 窗专用：开度实体 |

### 3.2.1 门窗多造型（单开 / 双开 / 卷帘）

内置插件只按自己的造型画，样式多了就拆到独立插件——两个插件写同一个 `type`，样式自动合并成一个下拉（内置 `door` + `custom/plugins/door_rolling` 就是这套现成组合）：

```js
// ① 内置插件：id 与 type 同名
PluginEngine.register({
  id: 'door', kind: 'opening', type: 'door', name: '门',
  styles: [
    { id: 'single', name: '单开门', desc: '单扇平开，铰链在左', icon: '<svg…>' },
    { id: 'double', name: '双开门', desc: '两扇对开' },
  ],
  async model3d(ctx) {
    const sid = (ctx.style && ctx.style.id) || 'single';   // 当前样式（不带插件前缀）
    if (sid === 'double') return buildDouble(ctx);
    return buildSingle(ctx);
  },
});

// ② 拆出去的插件（custom/plugins/door_rolling）：type 写同一个 'door'
PluginEngine.register({
  id: 'door_rolling', kind: 'opening', type: 'door', name: '卷帘门',
  styles: [{ id: 'rolling', name: '卷帘门', desc: '帘片向上卷入门洞上方卷轴箱' }],
  plan2d(c, p) { /* 自己的平面符号：虚线开口 */ },
  isOn(obj, get) { /* 自己的判定：门磁 on = 卷起 */ },
  async model3d(ctx) { return buildRolling(ctx); },
});
```

要点：

- `styles[].id` 只用插件内部名字，引擎会加 `'<插件id>:'` 前缀；`ctx.style.id` 拿到的是**去掉前缀**的内部 id
- **跨插件合并靠 `type`**：门窗的 `type` 是洞口类型（`'door'` / `'window'`），同 `type` 的插件各画各的造型，`model3d` / `plan2d` / `isOn` / `fields` 都取样式所属插件那一份（`PluginEngine.defFor(kind, styleId)`），互不影响；所以各插件的 `fields` 数量可以不同（如 `window` 两个、`window_fixed` 零个），属性面板的实体绑定区随样式切换。设备侧同一套规则（`defFor(type, styleId)`）。漏写 `type` 的 opening 插件注册时会在控制台告警
- 选中拆出来的样式时，`obj.style` 存的是带前缀的全名（`'door_rolling:rolling'`）；插件代码里永远只见到内部 id
- 门窗 `styles` 不需要 `z`（洞口贴地、窗户从 0.9m 起，高度由户型决定）；`icon` 支持内联 SVG 字符串（`v-html` 渲染）
- 门窗样式同样支持 `options`（单开门再分左/右开、内/外开…），写法与设备一致，见 2.2.1：3D 里读 `ctx.options`、2D 里读 `p.options`
- 属性面板的样式区按**聚合后的总数**判断：门窗只要有 2 个以上（含其他插件贡献的）就显示样式按钮
- **插件文件要包一层 IIFE**：多个 `plugin.js` 是各自独立的 `<script>`，顶层 `const` 共享全局作用域，重名会整文件 SyntaxError（见内置 `door`/`window` 与 `custom/plugins/*` 的写法）

### 3.2.2 自定义 2D 平面符号 `plan2d(c, p)`

3D 造型和 2D 平面图符号是两件事：`model3d(ctx)` 画三维，`plan2d(c, p)` 画平面图上的符号。**不写 `plan2d` 也能用**，编辑器会画一个通用「洞口矩形 + 中缝线」兜底；写了就完全由插件决定这一造型在平面图里长什么样（推拉画中梃、对开画两道开启弧、卷帘画虚线…）。

```js
PluginEngine.register({
  id: 'door', kind: 'opening', name: '门',
  styles: [{ id: 'single', name: '单开门' }, { id: 'double', name: '双开门' }],
  plan2d(c, p) {
    // 此刻画布已 translate 到洞口中心、rotate 到墙方向，颜色也按选中态给好
    const L = p.L;
    c.fillStyle = p.fill;
    c.strokeStyle = p.ink;
    c.lineWidth = 1.6;
    c.fillRect(-L / 2, -3, L, 5);
    c.strokeRect(-L / 2, -3, L, 5);
    if (p.style === 'double') {
      const half = L / 2;
      c.beginPath();
      c.moveTo(-L / 2, 0); c.lineTo(-L / 2, half); c.arc(-L / 2, 0, half, Math.PI / 2, 0, true);
      c.moveTo(L / 2, 0);  c.lineTo(L / 2, half);  c.arc(L / 2, 0, half, Math.PI / 2, Math.PI, false);
      c.stroke();
    } else {
      c.beginPath();
      c.moveTo(-L / 2, 0); c.lineTo(-L / 2, L); c.arc(-L / 2, 0, L, Math.PI / 2, 0, true);
      c.stroke();
    }
  },
  async model3d(ctx) { /* … 3D 部分 … */ },
});
```

`p` 的字段：

| 字段 | 含义 |
|---|---|
| `L` | 洞口在屏幕上的像素长度（= 洞口宽 × `ppm`），符号宽度都按它算，别写死像素 |
| `sel` | 是否选中（想自己换高亮色时用） |
| `on` | 是否打开（由 `isOn` 判定，见下） |
| `ink` / `fill` | 已按选中态与开/关算好的描边色 / 填充色（开=`#fdeecb` 暖琥珀 / 关=`#fff`），直接用，填进封闭形状内部 |
| `ppm` | 像素/米；要画真实尺寸的细节（如 0.06m 宽的门梃）就乘它 |
| `style` | 当前造型内部 id（不带插件前缀），用它分支 |
| `options` | 当前样式的参数取值（同 `ctx.options`，默认值已合并），据此画左右开/内外开等差异 |
| `kind` | `'door'` / `'window'` |
| `entityId` | 绑定的开关实体（门磁 / 窗磁）id |
| `state` | 开关实体的状态对象（HA 原样或 `null`） |
| `obj` | 门窗放置数据本体 —— 拓展实体字段在上面（如窗的 `obj.posEntityId` 开度实体） |
| `getState` | `(entityId) => 状态对象\|null`，查任意实体（含拓展实体）的当前状态 |
| `rrect(x, y, w, h, rad)` | **绘制助手**：建一条圆角矩形路径（`rad` 自动钳到 `min(rad, w/2, h/2)`）。只建路径，不填不描 |
| `draw(fn, opts?)` | **绘制助手**：`beginPath() → fn() → 按调色板填色 + 描边`。默认 `fill = p.fill`、`stroke = p.ink`、`lineWidth = p.lw || 1.6`（门窗的 `p` 不含 `lw`，走 1.6）；`opts` 可传 `{ fill:false }`（只描边）、`{ stroke:false }`（只填色） |

这两个助手把「`beginPath` + 拼路径 + 设 `fillStyle`/`strokeStyle`/`lineWidth` + `fill()` + `stroke()`」的一长串样板收成一行（历史代码里有 18 处同一套三连，现已统一走它）：

```js
plan2d(c, p) {
  /* 圆角机身：填色 + 描边一步到位 */
  p.draw(() => p.rrect(-L / 2, -3, L, 6, 2));
  /* 只描边的细节线 */
  p.draw(() => { c.moveTo(-L / 2, 0); c.lineTo(L / 2, 0); }, { fill: false });
  /* 圆形符号（灯、球机）同样用 draw 包住 arc */
  p.draw(() => { c.arc(0, 0, r, 0, Math.PI * 2); }, { fill: false });
}
```

### 3.2.3 2D「开」判定 `isOn(obj, get)`

门窗的打开逻辑往往不止看一个实体（窗 = 开关实体 + 开度实体），所以门窗插件可以在 register 顶层声明自己的判定函数：

```js
PluginEngine.register({
  id: 'window', kind: 'opening', name: '窗户',
  fields: [
    { key: 'entityId',    label: '开关实体', type: 'entity' },
    { key: 'posEntityId', label: '开度实体', type: 'entity' },
  ],
  isOn(obj, get) {                    // get: (entityId) => 状态对象|null
    const sw  = obj.entityId    ? get(obj.entityId)    : null;
    const pos = obj.posEntityId ? get(obj.posEntityId) : null;
    if (sw) return (sw.state === 'on' || sw.state === 'open') && num(pos) > 0;
    return num(pos) > 0;              // 只绑开度 → 按开度
  },
  /* … */
});
```

- **绑定了哪些实体 = 插件 `fields` 里声明的 key**（值在 `obj[key]` 上），`isOn` 里按自己的字段自由组合
- **插件没实现 `isOn` 时用默认规则**：主实体 `on`/`open` 即开，未绑定视为关（与 3D 常闭一致）
- 判定结果传给 `plan2d` 的 `p.on` / `p.fill`（开=暖琥珀），插件自己不用再读状态上色
- 与设备的 `click.isOn(st)` 思路一致：领域知识放插件里；区别是门窗没有点击控制（`click` 属于设备），挂在 register 顶层

注意事项：

- 画布已经 `translate` 到洞口中心并 `rotate` 到墙方向，**不要再自己做位移/旋转**，坐标就用 `-L/2 ~ +L/2`
- 每次重绘都会被调用，保持轻量：只画线，别在 `plan2d` 里加载图片或发请求
- 造型 id 与 `styles[].id` 对应；不在 `styles` 里声明过的样式不会走到这里
- `styles[].plugin` 指向别的插件时，用的是**那个插件**的 `plan2d`（样式提供者决定符号）
- 内置 `door`（单开/双开/卷帘）与 `window`（推拉/对开/固定）都实现了 `plan2d`，可直接参考

### 3.3 坐标系

`group` 原点 = **洞口地面中心**：

- `+X` 沿洞口宽度方向（左右）
- `+Y` 向上（门扇高度从 `0` 到 `h`）
- `+Z` 垂直墙面（朝室内）

所以门框画在 `y = h/2`，门扇挂在 `x = -w/2` 的铰链组上；窗户是窗台以上一段，底部从 `0.9` 起。

### 3.4 完整示例：一扇会开的门

```js
// custom/plugins/mydoor/plugin.js
PluginEngine.register({
  id: 'mydoor',                    // 任意唯一 id；靠 type 归入洞口类型（只有同 id 才覆盖内置）
  kind: 'opening',
  type: 'door',                    // ✅ 洞口类型 'door' / 'window'，漏写样式聚合不到面板
  name: '我的门',
  fields: [
    { key: 'entityId', label: '门磁实体', domains: ['binary_sensor'] },
  ],

  model3d(ctx) {
    const T = ctx.THREE;
    const W = ctx.obj.w || 0.9;
    const H = ctx.wallH || 2.1;
    const g = new T.Group();

    // 门框（静态）
    ctx.box(g, 0.07, H, 0.12, -W / 2 - 0.035, H / 2, 0, '#d9d4c8');
    ctx.box(g, 0.07, H, 0.12, W / 2 + 0.035, H / 2, 0, '#d9d4c8');
    ctx.box(g, W + 0.14, 0.07, 0.12, 0, H - 0.035, 0, '#d9d4c8');

    // 门扇挂在铰链组上（铰链在左侧）
    const hinge = new T.Group();
    hinge.position.set(-W / 2, 0, 0);
    ctx.box(hinge, W - 0.06, H - 0.1, 0.045, (W - 0.06) / 2, (H - 0.1) / 2, 0, '#8a6f52');
    g.add(hinge);

    // 未绑门磁时门扇的静态开角（rad，缺省 1.1）
    const rest = -(ctx.obj.swing != null ? ctx.obj.swing : 1.1);
    let target = rest;

    // 每帧缓动，开关门是滑过去而不是瞬移
    ctx.animate((dt) => {
      hinge.rotation.y += (target - hinge.rotation.y) * Math.min(1, dt * 4.5);
    });

    return {
      group: g,
      update() {
        const st = ctx.getState(ctx.obj.entityId);
        target = st ? (st.state === 'on' ? rest : 0) : rest;   // on = 开门
      },
      // 不用写 dispose() 空函数（引擎会补），也不用手动调 update()：
      // 引擎在实例挂上场景后会替你调一次做初值
    };
  },
});
```

### 3.5 窗的开度优先级（内置 window 的做法）

窗有两个绑定：

| 字段 | 含义 | 状态解释 |
|---|---|---|
| `entityId` | 开关实体 | `on` = 开窗，`off` = 关窗 |
| `posEntityId` | 开度实体 | `≤1` 按比例（`0.4` = 40%），`>1` 按百分比（`40` = 40%），钳制 0–100% |

规则：开关 `off` → 必关；开关 `on` → 有开度值按比例、无则全开；只绑开度 → 直接按开度；都没绑 → 常闭。

### 3.6 门窗常见坑

1. **漏写 `type` 就在面板里看不到**：opening 的 `type` 是洞口类型（`door` / `window`），漏写控制台会 warn、`styles` 聚合不到样式下拉；`id` 随便取，只有与内置同名才覆盖内置插件。
2. **必须按 `obj.w` 自适应**：同一个门插件要服务 0.8m 卫生间门和 1.2m 入户门，写死宽度会穿墙。
3. **不要在 `model3d` 里 `await` 后再读 `ctx.obj` 的旧值**：`obj` 是引用，但场景可能已重建，引擎会丢弃过期实例；重活放 `update()`。
4. **动画只用一个 `animate`**：门扇和把手如果都要动，合并进同一个 `fn(dt)`。

---

## 4. `background` 插件（地面背景）

### 4.1 注册对象

背景插件不实现 `model3d`，改为声明 `styles[]`——每个条目就是面板里的一个背景选项。**`refresh` 覆盖 / `update` 都必须写在 `apply` 的返回值里**，写在条目上引擎不读。

```js
PluginEngine.register({
  id: 'mybg',
  kind: 'background',
  name: '我的背景',            // 面板分组标题固定取插件 name
  styles: [
    {
      id: 'lawn',             // 插件内唯一即可；引擎加前缀后全局 id = 'mybg:lawn'
      name: '草坪',
      icon: '🌿',             // 面板图标，缺省 🖼
      // 条目上只认这几个键：id / name / icon / refresh / options / apply
      refresh: 0,             // 0 = 静态只画一次；>0 = 每秒调用 update 这么多次
      options: [ /* 可调参数 schema，见 4.7 */ ],
      apply(ctx) {
        const g = new ctx.THREE.Group();
        g.add(ctx.plane(myCanvas));          // 画好的整图，见 4.5
        return {
          group: g,                          // ✅ 必须返回 3D 模型
                    // refresh: 15,                    // 可选：覆盖条目上的刷新率
          // update(t, api) { … },           // 可选：动态背景的定时回调
        };
      },
    },
  ],
});
```

### 4.2 `styles[]` 条目字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 插件内唯一；引擎会加前缀，全局 id = `<插件id>:<条目id>`（参数也按这个键保存） |
| `name` | ✅ | 面板显示名 |
| `icon` | — | 面板图标，缺省 `🖼` |
| `refresh` | — | `0`（缺省）= 静态只画一次；`>0` = 每秒 update 多少次，引擎钳制在 1–30Hz |
| `options` | — | 可调参数 schema，见 4.7 |
| `apply(ctx)` | ✅ | 画背景，统一返回 `{ group }` 3D 模型（`refresh` / `update` / `size` 也从这里返回），见 4.5 |

> 面板按**插件**分组，分组标题固定是 `plugin.json` 的 `name`；条目上的 `group` 字段不生效。同理 **`update` 写在条目上也不会被读取**——它是 `apply` 返回值的成员。
>
> 引擎只认上表这几个键。想加「平铺次数 / 随机种子」这类可配置项，请写进 `options[]` 并用 `ctx.options` 读；写成条目顶层字段会被忽略。

### 4.3 `apply(ctx)` 的 `ctx`

| 成员 | 类型 | 说明 |
|---|---|---|
| `ctx.THREE` | 命名空间 | 同上，不要另引 CDN |
| `ctx.size` | number | 参考画布边长（512）；实际一般自定更大尺寸（如 2048）铺整块地面 |
| `ctx.plane(src, sizeM?)` | 函数 | **地面网格工厂**：传入 canvas 或 THREE.Texture，返回贴好图的 120m 平面网格（已摆正 / **中心对准背景中心** / 防闪面），`add` 进 group 即用；`sizeM` 可选自定义尺寸（米） |
| `ctx.planeSize` | number | 默认平面边长（米），≥120；偏移把房子推到边缘时会自动放大。画布 ↔ 米 换算用得上 |
| `ctx.house` | object | 背景坐标系里的房屋包围盒，见 4.4 |
| `ctx.safe` | object | 安全边界（禁放区 + 可布置范围），坐标系同上，见 4.4 |
| `ctx.options` | object | 用户参数值，**已合并默认值**，直接 `ctx.options.repeat` |
| `ctx.refresh` | number | 声明的刷新率（Hz），只读参考 |

### 4.4 `house` 与 `safe`

> **坐标系**：原点 = **背景中心**（= `ctx.plane()` 平面中心、= 画布中心），不是房屋中心。
> 房屋可以通过样式参数 `offsetX / offsetZ` 偏离背景中心，所以 `house.cx / cy` 就是那个偏移量
> （0 / 0 = 房屋正落在画面中心）。`safe` 与 `house` 同一套坐标，已含偏移。

`house` 是所有楼层墙体的并集（米）：

| 字段 | 含义 |
|---|---|
| `minX` / `maxX` | 西 / 东墙边（背景坐标系里 x 的最小 / 最大值） |
| `minY` / `maxY` | 北 / 南墙边（背景坐标系里 **z** 的最小 / 最大值，名字沿用编辑器 y） |
| `w` / `d` | 东西宽 / 南北深 |
| `cx` / `cy` | 房屋中心在背景坐标系里的位置 = 偏移量（米） |
| `floors` | 有墙的楼层数 |
| `hash` | 尺寸指纹。变了引擎会自动重放背景；也可以当随机种子（`const K = PluginEngine.bgKit; K.rand(K.seed(house.hash))`），保证同一栋房子草的位置一致 |

`safe`（房屋外扩形成的禁放走廊，坐标同 `house`）：

| 字段 | 含义 |
|---|---|
| `inner` | 禁放走廊宽度，固定 `1.5` 米 |
| `outer` | 可布置半径，固定 `45` 米（以房屋中心为圆心） |
| `x0` / `x1` / `y0` / `y1` | 禁放矩形（已含 inner 外扩） |
| `forbidden(x, z)` | 是否落在禁放区 |
| `allowed(x, z)` | 是否在可布置环带内（禁放区外且半径内） |

### 4.5 `apply` 的返回值 —— 统一返回一个 3D 模型

只有一种形态：`{ group: THREE.Group }`。不存在「平面 / 立体」两种模式——
扁平背景只是「比较扁的 3D 模型」：一个平面网格贴上画好的整图，贴图想画多丰富都行；
要立体就在同一个 group 里再加体块。引擎只负责挂载，不做任何 UV / 平铺假设。

**① 扁平地面（最常用）**——用引擎给的 `ctx.plane()` 组装：

```js
apply(ctx) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 2048;            // 120m 地面一张图
  const c = cv.getContext('2d');
  c.fillStyle = '#7ea864';
  c.fillRect(0, 0, cv.width, cv.height);

  // 画布中心 = 背景中心；house.cx/cy 是房屋相对背景中心的偏移（米）
  const S = cv.width / ctx.planeSize;     // 像素/米
  const px = (x) => cv.width / 2 + x * S;
  const py = (z) => cv.height / 2 + z * S;   // 画布 y 向下 = 3D +z（南）
  const hx = px(ctx.house.cx), hy = py(ctx.house.cy);   // 房屋中心落在画布哪儿

  // …想平铺就自己把图案重复画进去，密度参数(ctx.options.xxx)自己消化…
  const g = new ctx.THREE.Group();
  g.add(ctx.plane(cv));                   // 120m 平面网格，已摆正/中心=背景中心/防闪面
  return { group: g };
}
```

**② 立体造型**——同一个 group 里再放体块（起伏地形 / 草丛 / 石头…）：

```js
apply(ctx) {
  const T = ctx.THREE;
  const g = new T.Group();
  g.add(ctx.plane(baseCanvas));           // 底图（同上）
  g.add(myTuftMesh);                      // 真 3D 体块（参考「草原」的草丛实现）
  return { group: g };
}
```

返回值字段汇总：

| 字段 | 类型 | 说明 |
|---|---|---|
| `group` | `THREE.Group` | 整块地面的 3D 模型（扁平 / 立体都是它） |
| `refresh` | number | 覆盖条目上的刷新率 |
| `update` | `(t, api) => void` | 动态背景的定时回调（按 `refresh` 的 Hz 节流，`api` = `{ group, mesh, size }`）；改了贴图自己标脏 `tex.needsUpdate = true` |

### 4.6 动态背景与 `api`

`refresh > 0` 时引擎按 Hz 调用 `update(t, api)`：

| `api` 成员 | 说明 |
|---|---|
| `group` / `mesh` | apply 返回的那个 group（根节点） |
| `size` | 数值，缺省 512（apply 返回值里带 `size` 时取它） |

> 没有 `texture` / `material` / `canvas` / `needsUpdate()`——贴图引用由插件自己在闭包里持有，改完直接 `tex.needsUpdate = true`。

```js
// 动态改图的标准写法: apply 里把 texture/canvas 存进闭包，update 里改完标脏
apply(ctx) {
  const tex = new ctx.THREE.CanvasTexture(myCanvas);
  const g = new ctx.THREE.Group();
  g.add(ctx.plane(tex));
  return { group: g, update(t) {
    repaint(myCanvas, t);          // 重画
    tex.needsUpdate = true;        // 标脏，GPU 重传
  } };
}
```

刷新率会被钳制在 30Hz 以内；连续出错 3 次引擎自动停止刷新，避免拖垮主线程。

### 4.7 `options` 可调参数

面板会根据 schema 自动渲染控件，值存在 `project.settings.backgroundOptions['<插件id>:<背景id>']`（如 `'background:grass'`）里；改参数会立刻重放背景，不重建户型。

| `type` | 控件 | 必带字段 |
|---|---|---|
| `range` | 滑条 + 数字框 | `min` `max` `step` `def` |
| `number` | 数字框 | `def`，可选 `step` |
| `select` | 下拉 | `choices: [{ value, label }]` `def` |
| `checkbox` | 复选框 | `def`，可选 `tip`（勾选框右侧文字） |
| 其它/缺省 | 文本框（按 `text` 处理） | `def` |

取值规则（与门窗/设备的**样式参数**共用同一套合并逻辑）：用户存过且非 `null` / `''` 的值优先，否则用 `def` —— 所以 `apply` 里直接 `ctx.options.key` 用，**不用再写 `|| 默认值`**（`0` 和 `false` 也都是合法值）。

```js
options: [
  { key: 'repeat', label: '颗粒密度', type: 'range', min: 8, max: 40, step: 2, def: 20 },
  { key: 'speed',  label: '流速',     type: 'range', min: 0, max: 3,  step: 0.1, def: 1 },
]
```

### 4.8 背景常见坑

1. **扁平地面一律用 `ctx.plane()` 组装**：引擎已把平面压到 `y = -0.05`（略低于房间地板）避免 z-fighting，摆正、中心对准背景中心、各向异性过滤也都做好了；自己 `new PlaneGeometry` 很容易闪面。往 group 里加的体块从 `y = 0` 起步即可。
2. **`apply()` 是同步调用**：要用的图片在插件加载时预加载成 `Image`，`apply` 里画进 canvas 再交 `ctx.plane(canvas)`；返回值里没有 `url`，引擎也不代加载。
3. **必须返回 `{ group }`**：只返回 canvas / url / texture（没有 group）会被当成没画好，引擎直接清空背景、什么都不显示。
4. **静态背景不要声明 `refresh`**：静态只在切换背景或房屋尺寸变化时画一次，零每帧开销。

---

## 5. 调试与排错

| 现象 | 优先检查 |
|---|---|
| 插件完全没出现 | `plugin.json` 的 `kind` / `id` / `version` 是否正确；`/api/plugins` 里能否看到它；控制台有没有 `PluginEngine.register` 之前的语法错误 |
| 改了代码没生效 | 没升 `plugin.json` 的 `version`（plugin.js 走 `?v=` 长缓存） |
| 设备是个灰色小方块 | `model3d` 抛错或返回了空/无 `group`，看控制台 `[plugin:<id>]` |
| 模型不显示 / 只有部分 | `ctx.glb()` 路径错或文件缺失（返回 `null`），检查 `models/` 与文件名大小写 |
| 状态不变化 | 实体没绑、`update()` 里没读状态，或实体域与 `type` 不匹配 |
| 模型发黑 | GLB 材质 metalness 过高，跑 `npm run fix:glb` |
| 门窗变成半透明板 | ①`type` 没写或不是 `door` / `window`；②门/窗实例的 `obj.style` 指向了别的插件；③本插件 `model3d` 抛错或没返回 `group` |
| 样式按钮里没有我的造型 | `styles` 为空、条目缺 `id`/`name`，或 `type` 与实例类型不一致 |
| 样式参数面板不出现 | 当前样式没声明 `options`，或 `settings.backgroundOptions` / `styleOpts` 里存的是空值（会回退 `def`） |

常用调试手段：

```js
window.__HA_DBG = true;                       // 打开引擎调试日志（生产默认关闭）
PluginEngine.byId;                            // 已注册插件表
PluginEngine.defs;                            // 已注册插件数组（按加载顺序）
PluginEngine.instances;                       // 当前场景实例
PluginEngine.bgAnim;                          // 动态背景运行态 { id, hz, interval, t, api }
PluginEngine.styles('light');                 // 某类型的全部造型（含插件前缀 id）
PluginEngine.defFor('door', 'door:double');   // 某造型实际由哪个插件负责
```

---

## 6. 附录：三份最小模板

### 6.1 device（复制即用）

```js
PluginEngine.register({
  id: 'mytest', kind: 'device', type: 'switch', name: '测试开关',
  styles: [{ id: 'wall', name: '墙壁开关', z: 1.2 }],
  click: { on: 'turn_on', off: 'turn_off', label: '开 / 关' },
  model3d(ctx) {
    const g = new ctx.THREE.Group();
    const mat = ctx.lambert('#ffffff');
    const body = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.08, 0.08, 0.012), mat);
    g.add(body);
    return {
      group: g,
      update() { mat.emissive.setHex(ctx.isOn(ctx.obj.entityId) ? 0x3355ff : 0x000000); },
      dispose() { mat.dispose(); },
    };
  },
});
```

### 6.2 opening（复制即用）

```js
PluginEngine.register({
  id: 'mywindow', kind: 'opening', type: 'window', name: '窗',
  fields: [{ key: 'entityId', label: '窗磁实体', domains: ['binary_sensor'] }],
  model3d(ctx) {
    const W = ctx.obj.w || 1.2, H = 1.2, SILL = 0.9;   // 窗台 0.9m 起，高 1.2m
    const g = new ctx.THREE.Group();
    const glassMat = ctx.lambert('#cfe6f2', { transparent: true, opacity: 0.45 });
    const glass = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(W, H, 0.04), glassMat);
    glass.position.set(0, SILL + H / 2, 0);
    g.add(glass);
    return {
      group: g,
      // update 由引擎在挂上场景后调一次、之后每次实体变化再调
      update() {
        const st = ctx.getState(ctx.obj.entityId);
        glassMat.opacity = st && st.state === 'open' ? 0.15 : 0.45;   // 开窗更透
      },
    };
  },
});
```

### 6.3 background（复制即用）

```js
PluginEngine.register({
  id: 'mybg', kind: 'background', name: '我的背景',
  styles: [{
    id: 'gray', name: '水泥地', icon: '⬜', refresh: 0,
    options: [{ key: 'dots', label: '颗粒密度', type: 'range', min: 4, max: 20, step: 1, def: 8 }],
    apply(ctx) {
      // 画一张 2048² 的完整地面（平铺次数/密度在画布内部自己消化）
      const cv = document.createElement('canvas');
      cv.width = cv.height = 2048;
      const c = cv.getContext('2d');
      c.fillStyle = '#b9b9b4';
      c.fillRect(0, 0, cv.width, cv.height);
      const dots = ctx.options.dots;      // 默认值已在 ctx.options 里合并好，不用再 || 兜底
      for (let i = 0; i < dots * 200; i++) {
        c.fillStyle = Math.random() > 0.5 ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.08)';
        c.fillRect(Math.random() * cv.width, Math.random() * cv.height, 2, 2);
      }
      const g = new ctx.THREE.Group();
      g.add(ctx.plane(cv));                    // 120m 平面网格：已摆正/中心=背景中心/防闪面
      return { group: g };     // 统一只返回 3D 模型
    },
  }],
});
```

---

相关文档：

- `assets/plugins/README.md` — 插件目录规范、引擎能力汇总
- `assets/plugins/door/plugin.js` 头部 — door 插件的完整参数手册（可作为注释版速查）
- `assets/plugins/background/plugin.js` 头部 — 背景插件 `ctx.house` / `safe` 的逐字段说明
