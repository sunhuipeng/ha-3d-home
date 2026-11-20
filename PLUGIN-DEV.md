# 插件开发手册 · PLUGIN-DEV

> 适用: `assets/plugins/`（内置）与 `custom/plugins/`（自定义）下的所有 3D 表现插件。
> 读完这一份就能写设备、门/窗、地面背景插件；每节都带可直接跑的最小示例。

**插件只有两类**（`kind` 只区分这两种）：

| kind | 管什么 | 注册要点 | 现成插件 |
|---|---|---|---|
| `device` | **设备 / 门 / 窗 / 家具统一的一类**，靠 `type` 区分 | `type` + `styles[]` + `model3d(ctx)`，可选 `click` / `stateText` / `plan2d` / `isOn` / `labels` | 设备：light / switch / fan / cover / climate / sensor / camera / vacuum / speaker / water_heater（内置 10 个）；门：`type:'door'`（内置 door + 自定义 door_rolling）；窗：`type:'window'`（内置 window + 自定义 window_fixed）；家具：`type:'furniture'`（动态绘制家具，内置示例 `assets/plugins/wardrobe`：衣柜按长度自动算门数、高度/长度/深度可调） |
| `background` | 房屋外围地面 | `styles[]`，每项一个可选背景，`apply(ctx)` 返回 3D 模型 | background（内置） |

> **门 / 窗 / 家具都不是单独的插件类别**：它们都是 `device` 插件，靠 `type` 区分——门 `'door'` / 窗 `'window'` / 家具 `'furniture'`，建造、拾取、点击全部走与设备相同的代码路径（`buildDevice` / `pickGroups` / `toggleDevice`），`plugin.json` 里写 `kind: "device"`。门窗与设备一样有属性面板「设备绑定」（主实体 `obj.entityId`）和「拓展·实体绑定」（`fields` 声明的扩展实体）；主实体**可以不绑具体实体**（内置门插件本次就是如此：门磁传感器 `contactEntityId` 与开度 `posEntityId` 全放在扩展字段里，靠插件自己的 `isOn` / `model3d` 读）。写门窗插件唯一要额外注意的是：数据在 `floors.doors` / `floors.windows`、贴墙掏洞、缺省不显示 3D 标签、不声明 `click` 就默认不可点。
> **家具（`type:'furniture'`）用于「静态家具想动态绘制」**：比如衣柜单开门/双开门、高度可调——把差异做成 `styles[].options`，在 `model3d(ctx)` 里按 `ctx.options` 动态建模，`plan2d` 自绘平面符号。家具实例**存 `floors.devices` 且 `type:'furniture'`**（不走目录静态 GLB 的 `mid`/`furnSpec`），口径与门窗一致：**缺省不显示 3D 标签**（`labels` 缺省 false）、**缺省不可点击**（`CLICK_DEFAULTS` 不含 furniture，插件不声明 `click` 就不可点）、**贴地**（`devY` 缺省 0，未设 `d.z` 时自动落地）。**用 `ftype` 声明家具分类**（`cabinet` / `table` / `bed`…，见 0.2 字段表），属性面板就会显示「柜架 · 平开门衣柜」，和家具目录的分类体系对齐。**家具库里能直接放**：左侧「家具」浮层会把所有 `type:'furniture'` 的造型按 `ftype` 合并进对应分类页签，卡片左上角标「插件」（与右上角「自定义」并存），点选后在户型图上点击即创建 `floors.devices` 实例（`style` 指向该造型），尺寸/门数等参数在右侧「样式参数」里调。**可直接抄的完整例子 → `assets/plugins/wardrobe/plugin.js`**（`ftype:'cabinet'`、纯代码建模、无 GLB、门数由长度推算）。
> **`type` 是唯一的类型键**：设备填 HA 实体类型（`light` / `switch`…），门 / 窗 / 家具填 `door` / `window` / `furniture`（这三个是「非 HA 实体域」的展示型类型）。**同一个 `type` 可以由多个插件共同提供造型**，引擎把它们的 `styles` 合并展示——门窗的「多插件」（如内置 `door` + `custom/plugins/door_rolling`）就是靠这个机制。
> **墙体掏洞（门洞 / 窗洞）与插件无关**：引擎在 `buildWall` 时按 `floors.doors` / `floors.windows` 的位置给墙面开洞，这段逻辑独立于插件，插件只负责洞口里的那扇门/窗长什么样、怎么开合。**门窗数据仍然存放在 `floors.doors` / `floors.windows`，没有和 `devices` 合并。**
> **选中某个样式 = 交给该样式所属插件全权负责**：`model3d` / `plan2d` / `click` / `stateText` / `fields` 都取那一份（统一入口 `PluginEngine.defFor(type, styleId)`；不确定样式时 `PluginEngine.defOf(type)` 拿该 `type` 的第一个插件），未选样式才回退到该 `type` 的第一个插件。所以各插件可以声明**数量不同的 `fields`**：属性面板的扩展实体区会随样式切换，切到没有 `fields` 的插件时整区隐藏。
> 注意区分三个同名字段，它们属于不同对象：插件注册里的 `type`（归属类型）、实例数据里的 `obj.type`（设备 = HA 实体类型；家具插件实例 = `'furniture'`；门窗实例没有该字段）、家具目录里的 `item.type`（家具分类枚举，与插件家具是两回事）。

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
| `kind` | ✅ | 只有两种：`device`（设备 / 门 / 窗 / 家具）或 `background`（外围地面） |
| `type` | 模型插件必填 | 插件归属的类型键。设备 = HA 实体类型，必须是 `DEVICE_TYPES` 的键：`light` `switch` `sensor` `climate` `water_heater` `cover` `fan` `media_player` `vacuum` `camera` `other`；门 / 窗 / 家具 = `door` / `window` / `furniture`（非 HA 实体域；家具实例存 `floors.devices`） |
| `ftype` | — | **家具分类**，只对 `type:'furniture'` 生效。取值必须是 `assets/catalog.json` 的 `types` 键：`sofa` `bed` `table` `cabinet` `kitchen` `bath` `deco` `other`（运行时由 `/api/catalog` 下发，前后端同一份）。作用：属性面板标题显示「柜架 · 平开门衣柜」而不是「设备 · 平开门衣柜」，家具库/后续放置入口按分类归组。没写 → 只显示「家具」；写了枚举外的值 → 归入「其他」。`styles[].ftype` 可逐造型覆盖（一个插件出多个分类的家具） |
| `description` | — | 插件说明，仅展示 |
| `entry` | — | 自定义入口路径，默认 `<插件目录>/plugin.js`，一般不用写 |

### 0.3 加载与调用顺序

```
服务端 /api/plugins 合并 assets/plugins + custom/plugins 的 plugin.json
        ↓
前端按清单注入 <script src="…/plugin.js?v=<version>">
        ↓
plugin.js 顶层执行 PluginEngine.register(def)     ← 只注册，不创建模型
```

**设备 / 门 / 窗（`kind: 'device'`）—— 每个实例一条线：**

```
用户摆放设备/门窗 → 引擎 spawn → def.model3d(ctx)    ← 此时才建 3D 对象
        ↓
HA 实体状态变化 → 引擎回调实例 update()
每一帧       → ctx.animate(fn) 里注册的 fn(dt)
场景重建/删除 → dispose()（随后 Three 资源由引擎统一释放）
```

**背景（`kind: 'background'`）—— 整块地面一条线，没有 model3d / 实例 update() / dispose()：**

```
用户选中某个背景 → 引擎调该条目 styles[].apply(ctx)   ← 此时才建 3D 对象
        ↓
refresh > 0      → 按 Hz 节流调 apply 返回值里的 update(t, api)（时间驱动）
绑定的实体变化   → 调注册顶层的 onData(fields, api)（静态背景也生效）
改参数 / 拖墙加层 → 销毁整块地面并重新 apply（引擎统一释放，无 dispose）
```

**引擎（`web/src/engine/plugins.js`）负责的事，插件不要自己实现**：

1. `/api/plugins` 合并 `assets/plugins/` + `custom/plugins/` 的清单，按 `version` 注入 `plugin.js`；`plugin.js` 顶层只做 `register()`，不建模型。
2. 聚合所有插件的 `styles`：全局 id = `<插件id>:<造型id>`（`light:strip`），面板与实例 `style` 存聚合 id；而 `model3d(ctx)` 拿到的 `ctx.style.id` 是**插件内部原始 id**，插件不用关心命名空间。造型列表直接读引擎，不再有 `catalog.json` 的 styles 这一层。
3. 场景构建时按 type/style 匹配插件并 `spawnDevice()`；插件缺失或 `model3d` 失败时由引擎统一放占位（`devicePlaceholder`：门窗半透明薄板、设备 GLB / 小立方体，含自定义 GLB 的加载与失败兜底）。
4. 统一监听 HA 状态变化分发实例 `update()`、驱动每帧动画、重建时 `dispose()`。
5. 给 UI 提供 `defFor()` / `styles()` / `styleOf()` / `clickSpec()` / `instanceClickSpec()` / `isOnOf()` / `labelOf()` / `labelOffset()` / `wantsLabel()`；`cardsOf(type, style, obj)` 同步调用插件的 `cards(ctx)`，把声明交给 `engine/cards.js`。
6. **图标与造型知识全在插件**：`styles[].icon` 由插件自己给（SVG 字符串或 emoji，不写只有 ⚙️ 兜底），2D 符号走插件的 `plan2d(c, p)`。`view3d.js` 是纯抽象层，不含任何 type 的造型知识：`buildDevice()` 只调 `PluginEngine.spawnDevice()` 再做通用变换与热区（**设备、门、窗共用这一个入口**）；墙体掏洞仍由 `view3d.buildWall()` 按 `floors.doors` / `floors.windows` 的位置算，与插件无关。

---

## 1. 通用部分（两类插件都适用）

> 坐标与单位、实体状态读取、引擎小工具这两类插件通用；**但 `ctx` 能力集合（1.2）与生命周期回调（1.4）是两套**，
> 下面已按「设备 / 门 / 窗」与「背景」分列 —— 看之前先认准自己写的是 `kind: 'device'` 还是 `kind: 'background'`。

### 1.1 坐标与单位

| 概念 | 说明 |
|---|---|
| 单位 | 全部是米（m）；`obj.rot` 全链统一存「度」（°）——设备/门/窗同一单位，2D/3D/面板不再各自换算 |
| 2D → 3D | 2D 编辑器平面 `(x, y)` → 3D 世界 `(x, z)`；3D 的高度方向是 **y 轴** |
| group 原点 | 门/窗 = 洞口地面中心；设备 = 该设备的锚点（离地高度 `d.z` 或造型 `styles[].z`） |
| 谁负责摆位 | **引擎**负责 `position` 与 `rotation.y`，插件只在自己的 group 内部组装，不要再加整体偏移 |
| 尺寸来源 | 门窗宽度用 `obj.w`，高度用 `ctx.wallH`（数据里**没有** `obj.h`）；设备用造型的设计尺寸（米），「整体比例」由引擎施加在 body 上，插件不要再乘 `d.pct` |

**「米」是刻度标签，不是换算层**：Three.js 世界坐标是纯 float、无量纲，全链路 `1 数据单位 ≡ 1 world unit`，没有任何 cm↔m 或固定缩放系数。所以需求里写「长度 0.2m」，数据 / `BoxGeometry` / `position` 里就**直接写 `0.2`**，画出来就是 0.2 个 world unit；不要写 `20`（当成 cm）、不要乘系数、也不要去找换算函数——引擎里不存在这样的函数，也没人会在下游替你纠正。UI 上拼 `' m'`、尺子标 `'m'`、面积算 `m²` 都是把这份刻度命名成米，不改变数值。全项目唯一真实的长度换算是**米 ↔ 屏幕像素**（`PPM_BASE = 60`，60px/米），只作用于 2D 画布显示，不进世界坐标。

由此带来两条写需求/写代码时要留意的边界：

- **精度**：`GRID = 0.1` 的网格吸附、`Math.round(v*100)/100`、`Math.round(x*50)`（~2cm 端点合并）只作用于**画布上拖出来的坐标点**；`0.2` 正好落在 0.1 的整数倍上，安全。但 `0.25` 拖坐标会被吸成 `0.3`，小于约 `0.02` 的几何差异会被合并掉。面板里手输的尺寸字段（`w` / `z` / `t` 等）不经过吸附，能原样保存；3D 相机 `near = 0.1`（studio `0.01`），0.2 单位的物体不会被裁掉但已接近 home 的近裁剪面。
- **模型资产**：GLB 的 glTF 原始坐标**不保证是米**，原点也不保证在包围盒中心。studio 是 `Box3.setFromObject` 量出原值直接当米写进 `item.json`；home 则按目录声明的 `w/d` 把模型归一化：**x / z 各自独立换算**（`sx = w/size.x`、`sz = d/size.z`），再把包围盒中心对到实例点、底面贴地。即模型会**精确填满** 2D 占位框——长宽比与 `w/d` 不符时会有横向/纵向拉伸（换来 2D 与 3D 占位一致），高度取 `min(sx, sz)` 不额外拉高。所以「0.2m 的部件」走 studio 路径要 GLB 原始尺寸真是 0.2，走 home 路径要在 catalog 里声明 `w/d = 0.2`——两条路都能得到 0.2 world unit，但依据不同，别混。

### 1.2 `ctx` 通用 API 总表

`ctx` 是引擎传给 **`model3d(ctx)`** 的能力集合（**设备 / 门 / 窗专用** —— 背景插件的 `apply(ctx)` 是另一套更小的集合：`THREE / size / house / safe / houseY / options / refresh / plane`，见 4.3），**不要自己从 CDN 引 Three**，否则会有两套不兼容的类。

#### 基础引用

| 成员 | 类型 | 说明 |
|---|---|---|
| `ctx.THREE` | 命名空间 | Three.js，创建 Group / 几何 / 材质 / 灯光都用它 |
| `ctx.obj` | object | 当前实例数据（设备 / 门 / 窗），字段见第 2.4 / 3.2 节 |
| `ctx.style` | object \| undefined | **设备与门窗都会传**：当前造型条目 `{ id, name, sid, plugin, z?, labelOffset?, icon?, model?, desc?, options? }`。`id` 已去掉插件前缀（`sid` 是插件内部原始 id，两者一般相同），`plugin` 是这条造型属于哪个插件，`options` 是参数的原始 schema（当前值看 `ctx.options`） |
| `ctx.options` | object | **当前样式的参数取值**，如 `{ hand:'left', open:'in' }`。已经「条目 `def` ∪ 实例 `obj.styleOpts`」合并好，直接读即可；样式没声明 `options` 时是 `{}`。详见 2.2.1 |
| `ctx.wallH` | number | 当前楼层净高，吸顶灯/吊灯贴顶、门窗按层高兜底都用它 |
| `ctx.baseUrl` | string | 插件目录 URL，一般不用直接拼，用 `ctx.glb()` 即可 |
| `ctx.view` | View3D | 高级用法：`view.scene`、`view.loadModel()`、`view.render()`。日常只需 `ctx.render()` |

#### 几何与材质（当前 group 内部绘制）

| 函数 | 参数 | 返回 | 作用 |
|---|---|---|---|
| `ctx.glb(file)` | `file` 相对插件目录，如 `'models/frame.glb'` | `Promise<Object3D \| null>` | 加载插件自带模型。**内部按 URL 缓存原型并返回 clone**，多实例互不干扰；失败返回 `null`，必须自己兜底。URL 自动带 `?v=<plugin.json version>`（服务端对带 `?v=` 的资源长缓存 immutable）——**换/改 GLB 后升 `plugin.json` 的 `version` 即可让浏览器拉新文件**，无需手工清缓存 |
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

> `kit.set(on, rgb, bright?)` 第三参可选（0~1）；不传时引擎自动读主实体 `attributes.brightness`，让光晕 / 自发光 / 点光 / 聚光都随亮度连续变化，与房间地面亮度同口径。光晕是「外晕 + 亮核」两层 Additive Sprite，全局观感参数集中在 `web/src/engine/plugins.js` 的 `LAMP_GLOW`——**调整体灯够不够亮只改那里**，不要在插件里另画一套光效（7 种灯型与所有用 `lightKit` 的插件共用）。

#### 读实体状态

> **`eid` 是什么**：插件里它只来自两个地方 —— **主实体 `ctx.obj.entityId`**（用户给该实例绑定的 HA 实体，最常用）和 **拓展实体 `ctx.obj.<字段>`**（`fields` 声明的绑定值，如 `ctx.obj.posEntityId`）。不要自己拼实体 id。

| 函数 | 参数 | 返回 | 作用 |
|---|---|---|---|
| `ctx.getState(eid)` | HA 实体 id | `{ entity_id, state, attributes, last_changed }` 或 `undefined` | 读任意实体完整状态。**必须传 id**（主实体传 `ctx.obj.entityId`，拓展实体传 `ctx.obj.<字段>`），不传返回 `undefined` |
| `ctx.isOn(eid)` | HA 实体 id | boolean | 开关判定：`state==='on'`，或该实体属 `light`/`switch`/`fan` 且状态不是 `off`/`unavailable`/`closed` |
| `ctx.binaryRatio(eid)` | HA 实体 id | `1` / `0` / `null` | 二态开合比例：`on`/`open` → `1`，其它 → `0`，未绑或实体不存在 → `null`。门窗插件的「开合动画目标值」直接用它 |
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

**`eid` 一律是 HA 实体 id**（`light.lamp` 这种），插件代码里不自己拼 id，只从实例数据拿：**主实体**（设备自身 / 门窗主绑定）就是 `obj.entityId`，**拓展实体**就是 `obj.<fields 声明的字段>`（如窗的 `obj.posEntityId` 开度实体）：

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
| `valueType` / `enumValues` | — | **studio 附加的说明字段**（`valueType`: `number` 数值类 / `text` 字符类 / `enum` 枚举类；`enumValues`: 枚举候选值数组）。home 引擎不读、原样透传；从 studio 项目同步 schema 时照抄保留，不要删 |

> **所有 `device` 插件（含门 / 窗 / 家具）的主实体都走「设备绑定」**，写进 `obj.entityId`，**不要把 `entityId` 写进 `fields`**（扩展字段要换名字，如 `contactEntityId` / `posEntityId`）。`fields` 只声明「除主实体外」的扩展实体（门磁、开度、功率、温湿度…），渲染在「拓展·实体绑定」区。**主实体可以留空**：此时卡片按统一规则不显示，插件若要反映扩展实体的状态，得自己实现顶层 `isOn(obj, get)` 与 `model3d` 里的读取（引擎默认判定只读 `obj.entityId`）。主实体没绑定时卡片不显示，绑定后才出卡。
>
> **同 `type` 多插件时，`fields` 是「每个插件各写各的」**：属性面板展示的永远是**当前选中样式所属插件**声明的那份字段（切换样式即换一份，该插件没声明 `fields` 就整区隐藏）。别把一个形状的专属实体写进同 `type` 的另一个插件里——宁可每个插件各自声明，也不要为了「合并显示」去堆共享字段。
>
> **背景插件的 `fields` 是另一套机制**：它不落在设备实例 `obj[key]` 上，而是「动态实体订阅」声明 —— 引擎在实体状态变化时回调插件顶层的 `onData(fields, api)`。设备/门窗的实例级 `update()` 与背景的顶层 `onData()` 互不冲突、互不影响，详见 **4.9**。

#### 1.3.1 读 `attributes` 的「属性契约」（用 studio / AI 开发时尤其重要）

HA 实体除了 `state` 主值，还携带大量 **`attributes`**：灯的 `brightness` / `rgb_color`、空调的 `temperature` / `current_temperature` / `hvac_action` / `fan_mode` / `swing_mode`、播放器的 `media_title` / `volume_level`……`stateText(st, obj, get)` 里直接读 `st.attributes`，`model3d` 的 `update()` 里用 `ctx.getState(eid)` 取完整状态再读。一律先兜底 `const at = (st && st.attributes) || {}`，数值用 `ctx.toNum()` 过滤 `unknown` / `unavailable` / 空串。

**内置 `assets/plugins/climate/plugin.js` 是一份完整范例**：文件头先声明「属性契约」，`update()` 再逐项消费，一个属性都不浪费：

| 属性 | 驱动的表现 |
|---|---|
| `temperature` / `current_temperature` | 机身 Canvas 屏：目标温度（大字）+ 室温（小字） |
| `hvac_action` | 模式 LED 颜色（cooling 蓝 / heating 橙红 / 其余绿）+ 屏幕模式文字 |
| `fan_mode` | 屏幕右下风速 |
| `swing_mode === 'vertical'` | 出风叶片上下扫风（否则定角微摆） |
| `current_humidity` | 湿度扩展实体未绑定时的兜底显示 |

**用 studio / AI 生成插件时**：不同品牌集成的属性名不一样（米家 companion 与 ESPHome 的空调 `attributes` 可能完全不同），AI 不知道实体长什么样就会瞎猜字段名。请**在提示词里把该实体的相关属性列全**（HA 开发者工具 → 状态里能看到全部 attributes），让 agent 按这份契约实现，并写清「缺属性时怎么兜底」。例如：

> 我的空调是米家 companion 集成，实体属性有 `hvac_modes` / `min_temp` / `max_temp` / `temperature`（目标温度）/ `current_temperature`（当前室温）/ `fan_mode` / `hvac_action`（cooling/heating/idle…）/ `swing_mode`（'vertical' 为上下扫风）。请实现：机身屏幕显示目标温度和室温、LED 按 `hvac_action` 变色、`swing_mode='vertical'` 时叶片上下扫风。

按契约开发的好处：读哪个属性、缺属性时怎么兜底都有明确依据，换品牌集成只需改提示词里的属性清单，不用重写插件。

### 1.4 生命周期回调一览

**两类插件的回调完全是两套，不要混着看**：

- 设备 / 门 / 窗的一切围绕 **`model3d(ctx)`**（每个实例一个模型），`update()` 由**实体状态变化**驱动；
- 背景的一切围绕 **`styles[].apply(ctx)`**（整块地面一个模型），没有 `model3d` / 实例 `update()` / `dispose()`，
  它的 `update(t, api)` 由**时间（`refresh` 的 Hz）**驱动，实体数据走顶层 `onData(fields, api)`。

#### 设备 / 门 / 窗插件（`kind: 'device'`）

> 带 `↳` 的行是**上一行返回值 / 对象里的成员**，不是 `register()` 的顶层字段 —— `update()` / `dispose()` 写在 `model3d(ctx)` 返回的对象里，引擎拿返回值时才看到它们。

| 回调 / 注册字段 | 签名 | 何时被调用 / 取值 | 必须实现 |
|---|---|---|---|
| `model3d(ctx)` | `(ctx) => { group, update?, dispose? }` 或 Promise | 实例创建时（每次场景重建一次） | ✅ |
| `↳ update()` | `() => void` | HA 实体状态变化后（引擎批量回调所有实例的 update；挂上场景时也先调一次做初值） | 建议 |
| `↳ dispose()` | `() => void` | 场景重建 / 设备删除前（清自己的定时器、监听） | 可选 |
| `ctx.animate(fn)` | `fn(dt: number)`，model3d 内调用 | 每帧 | 可选 |
| `stateText(st, obj, get)` | 返回 string | 每条状态更新时算标签文案 | 可选（设备与门窗都支持） |
| `click.on/off` | 服务名或 `{service, domain}` | 用户点击设备 / 门窗时 | 可选（设备缺省有内置语义；门窗必须自己声明） |
| `isOn(obj, get)` | 返回 boolean \| null | **开/合判定的唯一入口**：决定点哪个服务、3D 高亮、**2D 平面图开/关底色**、统计口径。设备与门/窗都写在这（设备：窗帘 `open`、扫地机 `cleaning`、音箱 `playing`；门窗：多实体组合）。返回 `null` = 我不判定，引擎回退默认规则。见 3.2.3 | 可选 |
| `labels` | boolean | 是否要 3D 状态标签。**门 / 窗缺省 `false`**（避免洞口旁挂一堆字），设备缺省 `true`；注册时定死，实例不再判断 | 可选 |
| `z` | number | 锚点离地高度缺省（实例 `obj.z` 优先）。门/窗贴地声明 `0`；设备缺省走目录造型 `z`，再兜底 `1.2` | 可选 |
| `hitY` | number | 锚点热球（保底拾取热区）球心高度：窗 `1.4` / 门 `1.1`，缺省 `0`（= 锚点处） | 可选 |
| `labelOffset` | number | 标签相对锚点的抬升缺省：door `1.05` / window `1.45`，设备缺省 `0.3`（造型 `styles[].labelOffset` 与实例 `obj.labelOffset` 可再覆盖） | 可选 |
| `labelBaseY` | number | 3D 标签锚点基准高度（门/窗 = 模型竖直中部）；不声明则回退锚点高度（设备 = `devY`） | 可选 |
| `defaultW` | number | 编辑器放置缺省宽度：door `0.9` / window `1.2` | 可选 |
| `placeholder` | `{ w, h, color, y }` | 无插件/创建失败时的占位薄板（`y` 缺省 `h/2`） | 可选 |
| `plan2d(c, p)` | `(CanvasRenderingContext2D, p) => number \| void` | 编辑器重绘 2D 平面图时（按需渲染，不是 rAF 每帧）；建议返回包围半径 px。**设备 / 门窗专用，背景没有 2D 符号** | 可选（见 2.8 / 3.5） |

#### 背景插件（`kind: 'background'`）

没有 `model3d`，整块地面的建模 / 刷新 / 实体数据全在下面三个入口（详见第 4 章；带 `↳` 的行是 **`apply(ctx)` 返回值**里的成员，不是 `register()` 的顶层字段）：

| 回调 / 注册字段 | 签名 | 何时被调用 / 取值 | 必须实现 |
|---|---|---|---|
| `apply(ctx)` | **每个 `styles[]` 条目一个**；返回 `{ group }`（可附 `refresh` / `update` / `houseY`，见 4.5） | 背景被选用、参数改变、房屋尺寸变化重放时调用；每次重放**销毁重建**整块地面（引擎统一释放，背景没有 `dispose`），`ctx.house` 等要在 `apply` 里现算 | ✅ |
| `↳ update(t, api)` | `t` 秒、`api = { group, mesh, size }` | `refresh > 0` 时按 Hz 节流调用（**时间驱动**，与实体状态无关）；改了贴图自己 `tex.needsUpdate = true` | 可选 |
| `onData(fields, api)` | 写在注册对象**顶层**；字段状态表、`api`（含 `overlayGroup`） | 绑定的动态实体数据变化时回调；**与 `refresh` 无关，静态背景也生效**。与 `apply` 的 `update` 物理隔离、各管各的子树（见 4.9） | 可选 |
| `styles[].refresh` | Hz；`0`/缺省 = 静态（只画一次），`1..30` = 每秒回调 `update` 这么多次 | 注册时声明（**推荐写这里**）；`apply` 返回值的 `refresh` 会强制覆盖它，不建议用 | 可选 |

### 1.5 通用注意事项

1. **别自己摆位置**：引擎已经设置 `group.position` 和 `rotation.y`，你在 group 里加偏移会导致摆放错位。
2. **GLB 必须判空**：`await ctx.glb()` 可能返回 `null`（文件缺失/网络失败），要有代码兜底几何，否则设备凭空消失。
3. **多实例用 `ctx.glb`**：它内部 `clone(true)`；直接 `view.loadModel()` 后 `add` 会让第二个实例把模型「抢走」。
4. **改代码升版本**：`plugin.json` 的 `version` 不变，浏览器会一直用缓存的旧 plugin.js。
5. **异步 `model3d` 要注意场景已换代**：引擎会丢弃过期实例，但你自己的定时器/事件监听要在 `dispose()` 里清掉。
6. **调试日志**：生产模式 `window.__HA_DBG === false` 会静默，开发时可在控制台置 `true`；错误统一前缀 `[plugin:<id>]`。
7. **整个文件包一层 IIFE**：所有 `plugin.js` 都是用 `<script>` 独立加载的**经典脚本**，共享同一个全局作用域。两个插件都写顶层 `const ico = …` 会直接 SyntaxError，后面的插件全部注册不上。内置 14 个插件（10 个设备 + 门 + 窗 + 家具示例 wardrobe + 1 个背景 background）现在都是 `'use strict';` + `(function () { … })();` 的写法，照抄即可。

### 1.6 引擎提供的小工具（`PluginEngine.*`）

下面这些是**引擎统一实现、插件直接复用**的通用逻辑。历史上每个插件各写一份（15 份 `ico`、6 份本地 `rrect`、10 处 on/off 中文三元…），现已全部下沉，写新插件**不要再复制这些代码**。

| 工具 | 签名 | 作用 |
|---|---|---|
| `PluginEngine.ico(inner)` | SVG 内片段 → string | 包成 24×24、`fill:none`、`stroke:currentColor`、`stroke-width:1.7` 的线性 SVG（跟随主题色）。`const ico = PluginEngine.ico;` 后照常 `ico('<path …/>')` |
| `PluginEngine.fieldBits(obj, get, list)` | 见 1.3 | 把扩展实体数值拼成 `' · 320W'` 这样的尾巴 |
| `PluginEngine.isOnState(st)` | 状态对象 → boolean | **二态开判定**：`state === 'on'` 或 `'open'` 算开（门磁 / 窗磁 / 人体感应的通用口径）。`isOn(obj,get)` 里想表达「就看 on/open」可直接引用它 |
| `PluginEngine.runningState(st, opts?)` | 状态对象 → boolean | **运行态判定**：只要不是 `off` / `unavailable` 就算在运行，覆盖 `cleaning` / `playing` / `cool` / `heat` 这类多模式域；个别域用 `off` 表示待机时传 `{ countOff: true }` |
| `PluginEngine.baseStateText(st, map?)` | 状态对象、可选映射表 → string | 标签文案底座：默认 `{ on:'已开启', off:'已关闭' }`，表里没有的状态原样返回（`unavailable` → `'unavailable'`）。要换词就传 `map`，如 `baseStateText(st, { off: '已断电' })`（传了 map 就整体替换默认表） |
| `PluginEngine.defFor(type, styleId)` | 类型 + 聚合样式 id → 插件定义 \| null | 查「这个造型由哪个插件负责」，`fields` / `plan2d` / `click` / `stateText` 全走它；调试时很好用 |
| `PluginEngine.styles(type)` | 类型 → 造型数组 | 某类型的全部造型（`id` 带 `<插件id>:` 前缀，`sid` 是插件内部 id，`plugin` 是所属插件） |
| `PluginEngine.labelOffset(type, styleId)` | 类型 + 样式 → number | 该造型的标签抬升高度（米）：实例 > 造型 `labelOffset` > 插件 `def.labelOffset` > 缺省 `0.3`（门/窗的高度由各自插件声明） |
| `PluginEngine.labelBaseY(type, styleId)` | 类型 + 样式 → number \| null | 3D 标签锚点基准高度（插件 `def.labelBaseY` 声明，如门/窗模型中部）；未声明返回 `null`，调用方回退锚点高度 |
| `PluginEngine.wantsLabel(type, styleId)` | 类型 + 样式 → boolean | 该类型实例是否显示 3D 标签（`register` 的 `labels`，门/窗缺省 `false`） |
| `PluginEngine.isOnOf(type, styleId, obj, get)` | → boolean \| null | **插件判定的唯一入口**：调插件顶层 `isOn`，`get` 省略时走 `HA.getState`；返回 `null` 表示插件不判定 |
| `HA.deviceIsOn(d)` | `{ entityId, type, style }` → boolean | 有实例时的包装（2D 底色、3D 标签高亮、统计、点击方向全用它）：`isOnOf` → `HA.isOn` 默认规则 |
| `HA.entityIsOn(eid, type)` | 实体 id + 类型 → boolean | 没有实例/造型时用（实体列表、大屏快捷设备）：合成 `{entityId, type}` 交给插件 |

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

## 2. `device` 插件（设备 / 门 / 窗造型）

### 2.1 注册对象字段

```js
PluginEngine.register({
  id: 'myplug',            // 唯一 id，同 id 覆盖内置
  kind: 'device',          // 设备 / 门 / 窗都是这个
  type: 'switch',         // 必须与 HA 实体域对应，决定出现在哪个设备分类；门/窗填 'door' / 'window'
  name: '我的插座',
  labels: true,           // 可选：是否显示 3D 状态标签，设备缺省 true、门/窗缺省 false
  styles: [ /* 造型列表，见 2.2 */ ],
  fields: [ /* 扩展实体，见 1.3；主实体走「设备绑定」，不要写 entityId */ ],
  click: { /* 点击控制，见 2.3；门/窗必须自己写，没有内置默认 */ },
  stateText(st, obj, get) { /* 标签文案，见 2.3 */ },
  isOn(obj, get) { /* 顶层开/合判定，可组合多实体，见 3.2.3 */ },
  plan2d(c, p) { /* 2D 平面图形，见 2.8 */ },
  cards(ctx) { /* 设备控制卡声明，见 2.9；不写则可点设备自动兜底单开关卡 */ },
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
| `icon` | — | 面板样式按钮的图标，**由插件自己提供**（与门窗 `styles[].icon` 完全一致）：SVG 字符串或 emoji。不写只显示 ⚙️ 兜底，引擎不再维护内置图标表。**也是卡片卡头图标**：单设备视图的卡头徽标优先取实例 `style.icon`（SVG 走 `v-html`、线条 `stroke:currentColor` 跟随主题蓝），造型没声明 icon 才按设备类型兜底（2026-11-14 起） |
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

> **背景插件保留键（位置参数组）**：`offsetX`（东西）/ `offsetZ`（南北）/ `houseY`（离地高度）
>
> - `offsetX` / `offsetZ`：房屋在背景画面中偏离中心多少米（默认 0，钳制 ±60）。引擎把它算进 `ctx.house` / `ctx.safe`，所以 `house.cx / cy` 就是偏移、`safe.forbidden()` 已带偏移。方向仍是统一手感：滑块「往右拖 = 背景 往左/往上」，即 +X = 房屋相对偏东、+Z = 房屋相对偏南。
> - `houseY`：**房屋地板相对背景基准面 `y = 0` 的高度（米）**，默认 0，范围 −10 ~ 30，可为负。正值 = 房屋悬空 / 建在山顶平台，负值 = 房屋在低洼 / 下沉庭院。引擎读它把**整栋房屋**（`View3D.root`）抬到 `y = houseY`，设备 / 家具 / 门窗的高度仍相对房屋、实例数据不写这个值；同一个值也交给插件（`ctx.options.houseY`、`ctx.house.y`、`ctx.safe.houseY`），插件据此在 `y = houseY` 画脚下平台或挖坑。
>
> 三条滑条由 `bgKit.positionOpts(xzRange?, houseYDef?)` 一次生成（`bgKit.offsetOpts()` 是旧版两条，仍兼容）。值按 `<插件id>:<背景id>` 存在 `project.settings.backgroundOptions`，**每个背景样式各自一份**：给「山顶」样式设 `def: 6`、给「低洼」样式设 `def: -3`，切换样式时房屋自动升降。内置背景插件已全部带上。


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

### 2.3 `click`、`isOn` 与 `stateText`

```js
click: {
  on: 'turn_on',                        // 或 { service: 'media_play', domain: 'media_player' }
  off: 'turn_off',
  label: '播放 / 暂停',                  // 属性面板勾选文案
  defaultOn: false,                     // 默认不启用点击（纯展示设备用）
                                        // ⚠ 同时隐藏设备卡片标题右侧的电源开关（见下方说明）
  feedback: true,                       // 执行后弹一条提示（动作没有可见状态变化时用）
},
```

> **标题电源开关与 `cards()` 无关**：设备卡片标题右侧那个胶囊开关（CardPowerToggle，
> label 取 click.label 的开词/关词）不是 `cards()` 画的，显隐唯一条件是
> `instanceClickSpec()` 返回非 null —— 即「插件声明了 click 且 `defaultOn !== false`」
> 或「实例勾选了点击控制（`obj.click === true`）」。所以 `defaultOn: false` 的设备
> （speaker / camera）默认**没有**标题开关，勾上「点击控制」后才出现；
> 想让开关默认就在，删掉 `defaultOn: false` 即可。

```js
/* 高级用法：on / off 也可以是自定义函数（带参数 / 多步 / 条件动作时用）。
 * 方向仍由引擎按 isOn 驱动（关着调 on、开着调 off），函数只决定「怎么做」：
 *   fn(obj, api) — obj 是实例数据；api = { call(dom, svc, data), get(eid), toast(msg), obj }
 * 函数内自己发服务，不受「必须绑定实体」限制；同步抛错 / Promise 拒绝都会被引擎拦住弹提示。
 * 实例在下拉里选了「点击动作」时仍会覆盖函数（字符串服务对优先级最高）。
 */
click: {
  on(obj, api) {                        // 例：空调一键 23°C 制冷
    api.call('climate', 'set_temperature', { entity_id: obj.entityId, temperature: 23 });
    api.toast('已调到 23°C');
  },
  off: 'turn_off',                      // 字符串和函数可混用
  label: '制冷 23°C',
},

/* 「当前算不算开着」—— 唯一判定入口（设备、门、窗同一套）。
 * click 里没有 isOn：判定和"点下去发什么"分开，2D 底色 / 3D 高亮 / 统计 / 点击方向共用这一个结论 */
isOn(obj, get) {
  const st = obj.entityId ? get(obj.entityId) : null;
  return !!(st && st.state === 'playing');   // obj = 实例数据，get = (eid) => 状态对象
},
```

未声明 `click` 时按 `type` 取内置默认：`light` / `switch` / `fan` / `cover` 用 `toggle`，`water_heater` / `climate` 用 `turn_on` / `turn_off`；其余类型默认「不可点击」。

`isOn` 返回 `null`（或不实现）= 「我不判定」，引擎回退默认规则：主实体 `on`/`open` 即开，未绑定视为关。常用写法：

```js
isOn(obj, get) { return PluginEngine.runningState(obj.entityId ? get(obj.entityId) : null); },  // 空调/热水器：非 off 即在运行
isOn(obj, get) { return PluginEngine.isOnState(obj.entityId ? get(obj.entityId) : null); },     // 只看 on/open
```

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

**各内置插件声明的扩展实体（`fields`）**：

| 插件 | `fields` | 用途 |
|---|---|---|
| light | `motionEntity` 人体感应、`luxEntity` 环境照度 | 标签显示「有人 / 320lx」 |
| switch | `powerEntity` 功率、`voltageEntity` 电压、`currentEntity` 电流、`energyEntity` 电量（均 sensor）、`countdownEntity` 倒计时（input_number） | 卡片：倒计时出分钟 `range`（量程读实体的 `min`/`max`/`step`，写 `set_value`），四个 sensor 出 `label` 读数；标签仍显示「45W / 1.2kWh」 |
| sensor | `batteryEntity` 电量、`humidityEntity` 湿度 | 标签显示湿度与电量（低电量变 ⚠） |
| climate | `humidityEntity` 湿度、`outdoorEntity` 室外温度 | 机身屏幕右下湿度；标签显示室内外对比 |
| water_heater | `powerEntity` 功率、`ambientEntity` 环境温度 | 主实体无 `heating_power` 时用功率驱动屏幕与呼吸灯 |
| cover | `luxEntity` 照度、`rainEntity` 雨感 | 标签显示「320lx / 有雨」 |
| fan | `tempEntity` 室温、`humidityEntity` 湿度 | 标签显示环境温湿度 |
| vacuum | `batteryEntity` 电量、`areaEntity` 清扫面积 | 标签显示「🔋78% / 32㎡」 |
| camera | `motionEntity` 移动侦测、`storageEntity` 存储余量 | 检测到移动时模型红灯快闪 + 标签提示 |
| speaker | `sourceEntity` 音源、`titleEntity` 当前曲目 | 触屏左上显示音源；曲目缺失时用它补 |

> 门 / 窗（`door` / `window`）沿用同一套机制，但它们**没有独立的「设备绑定」输入框**，`fields` 里放的就是门磁 / 开度实体（主绑定）。

**各内置插件的点击行为**（下表是插件**显式声明 `click`** 后的实际行为；「未声明 `click` 时按 type 取内置默认」的规则见 2.3，两者不要混为一谈）：

| 插件 | type | 点击行为 | 默认 |
|---|---|---|---|
| light | light | `turn_on` / `turn_off` | 可点 |
| switch | switch | `turn_on` / `turn_off` | 可点 |
| fan | fan | `turn_on` / `turn_off` | 可点 |
| cover | cover | `open_cover` / `close_cover`（state=open 或 position>0 视为已打开） | 可点 |
| water_heater | water_heater | `turn_on` / `turn_off` | 可点 |
| climate | climate | `turn_on` / `turn_off`（state 非 off 视为运行） | 可点 |
| vacuum | vacuum | `start` / `return_to_base`（cleaning/returning/paused 视为清扫中） | 可点 |
| sensor | sensor | `homeassistant.update_entity` 刷新读数（带 `feedback` toast） | 可点 |
| speaker | media_player | `media_play` / `media_pause`（state=playing 视为播放中） | **不可点**（`defaultOn:false`） |
| camera | camera | `turn_on` / `turn_off`（多数摄像头不支持） | **不可点**（`defaultOn:false`） |

> 设备数据字段 `click: true|false` 可强制开 / 关，未设置则跟随 `defaultOn`。门 / 窗**没有内置点击默认值**：插件没声明 `click` 就只显示不响应，声明了就跟设备一样跟随 `defaultOn`；发服务的域按绑定实体前缀推导（`cover.garage` → `cover`），也可在 `click` 里显式写 `domain`。
>
> `stateText` 的引擎入口是 `PluginEngine.labelOf(type, state, obj, get?)`，异常会被捕获并回退通用文案（见 1.6）。

---

### 2.8 设备的 2D 简笔模型 `plan2d(c, p)`

和门窗（3.2.2）同一套机制：2D 平面图上的设备符号由插件自绘一个**俯视简笔模型** —— 空调画内机长条、热水器画储水罐、风扇画三叶扇……让用户一眼认出设备类型。

**职责分工（重要）**：`plan2d` 只画「中性线稿模型」，状态和选中视觉全部由抽象层（编辑器 + 引擎调色板）接管：

| 视觉 | 谁负责 | 怎么做 |
|---|---|---|
| 开 / 关（判定） | 插件声明则优先 | 状态判定跟随顶层 `isOn(obj, get)`（窗帘 `open`、扫地机 `cleaning`、音箱 `playing` 等复杂状态由插件判断）；没声明时回退默认规则（`HA.isOn`）。插件不用在 `plan2d` 里重复判断，只管拿 `p.on`/`p.fill` 画 |
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
- **点击命中与绘制共用同一份形状**：编辑器用像素拾取判定点击，`p.fill` / `p.ink` 画出的实体轮廓 = 可点区域（外扩约 6px 屏幕余量）；**半透明装饰（如摄像头视场扇 `rgba(…,.12)`、空调气流弧）不参与命中也不遮挡** —— 想让某块"看得见但点不中"，就把它画成半透明

### 2.9 设备控制卡 `cards(ctx)`

卡片引擎在 `web/src/engine/cards.js`（同时桥接成 `window.CardEngine`），Vue 组件在 `web/src/components/common/cards/`。`cards(ctx)` 由 `PluginEngine.cardsOf()` 在每次卡片结构重建时调用，**必须同步返回数组**；返回 Promise / `null` / 抛异常都按「未声明」处理（异常会 `console.warn` 并回退兜底卡）。控件里**不写实体 id**，实体来源由 `key` 声明。

**`cards(ctx)` 的入参**（都是只读，用来决定「声明哪些控件」，不要在 `cards()` 里发服务或改状态）：

| `ctx` 字段 | 说明 |
|---|---|
| `type` | 插件 type（如 `'fan'` / `'cover'`），门/窗也走同一套 |
| `obj` | 设备实例数据：`entityId` / `style` / `click` 以及 fields 绑定的值 |
| `style` | 当前造型的 `sid` |
| `options` | 合并过缺省值的当前造型参数（同 `model3d` 里的 `ctx.options`） |
| `entityId` | 主实体 id（等价于 `obj.entityId`） |
| `getState(eid)` | 读任意实体的 `{ state, attributes, last_changed }`，读不到返回 `null` / `undefined`（都要判空） |
| `isOn(eid)` | 该实体当前是否「开」（HA 侧判定，`switch` 类型控件读的就是它） |

**不写 `cards()` 时**：只要插件**可点击**（声明了 `click` 或属内置可点类型），引擎会自动兜底一张「单元素 switch」卡，点击**完全复用插件自身的 `click`**（与标题右侧电源开关同一套，含 `on` 为函数的形态）；完全不可点的插件（`clickSpec` 为空）则不出卡。兜底卡的控件带 `_defaultToggle` 标记，走 `HA.toggle` 而不走 `actionOf`。

**返回结构：只返回数组，不需要 `type: 'group' / 'single'` 之类的包装**

| 写法 | 含义 |
|---|---|
| `[ {…} ]` | **single**：一维数组、只有一个控件。容器层会把它和**其它插件返回的单个元素**收集到一起按布局平铺 |
| `[ [{…}], [{…},{…}] ]` | **group**：二维数组，每个子数组 = 一行 |
| `[ {…}, {…} ]` | 偷懒写法：一维多元素 = 只有一行的 group |

**布局（总宽 4 列，`columns` 取 1~4）**

> **书写约定：`columns` 默认不写**。引擎一行自动平分，只有「一行多个且需要**不等分**」时才给要特殊宽度的那几个控件写 `columns: 1~4`，其余省略、由引擎把剩余列平分。**不要给每个控件都挂 `columns: 2` / `columns: 4`** —— 内置插件里逐控件写 `columns` 是历史冗余写法，照抄只会让 DSL 变脏、改行宽时要连改一串数字；抄内置插件只抄结构与字段，不抄 `columns`。

- **不写 `columns`** → 一行直接平分：一行至少 1 个、最多 4 个控件，宽度由它们均分（常见默认是每行 2 个，各占 2 列）。
- **写了 `columns`** → 严格按指定宽度占列，优先于自动分配。
- **一行里部分写、部分没写** → 写了的按指定宽度，剩下的列由没写的控件平分（每个至少占 1 列）。
- 单行总宽超过 4 列时由 CSS grid 自动折行，不会挤压控件。
- single 卡（与其它插件的单元素一起平铺）：**所在网格块只有它一个元素时占满全宽（4 列）**；块里有多个元素时，没写 `columns` 默认占 2 列（半行），写了按 1~4 夹取。宽度由容器层 `CardDevices` 按块内元素数动态分配，引擎不写死。

**`type` → 组件（一一对应；`componentOf()` 是纯查表，不按 `action` 隐式改派）**

| `type` | 组件 | 读值 | 点击行为 | `service_data` 带值 |
|---|---|---|---|---|
| `switch` | `CardToggle` | `env.isOn(eid)`（实体 state 的 on/off） | 发 `action`，一次性动作 | 否 |
| `bool` | `CardToggle` | `attributes[attr]` → 布尔 | 发 `action`，值**自动取反** | 是 |
| `range` | `CardRange` | `attributes[attr]` / state → number | **按住把手拖动**时只改本地显示（数字实时跟随），松手才发一次 `action`，滑块值；**窄屏点轨道不响应，宽屏点轨道直接定位** | 是 |
| `select` | `CardSelect` | 原值（不转字符串） | 发 `action`，选中值 | 是 |
| `choice` | `CardChoice` | 原值（不转字符串） | **宽屏**点选项即发 `action`；**窄屏**按住滑动到目标选项、松手才发一次（原地轻点不响应），选中值 | 是 |
| `label` | `CardReadonly` | 原值 / `option` 里的中文映射 | **不响应点击**（写 `action` 也无效） | — |
| `button` | `CardButton` | **不读实体状态**（无值，`label`省略时兜底 `'执行'`） | 发 `action`，一次性动作 | 否 |
| `image` | `CardImage` | `attributes[attr]` → 图片 URL（只读） | **不响应点击**（纯展示，无 `action`） | — |

组件源码都在 `web/src/components/common/cards/`：`CardView` / `CardDevices` / `CardGroup` 是容器层，`CardPowerToggle` 是标题右侧的电源开关（不在 `cards()` 里声明，见下文）。**禁用态**：实体取不到，或 `state` 为 `unavailable` / `unknown` → 所有控件禁用；`switch` / `bool` / `button` / `choice` 没写 `action` 也禁用（避免出一个点不动的假控件）；写了 `lock: true` 且所属设备关着也禁用（见下）。

> **`image`（只读图片卡 / 清扫地图）**：`type: 'image'` 专门显示 HA `image` 实体的图片，典型是扫地机的清扫地图 —— 实体 `image.xxx_map` 的 `state` 是 ISO 更新时间戳，`attributes.entity_picture` 是图片地址（真机形如 `/api/image_proxy/image.xxx_map?token=…`，相对 HA 根 + 自带鉴权 token，不用自己拼 token）。声明写法：`{ type: 'image', key: '<地图实体的 fields 键 或完整 entity_id>', attr: 'entity_picture', label?: '清扫地图', require?: '<fields 键>' }`。引擎用通用 `readValue` 把 `attributes[attr]` 读进 `_value`，组件自动把相对路径拼上 HA 地址（`haUrl`，去尾斜杠）、把 `state` 时间戳作为 `_t` 参数破浏览器缓存（地图更新后自动换图）；绝对地址（`http(s):` / `data:` / `blob:`）原样用。图片只读、不响应点击、不发服务；加载失败或未绑定显示占位（不破图）。`require` 写 fields 键即可实现「没绑地图实体就不出这一行」。studio 预览侧 `image` 域 mock 用内嵌 SVG 测试图，卡片外观可直接截图核对。

> **`lock`（开机才可操作）**：控件写了 `lock: true` 时，只有它**所属设备开启**才可编辑 / 更改；关机时元素仍渲染、数值仍显示，但引擎把 `_disabled` 置 `true` → 组件给原生 `input` / `select` / `button` **直接加 `disabled` 属性**（不派发 pointer / click / input、不可聚焦、不可键盘操作），`CardEngine.actionOf` 也拒绝发服务。判定走 `env.isOn(设备主实体)` = `HA.deviceIsOn` → 插件顶层 `isOn`，与标题电源开关完全同一口径（如 climate 的 `cool` / `heat` / `auto` 都算开，只有 `off` 算关）；**不要**拿控件自己 `key` 指向的扩展实体（如湿度 `sensor`）去判开态。缺省 `false`，现有插件不写就不受影响。HA 每推一次状态就重算，开机瞬间解锁、关机瞬间禁用。
>
> ⚠ 三条规定：① `lock` 只对带 `action` 的**可写控件**有意义（`label` 渲染成纯 `div`，标了只会灰化）；② **别标在开机入口上** —— 含 `off` 选项的模式组、电源类 `switch` / `bool`，否则设备关了就没有控件能开机（标题电源开关在实例 `click:false` / 插件 `defaultOn:false` 时可能不渲染）；③ 与 `require` 不同：`require` 是缺属性 / 字段没绑就**不渲染**，`lock` 是**渲染但禁用**。

> **`is_on`（开机才显示）**：控件写 `is_on: true` 时，只有它**所属设备开启**（插件顶层 `isOn` 判定为真）才渲染；关机时该控件直接**隐藏**（引擎在 decorate 阶段把节点过滤掉，不是禁用、不占位）。判定走 `env.isOn(设备主实体)`，与 `lock`、标题电源开关、2D/3D 标签**完全同一口径**（如扫地机 `cleaning` / `returning` / `paused` 算开，只有 `docked` / `off` 等算关；复合 `isOn` 会读 fields 绑定）。HA 每推一次状态就重算，开机瞬间出现、关机瞬间消失。缺省 `false`，现有插件不写就不受影响。
>
> ⚠ 与 `lock` 的区别：`lock` 是**渲染但禁用**（灰着让你看到）、`is_on` 是**直接不渲染**（整个控件消失）。因此**别把一张卡的所有控件都标 `is_on`**，否则设备关着时整张卡只剩一个空标题行 —— 至少留一个常显控件（或电源开关本身，它不在 `cards()` 里）。也不适合标在开机入口上（关机时它自己也隐藏，就没人能开机了）。

> **版面模式（宽屏 / 窄屏）**：唯一真相是 Pinia `ui` store 的 `viewportWide`（`web/src/stores/ui.js`），按 `model/stageLayout.js` 的 `WIDE_BREAKPOINT = 1024` 判定，与 CSS `@media` 同源。由 `bridge.js` 的 `installViewportWatcher()` 用 `matchMedia` 统一监听（两个入口自动覆盖，跨断点只触发一次），**控件不要各自加 resize 监听**，也不要自己读 `window.innerWidth` 另算一份 —— 否则跨断点那一帧会出现「页面已放行手势但组件还在点选态」的错位。`PanelApp` 的 `wide`（HUD / 取景 / 手势开关）也是从它映射出来的，不再自持 data。`CardRange` 与 `CardChoice` 都按它分流，**插件侧不需要写任何新字段**（`KEEP` 字段池不变）。

> **`range` 的拖动与提交**：`CardRange` 是**自绘滑块**（`div[role="slider"]` + 轨道 / 填充 / 椭圆把手，不用 `<input type="range">`）—— 原生控件的「点轨道即跳值」是浏览器内置行为，`preventDefault` 跨浏览器不稳且 UA 内部 value 会与 Vue 绑定脱钩。交互规则：
> - **窄屏（手机）**：只有按在把手上（中心 ±20px）才启动拖动；按轨道其它位置完全不响应、不改值，手指滑动照常交给页面手势 —— 防误触的关键；
> - **宽屏（鼠标）**：放开限制，**点轨道任意位置直接定位**，按下即把值跟到手指处、可继续按住拖，松手才发一次 `action`。点一下和按住拖是同一条路径，不会发两次；
> - 拖动中只更新本地 draft（把手、左段填充与右侧数字实时跟随），**不发任何服务请求**；松手 / `pointercancel` 才发一次 `action`；
> - 桌面与触摸**同一套 pointer 逻辑**（`setPointerCapture` + `clientX` 映射，按在把手上时记住抓取偏移，边缘不会跳值）；键盘 `←→↑↓` / `PageUp/Down` / `Home/End` 调值，`keyup` 提交一次；
> - 窄屏 `touch-action:none` 下仍可拖，靠 `PanelApp.onStageTouchStart` 的白名单：只放行「按在把手上」的触摸，其余交回页面手势。白名单只在窄屏执行，宽屏不接管手势。

> **`choice` 的窄屏防误触（滑动选目标）**：`CardChoice` 每个选项都是原生 `button`「点即执行」，即便统一尺度后仍是 30px 高的小胶囊，在手机上容易被蹭到。现在按同一个 `viewportWide` 分流：
> - **宽屏**：保持原来的点即切换，行为零变化；
> - **窄屏**：按住选项组**任意位置**起滑 → 滑到目标选项时显示虚线蓝框预选高亮 → **松手才发一次 `action`**。原地轻点、划出组外、滑回当前项、`pointercancel` 一律零请求；起滑阈值 8px；
> - 选项是 `flex-wrap`，窄屏可能折成两行，命中按各按钮 `getBoundingClientRect()` 做**二维**判定（落在间隙时取中心最近者），不像 `range` 那样按 `clientX` 线性映射；
> - 当前白块右上角有 ⇄ 小箭头作引导（纯装饰不占布局）；键盘触发的 `click`（`detail === 0`）仍保留直点，给外接键盘 / 无障碍留一条路；
> - 组件只在「窄屏 + 可用」时给 `.dc-choice` 挂 `data-slide`，`PanelApp.onStageTouchStart` 命中即整块放行给组件 pointer —— 漏了这步，横向 `touchmove` 会被判成场景横滚并 `preventDefault`，永远滑不动。禁用态 / 宽屏没有该属性，触摸照常交回页面手势。

> **卡片控件尺度（2026-11-14 统一，纯 CSS）**：旧版按钮偏矮（34 / 28 / 25 / 26px），又只有一条浅边叠在白色子卡上，读起来像「细长条」。现在统一到下面这组几何值 —— **只改尺寸 / 字号 / 描边 / 投影，不加副标题、不改模板、不动 DSL 与交互逻辑**：
>
> | 控件 | 高度 | 圆角 | 字号 | 其它 |
> |---|---|---|---|---|
> | `switch` / `bool` 胶囊 `.dc-chip` | 34 → **46px** | 999 → **14px** | 12 → **13.5px** | 状态点 8 → 10px；边框 `#c9d7ea` + 轻投影，开态加深 |
> | `button` 动作按钮 `.dc-btn` | 28 → **36px** | 8 → **10px** | 12 → **13px** | 同款描边 / 投影 |
> | `choice` 分段选项 `.seg-btn` | 25 → **30px** | 7 → **9px** | 12 → **13px** | 槽内边距 3 → 4px、圆角 10 → 12px；字号不再加大，否则 6 个两字选项会折行 |
> | 标题电源胶囊 `.dc-power` | 26 → **32px** | 999 不变 | 12 → **12.5px** | 状态点 8 → 9px |
> | `select` / 静态下拉 | 内边距 4px → **36px 高** | 7 → **10px** | 12 → **13px** | — |
> | 卡头徽标 / 标题 / 子卡名 | 徽标 26 → **30px** | 徽标 8 → **9px** | 图标 13 → **15px**、标题 13.5 → **14.5px**、子卡名 10.5 → **11.5px** / 12.5 → **13.5px** | 预览标签 / 空态 / 读数同步加大 |
>
> `CardRange` 的 20px 轨道与 20×30 椭圆把手**刻意不动**（与 script 的 `PAD=10` / `HIT=20`、CSS `.dc-inner` 内缩绑定），只把标签 / 数值字号同步到 13px。`ha3d-plugin-studio` 的只读展示卡片用同一组几何值（去掉 hover / 点击反馈），改任一处必须同步另一处。代价：窄屏每行多约 12px，首屏少显示 1~2 行；卡片区可滚，容器无需改动。
>
> ⚠ **`switch` 与 `bool` 别混用**：实体 `state` 是 `on/off` 的**次级开关实体**用 `switch`（它读的是 `env.isOn`，发服务不带值）；`attributes` 里的布尔属性（如 `oscillating`）才用 `bool`（读 `attr`、点击发取反后的布尔值）。把 on/off 实体写成 `bool` 会读到 state 字符串、发错参数。

**控件字段池**（任何 `type` 都能带，引擎按 type 各取所需；字段都是可选的，除 `type`。共 18 个字段，与 `web/src/engine/cards.js` 的 `KEEP` 数组一致，其余字段会被丢弃）

| 字段 | 说明 |
|---|---|
| `type` | 上表七种之一；**主电源开关不写进 `cards()`**（标题右侧自动画） |
| `key` | 实体来源：省略或 `'entity'` / `'entityId'` = 主实体；fields 里的 key = 绑定的扩展实体；带点 = 完整 entity_id。解析不到实体的控件会被丢掉 |
| `attr` | **读**路径：写了读 `entity.attributes[attr]`，没写读 `entity.state`。它只是读，HA 没有「写属性」的 API |
| `action` | **写**：HA 服务声明，共 6 种形态（不写 / 裸服务名 / 带域全限定 / `{on,off}` / `{domain,service,param}` / 其它类型被忽略），见下方《`action` 的取值类型》 |
| `param` | `service_data` 的键名；优先级 `node.param` → `action.param` → `attr` → `'value'`。参数名和 attr 不同时必须写，如窗帘 `current_position` → `set_cover_position(position)`；写了 `param` 也会让 `switch` / `button` 变成带值（逃生口） |
| `domain` | 覆盖服务域；**`action` 是带域全限定字符串时本字段被忽略**；对象形态里 `action.domain` 优先于本字段 |
| `data` | 固定附加的 `service_data`，如 `{ transition: 1 }` |
| `label` / `unit` | 显示文案 / 单位。`button` 没写 `label` 时用 `action` 的服务名兜底；引擎**不自动补单位**，要显示就显式写 `unit`（可写 `'attr:unit_of_measurement'` 从实体属性取） |
| `columns` | 占列，见上面的布局规则 |
| `min` / `max` / `step` | `range` 边界。写死即可；也可写 `'attr:min'` / `'attr:max'` / `'attr:step'` 让引擎从实体属性取（典型：`input_number` 倒计时滑块，见下方《`'attr:xxx'`》） |
| `option` / `options` | `select` / `choice` 的选项，共 **4 种写法**（`[{value,label}]` / 纯值数组 / 对象映射 / `'attr:属性名'`），见下方《`option` / `options` 的写法》。`label` **一般不用这个字段**，只有想把枚举状态（`on` / `eco` 这类 state 值）显示成中文时才借用它做映射表，属于少见用法 |
| `require` | 过滤条件，两种口径（先按字段判、再按属性判）：**① 实例字段** —— 写插件 `fields` 的 key（如 `'powerEntity'`），用户绑了才渲染，没绑直接丢掉；**② 实体属性** —— 写属性名（如 `'current_position'`、`'temperature'`），实体没这个属性就不渲染。用来避免「字段没绑 / 实体没这属性」时出一个点不动的假控件 |
| `lock` | `true`：只有所属设备开启时才可操作；关机时仍渲染、仍显示值，但直接给原生元素加 `disabled`。判定与标题电源开关同口径，规则和禁忌见上方《`lock`（开机才可操作）》；缺省 `false` |
| `is_on` | `true`：**只有所属设备开启时才渲染该控件，关机整行隐藏**（不是禁用）。判定与 `lock` / 标题电源开关完全同口径（插件顶层 `isOn`），规则见上方《`is_on`（开机才显示）》。缺省 `false` |

**`'attr:xxx'` —— 配置值不写死，运行时去实体属性取（`min` / `max` / `step` / `unit` / `option` 通用）**

上面几个「读什么、量程多少、单位是什么」的字段都支持两种写法：**写静态值**，或者写 `'attr:属性名'`。以 `'attr:'` 开头的字符串，引擎在 `decorate()` 阶段去**该控件绑定的那个实体**（由 `key` 决定，不是主实体）的 `attributes` 里取同名属性，取到就用、取不到用兜底值。适合「同一份插件配不同实体、各自的量程 / 单位 / 选项还不一样」的场景 —— 插件不用为每个实体改代码。

| 字段 | `'attr:xxx'` 取到的值 | 取不到时的兜底 |
|---|---|---|
| `min` / `max` | 转数字（`toNum`），作为 `range` 的左右端点 | `0` / `100` |
| `step` | 转数字，作为拖动 / 键盘的步长 | `1` |
| `unit` | 原样当显示单位 | 空串（**不显示单位**） |
| `label` | 原样当控件标题 | 静态 `label` 或 `attr` 名 |
| `option` / `options` | 属性里的数组 / 对象映射，再按下方 4 种写法归一化 | 空选项（控件照渲染、没得选） |

典型用法 —— `input_number` 倒计时滑块，量程完全交给 helper 自己定义（HA 的 `input_number` 一定带这三个属性），插件里一个数字都不用写：

```js
cards() {
  return [
    [{ type: 'range', key: 'countdownEntity', label: '倒计时', unit: '分钟',
       min: 'attr:min', max: 'attr:max', step: 'attr:step',   // ← 量程读实体自身的 min/max/step
       action: 'set_value', param: 'value', require: 'countdownEntity' }],
    // 单位同理：不写死 W/V/A，跟着实体的 unit_of_measurement 走（用 kW 的传感器也不会串单位）
    [{ type: 'label', key: 'powerEntity', label: '功率', unit: 'attr:unit_of_measurement', require: 'powerEntity' }],
  ];
}
```

> 三个易错点：① 取的是**控件自己绑定的实体**的属性 —— `key` 指向扩展实体时就去那个 sensor / input_number 上取，不是主实体；② `range` 的**当前值**始终读实体 `state`（数值字符串会被 `toNum` 转成数字），`attr:` 只管量程，不能用来「把某个属性当滑块值」；③ 写 `'attr:xxx'` 但属性不存在时**不会过滤掉控件**（那是 `require` 的职责），控件照渲染、只是用兜底值 —— 想要「没这属性就不出」请同时加 `require: 'xxx'`。

**`option` / `options` 的写法（共 4 种；`select` / `choice` 的常规字段，`label` 少见用法）**

引擎用 `resolveOptions()` 把插件声明归一化成统一的 `[{ value, label }]`，四种写法按需选（已用引擎实跑核对）。
**注意适用对象**：这 4 种写法是给 `select`（下拉）和 `choice`（选项组）声明「可选项」的——这是它们的常规用法；`label`（只读文本）虽然也读同一字段，但用途完全不同：它**不能点选**，只是把实体当前的枚举状态值（如 `'eco'`）翻译成对应中文显示，实际插件里很少这么写，多数 `label` 控件直接显示原始值就够了。

| # | 写法 | 示例 | 说明 |
|---|---|---|---|
| 1 | **对象数组**（最常用） | `[{ value:'eco', label:'节能' }, { value:'boost', label:'强劲' }]` | `value` 是点选后发给 HA 的原始值（**类型保留**，数字 / 布尔不会被转成字符串），`label` 是界面上显示的文案；某项省略 `label` 时回退 `String(value)` |
| 2 | **纯值数组** | `['eco', 'boost']`、`[1, 2, 3]` | 每项既是 `value` 也是 `label`（显示原始值的字符串形式，如数字 `1` 显示成 `'1'`）；值类型同样保留，发服务时原样回传 |
| 3 | **对象映射** | `{ eco:'节能', boost:'强劲' }` | key = `value`、值 = `label` 的静态中文表；注意 JS 对象的 key 一律是字符串，需要数字 / 布尔 `value` 时用 #1 |
| 4 | **`'attr:属性名'`** | `'attr:preset_modes'`、`'attr:hvac_modes'`、`'attr:source_list'` | **不写死，运行时去实体 `attributes` 里取**，取到的数组（或对象映射）再按 #1 / #2 / #3 解析；实体没暴露该属性 → 空选项（控件照渲染但没得选）。适合 HA 自带合法值列表的域（`climate.hvac_modes`、`fan.preset_modes`、`media_player.source_list` 等），同一插件配不同实体也能自适应各自的选项数 |

> **当前值怎么和选项对上（高亮规则）**：比对是 `String(选项value) === String(实体当前值)`，所以实体 state / attr 里的字符串 `'1'` 能和选项里写的数字 `1` 对上高亮；但**点选后发服务回传的是选项里写的原始类型**——#1 写 `value: 1` 就发数字 `1`。要发什么类型，就在选项里写什么类型。
>
> **选哪种**：文案要中文、值是英文 / 编号 → #1；值本身可直接显示 → #2；选项来自 HA 实体自带的合法值列表 → #4；#3 主要用于 `label` 的枚举状态中文映射（少见），也可给 `select` / `choice` 当静态中文表。

**`action` 的取值类型（完整 6 种形态）**

`CardEngine.actionOf(node, { value })` 把控件动作解析成 `{ domain, service, data }`，`data` 已含 `entity_id`，交给 `HA.callService(domain, service, data)`；websocket 侧再拆成 `target` + `service_data`。引擎**不枚举服务名、零 HA 领域知识**，任何域的服务都接受（`PLUGIN-DEV.md` 与 `web/src/engine/cards.js` 头部注释是同一口径）。

| # | 形态 | 写法 | `domain` 来源 | 结果 |
|---|---|---|---|---|
| 1 | 不写 / `null` | 省略 | — | `null`，只读（控件禁用） |
| 2 | 裸服务名（无点） | `'turn_off'` `'toggle'` `'oscillate'` `'set_percentage'` `'set_value'` `'open_cover'` | `node.domain` \|\| `domainOf(eid)`（实体 id 点前部分，`fan.xxx` → `fan`） | `fan.turn_off` |
| 3 | 带域全限定（有点） | `'homeassistant.update_entity'` `'homeassistant.toggle'` `'fan.set_percentage'` | 按**第一个 `.`** 拆成 domain / service；`node.domain` 被忽略 | `homeassistant.update_entity` |
| 4 | 对象按态选 | `{ on:'turn_on', off:'turn_off' }` | 同 #2 | `node._on` 为真 → `off`，为假 → `on` |
| 5 | 对象全显式 | `{ service:'set_percentage', domain:'fan', param:'percentage' }` | `action.domain` \|\| `node.domain` \|\| `domainOf(eid)` | `service` **原样发出，不拆点号** |
| 6 | 其它类型 | number / array / function | — | `null`，静默不动作 |

> 服务名不是只能 `turn_on` / `toggle`：`set_value`、`set_percentage`、`open_cover`、`set_temperature`、`volume_set`、`homeassistant.update_entity` 等任意服务都行。

**带值规则**：`switch` / `button` 是一次性动作，`data` 只有 `entity_id`；`range` / `select` / `choice` / `bool`，或显式写了 `node.param` 的任意 type，才把值写进 `service_data`（键名优先级见上表 `param`）。`bool` 点击自动取反（`true → false`），`range` 转 number，值为 `null` / `''` 时整个动作不发。`key` 决定 `data.entity_id`：省略 / `'entity'` / `'entityId'` = 主实体，`fields` 的 key = 绑定的扩展实体，带点 = 完整 entity_id；**解析不到实体的控件在 `normalizeNode()` 阶段直接被丢弃**，不是运行时报错。`data` 里的固定参数与 `entity_id` 合并。

**易错点**：

- 对象形态**不拆点号**：`{ service:'homeassistant.update_entity' }` 会发出 `fan.homeassistant.update_entity`。带域服务要么写全限定字符串，要么写 `{ domain:'homeassistant', service:'update_entity' }`。
- `{on, off}` **必须成对**：只写 `on`，设备处于开态时 `off` 为 `undefined` → 返回 `null`，点了没反应也不报错。
- 带域全限定字符串会**忽略**控件级 `domain`（实测加 `domain:'fan'` 仍是 `homeassistant`）。
- `switch` / `button` 不带值，别指望靠 `attr` 传参；要传值必须显式写 `node.param`（只写 `action.param` 对这两种 type 不生效，因为带值判定看的是 `node.param`）。
- `set_value` 这类写的是实体 **state**，参数键必须显式写 `param: 'value'`。
- 实体 `unavailable` / `unknown` → `actionOf` 返回 `null`，点不动是预期行为。

引擎只做四件事：`type` → 组件、`action` → `call_service`、`key`/`attr` → 读值、`columns` → 排版。**所有 HA 领域知识（域名、服务名、参数名、中文选项）都由插件声明**，引擎里没有任何域映射表。服务调用统一是 `HA.callService(domain, service, data)`，`data.entity_id` 由引擎填；websocket 侧会自动拆成 `target` + `service_data`。

**标题电源开关（不在 `cards()` 里声明）**：开 / 关 这样的电源（主）开关**统一画在设备标题的右侧**，不写在 `cards()` 中 —— 房间/全屋里画在每个设备子卡的标题右侧，单设备选中时画在整卡总标题右侧。它**完全复用插件自身的 `isOn` 与 `click`**：开/关状态走 `HA.deviceIsOn`（= 插件顶层 `isOn`），点击走 `HA.toggle`（= `PluginEngine.clickSpec` 取的插件 `click` → `HA.callService`）。胶囊里显示「开 / 关」文字、右侧一个滑动圆点；插件没声明 `click`（也无内置默认）就不画开关。所以 `cards()` 里**不要**再放一个 `type:'switch'` 的电源开关，否则会和标题开关重复。次级控制（模式 / 温度 / 亮度 / 风速 / 摆头 / 音量等）照常写在 `cards()`。

**标题右侧的电源开关只在「卡片组（二维数组）」形态下出现**：上面说的「设备标题右侧开关」指 **全屋 / 房间视图里每个设备自己的子卡标题**——它**只有当该设备的 `cards()` 返回二维数组（卡片组）时才存在**：设备因此出一张带标题的完整子卡，`CardDevices` 在子卡标题右侧画开关（单设备选中时则画在整卡总标题右侧）。如果一个设备返回的是**单个元素**（含「没写 `cards()` 时引擎兜底的那张单元素 switch 卡」），它不会单独成卡，而是和其它设备的单元素聚合成**无标题的网格平铺块**，开关/布尔控件以胶囊形式内联（胶囊上已显示设备名）——**没有子卡标题，自然也没有「标题右侧的电源开关」**。简言之：想让某设备在全屋/房间视图里露出「标题 + 标题右侧开关」的独立子卡，就给它返回二维数组；只想让它作为一个内联开关平铺，返回单个元素即可。

**控件全被过滤 → 退回默认单开关卡**：`cards()` 的每个控件都可能因为 `key` 解析不到实体（对应 `fields` 字段没绑）或 `require` 不满足而被丢掉。如果**过滤完一个元素都不剩**（典型场景：`switch` 插件一个扩展实体都没绑），引擎**不会**给一张空白子卡，而是按「单元素」处理 —— 直接退回「没写 `cards()`」时的那张**默认兜底单开关卡**（`_defaultToggle`，点击仍走插件 `click` / `isOn`，在全屋 / 房间视图里就是一颗内联胶囊开关）。只有不可点击的纯展示类型才保留「标题独卡」。所以给字段做卡片时，放心把每个控件都标上 `require: '<字段key>'`，不必自己判空。

```js
cards() {
  return [
    // 电源开关不在 cards() 里：它自动出现在设备标题右侧（复用插件 isOn/click）
    // columns 全部省略：一行 1 个自动占满 4 列，一行 2 个自动各占 2 列
    [{ type: 'range', attr: 'percentage', action: 'set_percentage', param: 'percentage',
       label: '风速', min: 0, max: 100, step: 1, unit: '%', require: 'percentage' }],
    [
      // bool 读 attributes.oscillating，点击发取反后的布尔值
      { type: 'bool', attr: 'oscillating', action: 'oscillate', param: 'oscillating',
        label: '摆头', require: 'oscillating' },
      // button 只发服务不带值；没写 key → 刷的是主实体，刷扩展实体要写 key:'tempEntity'
      { type: 'button', label: '刷新读数', action: 'homeassistant.update_entity' },
    ],
    // choice（选项组）：select 的按钮组形态，attr/option/action/param 语义与 select 完全一致，
    // 点哪个选项就把哪个值带上发服务（选项来自实体属性时写 'attr:xxx'）
    [{ type: 'choice', attr: 'preset_mode', action: 'set_preset_mode', label: '模式',
       options: 'attr:preset_modes', require: 'preset_modes' }],
    // 次级 on/off 实体用 switch（主电源开关不要写进 cards()）：
    // { type: 'switch', key: 'auxSwitch', label: '辅助开关',
    //   action: { on: 'turn_on', off: 'turn_off' } },
  ];
}
```

注意事项：

- **`label` 与 `button` 职责固定、一一对应组件**：`label` → `CardReadonly`（只显示读数，写 `action` 也不会变成按钮），`button` → `CardButton`（只发一次性服务，不显示读数）。引擎 `componentOf` 只查表，不再按 `action` 隐式改派。**这是破坏性变更**：旧写法 `{ type:'label', action:'…' }` 不会再是按钮，必须改成 `type:'button'`（内置 `cover` 已迁移，外部插件请同步）；`button` 没写 `action` 时按钮禁用，与 `switch` / `bool` 一致。
- **三条书写惯例**：① `columns` 默认省略，只有一行多个且不等分才写；② 实体 `state` 为 on/off 的次级开关用 `switch`，`attributes` 里的布尔属性才用 `bool`，主电源开关不写进 `cards()`；③ 纯显示用 `label`、一次性动作用 `button`，两者不互相兼职。
- **`choice` 与 `select` 怎么选**：两者契约完全一样（读 `attr`、`option`/`options`、`action` 带值），只差 UI——`choice` 是并排选项按钮（一眼看到全部选项、宽屏一次点击即切换（窄屏改成按住滑动选择，见上方说明），适合 2~4 个短选项，如模式 / 档位 / 摆头方向）；`select` 是下拉（选项多、文案长、格子窄时用，如 `hvac_modes`、`source_list`）。选项超过 4~5 个或单个文案较长时优先 `select`，避免按钮组折行把卡片撑高。
- `cards()` 里**不写实体 id**（用 `key` 指向主实体 / fields 键 / 完整 entity_id），不要在控件里内联 HA 域名或服务参数表；所有领域知识留在插件声明里。
- `bool` 发出去的是真正的布尔值；`select` 用纯值数组时也是原始类型，不会被转成字符串。
- HA 的 `call_service` 只返回成功，新状态靠实体订阅回推（约 0.3~1s），滑块组件已做本地 draft：**拖动中只改本地显示、不发服务，松手才发一次 `action`**（自绘滑块，不再有原生 `change`）；发出后 1.2s 内 draft 优先，避免回推把值弹回旧值。
- 卡片标题（设备名）由容器层取实体的 `friendly_name`，`cards()` 不用管。
- `plugin.js` 改过必须同步升 `plugin.json` 的 `version`（`?v=` 长缓存）。
- 内置 10 个插件（fan / climate / cover / sensor / camera / vacuum / water_heater / speaker / door / window）的 `cards()` 可直接抄；light 与 switch 刻意不写（走引擎兜底的单开关卡，足够用），`wardrobe`（家具无实体）与 `background`（背景插件）也不写。

### 2.9.1 3D 场景点击语义（页面层，插件不用管）

两个 3D 展示页 —— 展示页 `PanelApp`（PC / 手机 / 平板统一）与编辑页 3D 展示 `EditApp` —— 共用 `model/pick.js` 的 `applySceneMode()`，**标签显隐就是点击语义本身**：

| 标签 | 点设备模型 | 点设备标签 | 点空白 |
|---|---|---|---|
| **显示** | 只选中 / 切换卡片（`onPick` 装载） | 执行动作（`HA.toggle` → 插件 `click`） | 清空选中 / 回全屋 |
| **隐藏** | 直接执行动作（引擎 `toggleDevice`） | 标签 `display:none`，点不到 | 无动作 |

- 两个开关由 `applySceneMode()` **一次拨完**（`setLabelsVisible` + `onPick`）：页面只决定「标签该不该显示」，不要再单独决定点选行为，否则会出现「标签显示却点设备执行」「标签隐藏却点设备出卡、没有执行入口」的错位。
- 🃏「卡片」开关只管卡片面板 / 预览浮层的显隐（`PREF_KEYS.displayCards` / `editorCards`），**不再影响点击行为**；关着时点设备仍会更新选中态，再打开就能看到。
- 唯一特例：展示页窄屏（< 1024px，含 HA App 的 WebView）强制不显示标签，于是按上表自然落到「点设备 = 执行」；顶栏的标签开关在窄屏也隐藏。
- 标签能否点、点下去发什么服务，仍由插件 `click` 规格与实例属性面板的「启用点击」决定（见 2.3），与页面模式无关。

## 3. 门 / 窗（`type: 'door'` / `'window'` 的贴墙设备）

> **门和窗不是另一类插件**，就是 `kind: 'device'`、`type` 为 `'door'` / `'window'` 的模型插件。注册契约（`styles` / `fields` / `click` / `stateText` / `plan2d` / `isOn` / `labels` / `model3d`）与设备**一字不差**，引擎内部也走同一条建造路径（`buildDevice`）、同一张拾取表（`pickGroups`）、同一个点击入口（`toggleDevice`）、同一条开合判定链（`HA.deviceIsOn`）。所以本节只讲**门窗与普通设备不一样的那几点**，其余全部照第 2 章写。

### 3.1 与设备的差异（只有这几条）

| | 设备 | 门 / 窗 |
|---|---|---|
| `kind` | `'device'` | `'device'`（**一样**） |
| `type` | HA 实体类型（`light` / `switch` / `fan`…） | `'door'` / `'window'` |
| 数据存放 | `floors[].devices[]` | `floors[].doors[]` / `floors[].windows[]`（**没有和 devices 合并**） |
| 主实体 | `obj.entityId`（属性面板「设备绑定」） | **一样**：`obj.entityId` 走「设备绑定」；门磁这类只读传感器也可放 `fields`（内置门插件本次主实体留空） |
| 位置 | 自由摆放，`obj.z` 可调离地高度 | 贴在墙上（`obj.x/y` + `obj.rot`（度）跟随墙体），墙上自动掏洞 |
| 离地高度 | `obj.z ?? 造型 z ?? 1.2` | **门恒为 0，不可调**；窗 `obj.z ?? 0` 可调（模型自带 0.9m 窗台，`z` 是整体抬升） |
| 标签 | 缺省显示，锚点 `0.3m` | **缺省不显示**（`labels` 缺省 `false`），要显示写 `labels: true`；锚点高度由插件声明（door `labelBaseY: 1.05` / window `1.45`） |
| `click` | 不写也有内置语义（toggle 主实体） | **没有任何内置默认**，要点击开关必须自己声明 `click.on` / `click.off` |
| `plan2d` | 画在设备锚点 | 画在洞口中心，画布已旋转到墙方向 |

> **墙体掏洞是引擎的事，跟插件无关**：引擎 `buildWall` 时按 `floors.doors` / `floors.windows` 的位置与 `w` 在墙上开洞，插件只负责洞口里那扇门/窗长什么样、怎么开合。所以把门窗插件写坏（甚至报错）也不会把墙挖漏——最差是洞口空着。
> **门窗的多造型与设备完全同一套机制**：`register` 里声明 `styles`，引擎聚合时加 `<插件id>:` 前缀，用户选中后写入 `obj.style`，`model3d(ctx)` 读 `ctx.style.id` 决定画哪种；没选过就走 `styles[0]`（老数据自动落到第一项，不会坏）。

> **`type` 是唯一的分组键**：设备的 `type` 是实体类型，门窗的 `type` 是 `'door'` / `'window'`。所以「一个类型由多个插件共同提供造型」就是**多个插件写同一个 `type`**：内置 `door`（`type:'door'`）与 `custom/plugins/door_rolling`（同样 `type:'door'`）的 `styles` 自动合并进同一个门样式下拉。拆出去的插件自带 `model3d` / `plan2d` / `isOn` / `click`，互不干扰——现成例子：`door_rolling`（卷帘门）、`window_fixed`（固定窗）。

### 3.2 `obj` 字段（门窗实例数据）

| 字段 | 说明 |
|---|---|
| `x` / `y` | 洞口中心的平面坐标（引擎已应用） |
| `rot` | 沿墙方向（度，引擎已应用） |
| `w` | 洞口宽度（米），门框/窗框要按它自适应 |
| `swing` | 可选字段：未绑门磁时 **3D** 门扇的静态开角（rad，缺省 1.1）。旧实例可能没有这个字段，读的时候写 `obj.swing != null ? obj.swing : 1.1` |
| `style` | 用户选中的样式，形如 `'door:double'` / `'door_rolling:rolling'`；**可能不存在**，缺省 = 该 `type` 的 `styles[0]` |
| `styleOpts` | 该实例的样式参数取值（如 `{ hand:'right', open:'in' }`），插件读 `ctx.options` / `p.options` 即可 |
| `z` | **仅窗有**：整体离地抬升（米，`0` 起，属性面板可调）。门恒为 `0`，读到的永远是 `undefined` 或 `0` |
| `labelOffset` | 可选：该实例的标签高度覆盖（缺省由插件 `def.labelOffset` 声明：门 `1.05` / 窗 `1.45`），属性面板「标签高度」写入 |
| `entityId` | 主实体（属性面板「设备绑定」写入，**可以留空**；内置门插件本次就留空） |
| `contactEntityId` | 门插件扩展字段：门磁 / 接触传感器（`fields` 声明，on/open = 门开） |
| `posEntityId` | 扩展字段：开度实体（门 / 窗都有，`fields` 声明） |

### 3.2.1 门窗多造型（单开 / 双开 / 卷帘）

内置插件只按自己的造型画，样式多了就拆到独立插件——两个插件写同一个 `type`，样式自动合并成一个下拉（内置 `door` + `custom/plugins/door_rolling` 就是这套现成组合）：

```js
// ① 内置插件：id 与 type 同名
PluginEngine.register({
  id: 'door', kind: 'device', type: 'door', name: '门',
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
  id: 'door_rolling', kind: 'device', type: 'door', name: '卷帘门',
  styles: [{ id: 'rolling', name: '卷帘门', desc: '帘片向上卷入门洞上方卷轴箱' }],
  click: { on: 'open_cover', off: 'close_cover', domain: 'cover' },   // 门窗的 click 必须自己写
  plan2d(c, p) { /* 自己的平面符号：虚线开口 */ },
  isOn(obj, get) { /* 自己的判定：门磁 on = 卷起 */ },
  async model3d(ctx) { return buildRolling(ctx); },
});
```

要点：

- `styles[].id` 只用插件内部名字，引擎会加 `'<插件id>:'` 前缀；`ctx.style.id` 拿到的是**去掉前缀**的内部 id
- **跨插件合并靠 `type`**：门窗的 `type` 是 `'door'` / `'window'`，同 `type` 的插件各画各的造型，`model3d` / `plan2d` / `click` / `isOn` / `fields` / `labels` 都取样式所属插件那一份（`PluginEngine.defFor(type, styleId)`），互不影响；所以各插件的 `fields` 数量可以不同（如 `window` 两个、`window_fixed` 零个），属性面板的实体绑定区随样式切换。设备侧同一套规则。漏写 `type` 的插件注册时会在控制台告警
- 选中拆出来的样式时，`obj.style` 存的是带前缀的全名（`'door_rolling:rolling'`）；插件代码里永远只见到内部 id
- 门窗 `styles[].z` **对门无效**（门恒落地）；窗可写 `z` 作为缺省抬升（一般留空，让用户在面板里调 `obj.z`）；`icon` 支持内联 SVG 字符串（`v-html` 渲染）
- 门窗样式同样支持 `options`（单开门再分左/右开、内/外开…），写法与设备一致，见 2.2.1：3D 里读 `ctx.options`、2D 里读 `p.options`
- 属性面板的样式区按**聚合后的总数**判断：门窗只要有 2 个以上（含其他插件贡献的）就显示样式按钮
- 门窗**缺省不显示 3D 标签**：`labels` 不写就是 `false`（注册时定死，见 `PluginEngine.wantsLabel`）；确实想要标签（比如想在门边一直显示「已打开」）就写 `labels: true`
- **插件文件要包一层 IIFE**：多个 `plugin.js` 是各自独立的 `<script>`，顶层 `const` 共享全局作用域，重名会整文件 SyntaxError（见内置 `door`/`window` 与 `custom/plugins/*` 的写法）

### 3.2.2 自定义 2D 平面符号 `plan2d(c, p)`

3D 造型和 2D 平面图符号是两件事：`model3d(ctx)` 画三维，`plan2d(c, p)` 画平面图上的符号。**不写 `plan2d` 也能用**，编辑器会画一个通用「洞口矩形 + 中缝线」兜底；写了就完全由插件决定这一造型在平面图里长什么样（推拉画中梃、对开画两道开启弧、卷帘画虚线…）。

```js
PluginEngine.register({
  id: 'door', kind: 'device', type: 'door', name: '门',
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
| `entityId` | 主实体 id（「设备绑定」写入；未绑定时是 `undefined`，门插件本次就是） |
| `state` | 主实体的状态对象（HA 原样或 `null`） |
| `obj` | 门窗放置数据本体 —— 扩展实体字段在上面（门 `obj.contactEntityId` 门磁 / `obj.posEntityId` 开度，窗 `obj.posEntityId` 开度） |
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

### 3.2.3 开 / 合判定 `isOn(obj, get)` 与判定链

门窗的打开逻辑往往不止看一个实体（窗 = 开关实体 + 开度实体），所以在 register 顶层声明自己的判定函数：

```js
PluginEngine.register({
  id: 'window', kind: 'device', type: 'window', name: '窗户',
  // 主实体（开关 / 窗磁 / 智能窗）走属性面板「设备绑定」→ obj.entityId，不写进 fields
  fields: [
    { key: 'posEntityId', label: '开度实体', domains: ['sensor'] },
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
- **返回 `null` / `undefined` = 「我不判定」**，引擎继续往下兜底；返回 `true/false` 就是最终结论
- **唯一判定入口 `HA.deviceIsOn({entityId, type, style})`**（2D 底色、3D 标签高亮、统计、点击方向全用它）：
  1. 插件顶层 `isOn(obj, get)` —— 本节这个，设备与门窗共用
  2. `HA.isOn(eid)` 默认规则 —— 主实体 `on`/`open` 即开，未绑定视为关（与 3D 常闭一致）
  只有实体 id、没有实例的场景（实体列表、大屏快捷设备）用 `HA.entityIsOn(eid, type)`，它会合成 `{entityId, type}` 再问插件。
- **不要再用 `click.isOn`**：已删除。判定和「点下去发什么服务」是两件事，混在 click 里会导致 2D/3D/点击方向三套结论
- 判定结果传给 `plan2d` 的 `p.on` / `p.fill`（开=暖琥珀），插件自己不用再读状态上色
- 门窗**可以**声明 `click`（不像旧版那样只能被动显示）：不写就没有点击控制，写了才响应点击，见 2.3

注意事项：

- 画布已经 `translate` 到洞口中心并 `rotate` 到墙方向，**不要再自己做位移/旋转**，坐标就用 `-L/2 ~ +L/2`
- 每次重绘都会被调用，保持轻量：只画线，别在 `plan2d` 里加载图片或发请求
- 造型 id 与 `styles[].id` 对应；不在 `styles` 里声明过的样式不会走到这里
- `styles[].plugin` 指向别的插件时，用的是**那个插件**的 `plan2d`（样式提供者决定符号）
- 内置 `door`（单开/双开）、`window`（推拉/对开）与自定义 `door_rolling`（卷帘）、`window_fixed`（固定窗）都实现了 `plan2d`，可直接参考

### 3.3 坐标系

`group` 原点 = **洞口地面中心**（门）或**洞口地面中心 + `obj.z`**（窗，`z` 由属性面板「离地高度」给）：

- `+X` 沿洞口宽度方向（左右）
- `+Y` 向上（门扇高度从 `0` 到 `h`）
- `+Z` 垂直墙面（朝室内）

所以门框画在 `y = h/2`，门扇挂在 `x = -w/2` 的铰链组上；窗户是窗台以上一段，**本地坐标固定从 `0.9` 起**（窗台高度写死在模型里），整体抬升由引擎的 `obj.z` 负责——插件不要自己去加 `obj.z`。

> 洞高由引擎写死：门洞 `0 ~ 2.05m`，窗洞 `0.9+z ~ 2.1+z`（超墙高自动钳到墙高）。所以门模型高度取 `2.06` 左右（比洞高一点点，靠门套盖住缝），窗模型就画 `0.9 ~ 2.1` 这一段的窗框+玻璃。

### 3.4 完整示例：一扇会开的门

```js
// custom/plugins/mydoor/plugin.js
PluginEngine.register({
  id: 'mydoor',                    // 任意唯一 id；靠 type 归 'door'（只有同 id 才覆盖内置）
  kind: 'device',                  // 与设备同一个 kind
  type: 'door',                    // ✅ 'door' / 'window'，漏写样式聚合不到面板
  name: '我的门',
  // 主实体走属性面板「设备绑定」（本次留空）；门磁这类只读传感器放 fields
  fields: [
    { key: 'contactEntityId', label: '门磁传感器', placeholder: 'binary_sensor.xxx' },
  ],

  model3d(ctx) {
    const T = ctx.THREE;
    const W = ctx.obj.w || 0.9;
    const H = 2.06;                    // 门洞高 2.05（引擎写死），门扇略高 1cm 盖住缝
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

1. **漏写 `type` 就在面板里看不到**：门窗的 `type` 是 `'door'` / `'window'`（不是实体类型），漏写控制台会 warn、`styles` 聚合不到样式下拉；`id` 随便取，只有与内置同名才覆盖内置插件。
2. **必须按 `obj.w` 自适应**：同一个门插件要服务 0.8m 卫生间门和 1.2m 入户门，写死宽度会穿墙。
3. **高度别自己加 `obj.z`**：`obj.z` 由引擎作用在整组上（窗才有意义，门恒 0），插件本地坐标门画 `0~2.06`、窗画 `0.9~2.1` 即可；自己再加一次会double。
4. **旋转单位是度（°）**：门/窗与设备的 `obj.rot` 已全链统一存「度」（旧弧度数据由读档迁移自动转换）。插件不用管（引擎统一换算），但自己算朝向时别再乘 `π/180`。
5. **不要在 `model3d` 里 `await` 后再读 `ctx.obj` 的旧值**：`obj` 是引用，但场景可能已重建，引擎会丢弃过期实例；重活放 `update()`。
6. **动画只用一个 `animate`**：门扇和把手如果都要动，合并进同一个 `fn(dt)`。

---

## 4. `background` 插件（地面背景）

### 4.1 注册对象

背景插件不实现 `model3d`，改为声明 `styles[]`——每个条目就是面板里的一个背景选项。`update` 必须写在 `apply` 的返回值里（写在条目上引擎不读）；**`refresh` 声明在条目上（`styles[].refresh`），最好不要写在返回值里** —— 引擎读返回值的 `refresh` 优先于条目声明，写在返回值里会**强制覆盖**条目配置，一旦写死就无法再从条目 / UI 层调整刷新率。

```js
PluginEngine.register({
  id: 'mybg',
  kind: 'background',
  name: '我的背景',            // 面板分组标题固定取插件 name
  // 可选：动态实体字段 + 数据回调（写在注册对象顶层，不是 styles 里；完整契约见 4.9）
  // fields: [{ key: 'weather', label: '天气', domains: ['weather'] }],
  // onData(fields, api) { /* 用 api.overlayGroup 画太阳 / 雨，实体状态变了自动更新 */ },
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
          // update(t, api) { … },           // 可选：动态背景的定时回调
          // ⚠ 不建议在返回值里写 refresh —— 会强制覆盖条目上的刷新率，无法再从条目/UI 层调整；
          //   刷新率统一声明在条目的 styles[].refresh 上
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
| `ctx.plane(src, sizeM?, hole?)` | 函数 | **地面网格工厂**：传入 canvas 或 THREE.Texture，返回贴好图的 120m 平面网格（已摆正 / **中心对准背景中心** / 防闪面），`add` 进 group 即用；`sizeM` 可选自定义尺寸（米）。`houseY < 0`（低洼）时整张地面会横穿房屋，可传第三个参数 `hole = { x0, x1, z0, z1 }`（背景坐标系，米）挖一个矩形洞，引擎用「回」字形四块平面拼出带洞地面、四块共享同一张贴图按整图 UV 取样；挖不挖洞、坑壁画什么都由插件决定 |
| `ctx.planeSize` | number | 默认平面边长（米），≥120；偏移把房子推到边缘时会自动放大。画布 ↔ 米 换算用得上 |
| `ctx.house` | object | 背景坐标系里的房屋包围盒，见 4.4（含 `y` / `h` / `topY` 高度信息） |
| `ctx.safe` | object | 安全边界（禁放区 + 可布置范围 + 高度信息），坐标系同上，见 4.4 |
| `ctx.options` | object | 用户参数值，**已合并默认值**，直接 `ctx.options.houseY` |
| `ctx.houseY` | number | 与 `ctx.options.houseY` / `ctx.house.y` 同一个值（米），插件随手可取 |
| `ctx.refresh` | number | 声明的刷新率（Hz），只读参考 |

### 4.4 `house` 与 `safe`

> **坐标系**：原点 = **背景中心**（= `ctx.plane()` 平面中心、= 画布中心），不是房屋中心。
> 房屋可以通过样式参数 `offsetX / offsetZ` 偏离背景中心，所以 `house.cx / cy` 就是那个偏移量
> （0 / 0 = 房屋正落在画面中心）。`safe` 与 `house` 同一套坐标，已含偏移。

`house` 是**当前楼层**墙体的包围盒（该层没画墙时回退全屋并集，米）：

| 字段 | 含义 |
|---|---|
| `minX` / `maxX` | 西 / 东墙边（背景坐标系里 x 的最小 / 最大值） |
| `minY` / `maxY` | 北 / 南墙边（背景坐标系里 **z** 的最小 / 最大值，名字沿用编辑器 y） |
| `w` / `d` | 东西宽 / 南北深 |
| `cx` / `cy` | 房屋中心在背景坐标系里的位置 = 偏移量（米） |
| `floors` | 有墙的楼层数 |
| `y` | **房屋地板高度** = 样式参数 `houseY`（米，可为负）；插件画脚下平台用它 |
| `h` | **房屋实体高度**（米）：home 取当前楼层层高，studio 取预览的「房屋高度」 |
| `topY` | 屋顶高度 = `y + h` |
| `hash` | 尺寸指纹（`minX/maxX/minY/maxY`）。变了引擎会自动重放背景；也可以当随机种子（`const K = PluginEngine.bgKit; K.rand(K.seed(house.hash))`），保证同一栋房子草的位置一致 |

> `y / h / topY` 只是**数据**，不改变任何水平方向的字段或判定。

**重放时机（引擎负责，插件不要自己通知）**：切换楼层、拖墙改包围盒、改层高、切换背景、改样式参数都会重新执行一次 `apply(ctx)` 并换掉整个 `group`。引擎用一份「构图指纹」判定是否需要重放：

```text
楼层号 | house.hash | house.h | 背景样式 id | offsetX | offsetZ | houseY
```

切层是**立即重放**（背景必须跟着当前楼层重新构图，否则房屋会画到上一层的平台外面，哪怕两层户型完全一样）；同一层内改墙 / 改层高 / 改参数走 160ms 防抖。**指纹只在重放成功后才提交**：插件尚未加载完、`apply()` 抛错或没返回 `group` 时引擎会清空背景并保留旧指纹，随后每 300ms 自动重试（最多 3 次），下一次重建也会补试 —— 不会出现「背景空白后再也画不回来」。非 `build` 触发的绘制入口（切换背景、调参数、页面初始化）会先取消挂起的防抖/重试重放并对准当前楼层的 `house`，避免双重建销或按默认 8×8 户型错画。因此：

- 平台、山体、庭院、撒点等**任何按房屋尺寸摆的几何体都要在 `apply()` 里现算**（读 `house.w / d / minX…`），不要写死 15×15 这种常量，也不要把 `house` 缓存到模块级变量；
- `apply()` 每次拿到的都是全新 `ctx` / `group`，`onData` 的 `overlayGroup` 也随 `group` 一起重建，别跨回调缓存 mesh 引用。

`safe`（房屋外扩形成的禁放走廊，坐标同 `house`）：

| 字段 | 含义 |
|---|---|
| `inner` | 禁放走廊宽度，固定 `1.5` 米 |
| `x0` / `x1` / `y0` / `y1` | 禁放矩形（已含 inner 外扩） |
| `forbidden(x, z)` | 是否落在禁放区（房屋占地 + 走廊） |
| `houseY` / `baseY` | **高度信息**：房屋地板高度（= `house.y`，米，可为负） |
| `houseH` | **高度信息**：房屋实体高度（米） |
| `topY` | **高度信息**：屋顶高度 = `houseY + houseH` |

> **safe 只管「别压到房子」，外界自己钳**：引擎不提供外圈半径 / `allowed`（旧版「距房屋中心 45m 圆」已删 —— 它与地面矩形脱节，房屋偏移大时会伸出地面、平面放大时又偏小）。撒点 / 落点的可布置边界 = `!forbidden(x, z)` **且** 在地面矩形内：`const half = ctx.planeSize / 2 - 4; if (Math.abs(x) > half || Math.abs(z) > half) continue;`。`planeSize` 随房屋偏移自适应放大（至少 120m），用它当边界永不越界。
>
> **水平方向一字未动**：`forbidden(x, z)` 仍是原来的两参 2D 判定，`inner / x0 / x1 / y0 / y1` 含义不变（`y0/y1` 里的 y 是平面坐标 = 3D 的 z，不是高度）。高度字段只是**给插件判断用的数值**，引擎不据此改变禁放行为。
> 房屋悬空时想在房子底下画支撑柱 / 洞穴 / 云，插件自己比较 `y < safe.houseY` 并主动避开 `forbidden(x, z)`（它仍会把房屋的水平投影判为禁放）——**画什么、怎么画完全交给插件**：

```js
const H = ctx.options.houseY || 0;
if (H > 0) {
  // 房屋悬空：在占地四角画支撑柱，从 y=0 一直到 y=H
  [[ctx.house.minX, ctx.house.minY], /* …另三个角… */].forEach(([x, z]) => {
    const p = new ctx.THREE.Mesh(
      new ctx.THREE.CylinderGeometry(0.4, 0.5, H, 8),
      new ctx.THREE.MeshLambertMaterial({ color: 0x8a7a66 })
    );
    p.position.set(x, H / 2, z);
    g.add(p);
  });
}
if (H < 0) {
  // 房屋在下沉庭院：地面挖洞，自己补坑壁与坑底（房子地板在 y=H）
  g.add(ctx.plane(cv, null, {
    x0: ctx.house.minX - 1.5, x1: ctx.house.maxX + 1.5,
    z0: ctx.house.minY - 1.5, z1: ctx.house.maxY + 1.5,
  }));
}
```

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
| `refresh` | number | ⚠ **不建议用**：会强制覆盖条目上的刷新率（引擎读返回值优先），且无法再从条目 / UI 层调整；刷新率统一写在 `styles[].refresh` |
| `update` | `(t, api) => void` | 动态背景的定时回调（按 `refresh` 的 Hz 节流，`api` = `{ group, mesh, size }`）；改了贴图自己标脏 `tex.needsUpdate = true` |
| `houseY` | number | **仅兜底**：样式完全没声明 `houseY` 参数时，用它抬升房屋并回填 `ctx` / `house` / `safe` 的高度数值。只要声明了参数就以参数为准 —— `ctx` 在 `apply` 之前构造，返回值不能反过来覆盖用户滑杆；想让高度可调、且 `apply` 里能读到，请务必写进 `options` |

> **立体背景示例（山顶平台）**：`houseY` 的默认高度由样式参数声明，插件按同一个值画平台；
> 背景 group 的 `y` 恒为 0，山脚 / 河流 / 稻田留在基准面，房屋由引擎抬到 `y = H` 站在平台上。
> ⚠ **所有水平面都要留间隙**：地面 `−0.05` → 山体顶面 `H − 2G` → 平台顶面 `H − G` → 房屋地板 `H`，
> `G = 0.25m`。让平台顶面和房屋地板落在同一个 `H` 是最常见的翻车原因：两个共面平面会整片条纹闪烁。

```js
{ id: 'hill', name: '山顶平台', icon: '⛰',
  options: [...PluginEngine.bgKit.positionOpts(30, 6)],   // houseY 默认 6 米
  apply(ctx) {
    const T = ctx.THREE, h = ctx.house, H = ctx.options.houseY || 0;
    const G = 0.25;                                       // 水平面最小间隙（米）
    const g = new T.Group();
    g.add(ctx.plane(myGroundCanvas));                     // 山脚地面（y=-0.05）
    const mountTop = Math.max(0.5, H - 2 * G);
    const m = new T.Mesh(
      new T.CylinderGeometry(11, 18, mountTop, 4),
      new T.MeshLambertMaterial({ color: 0x7f9a5b })
    );
    m.rotation.y = Math.PI / 4;
    m.position.set(h.cx, mountTop / 2, h.cy);             // 山体顶面 = H - 2G
    g.add(m);
    const platformTop = H - G;                            // 平台顶面 = H - G
    const top = new T.Mesh(new T.BoxGeometry(15, 0.3, 15),
      new T.MeshLambertMaterial({ color: 0x9bb87a }));
    top.position.set(h.cx, platformTop - 0.15, h.cy);    // 底面嵌进山体，不与山体顶面共面
    g.add(top);
    return { group: g };
  } },
```

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

三个位置保留键可以直接用工具函数生成（见 2.2.1）：

```js
options: [
  ...PluginEngine.bgKit.positionOpts(30, 6),   // offsetX / offsetZ / houseY(默认 6)
  { key: 'clumps', label: '草丛数量', type: 'range', min: 0, max: 160, step: 10, def: 70 },
]
```

改 `houseY` 会立刻重放背景并挪动整栋房屋（90ms 防抖），**不重建户型**；相机与旋转锚点同步跟随，已经调好的取景不会跳。

```js
options: [
  { key: 'repeat', label: '颗粒密度', type: 'range', min: 8, max: 40, step: 2, def: 20 },
  { key: 'speed',  label: '流速',     type: 'range', min: 0, max: 3,  step: 0.1, def: 1 },
]
```

**`PluginEngine.bgKit` 共享底座**（多个背景插件共用，不用自己抄一份）：

| 方法 | 作用 |
|---|---|
| `canvas(size?)` | 空白正方形画布（缺省 256） |
| `speckle(c, colors, count, sizeMin, sizeMax)` | 在 canvas 上下文 `c` 上撒均匀噪点（颜色随机、半径在 min~max） |
| `seed(str)` / `rand(seed)` | 确定性随机：用 `house.hash` 做种子，同一栋房子重建后草 / 石位置不跳 |
| `retile(cv, tile, n)` | 把 tile 无缝平铺 n 次填进画布 |
| `fullPlane(tile, n)` | 平铺并生成 2048² 整图 |
| `flat(ctx, cv, name?)` | 扁平背景组装（平面网格 + 整图） |
| `repeatOpt(def?)` | 「颗粒密度」参数 schema |
| `offsetOpts(range?)` | **旧版**两条偏移参数，仍兼容；新代码用 `positionOpts(xzRange?, houseYDef?)`（三条，见 4.4） |

**能力边界与多插件并存**：

- 引擎对外只提供 `setBackdrop(group)`（统一 3D 挂载）/ `clearBackdrop()` / `setGridVisible(v)`；扁平地面一律用 `ctx.plane(canvas|texture)` 组装。
- 背景插件可以**有多个**，彼此独立（各自分组、各自参数、各自刷新率）。仓库自带 `assets/plugins/background/`（户外地面：草地 / 沙滩 / 石板 / 木栈道 / 雪地 / 水面(动态 15Hz) / 草原(自绘)），可直接复制当模板。
- 找不到插件或没选背景 → 回退**默认网格地台**；房屋尺寸变化（拖墙 / 加层）自动重放，`house.hash` 不变则完全不重建。
- 聚合 id = `<插件id>:<背景id>`（如 `background:grass`），存在 `project.settings.background`；复制目录后改 `plugin.json` 的 `id`（与目录名一致）、`plugin.js` 里 `register({ id })` 与 `name`，重启服务即出现在面板里，与已有插件并列。

### 4.8 背景常见坑

1. **扁平地面一律用 `ctx.plane()` 组装**：引擎已把平面压到 `y = -0.05`（略低于房间地板）避免 z-fighting，摆正、中心对准背景中心、各向异性过滤也都做好了；自己 `new PlaneGeometry` 很容易闪面。往 group 里加的体块从 `y = 0` 起步即可。
2. **`apply()` 是同步调用**：要用的图片在插件加载时预加载成 `Image`，`apply` 里画进 canvas 再交 `ctx.plane(canvas)`；返回值里没有 `url`，引擎也不代加载。
3. **必须返回 `{ group }`**：只返回 canvas / url / texture（没有 group）会被当成没画好，引擎直接清空背景、什么都不显示。
4. **静态背景不要声明 `refresh`**：静态只在切换背景或房屋尺寸变化时画一次，零每帧开销。
5. **`onData` 里不要做时间动画**：它只在实体数据变化时被调用，不是每帧。云飘 / 水流 / 太阳沿轨迹移动一律放 `update(t, api)`；`onData` 只决定「现在该不该有太阳 / 下不下雨 / 亮度多少」。
6. **立体背景里的天空元素要跟着 `houseY` 走**：云、雨滴、太阳、天气牌若写死绝对高度（如 `y = 24`），房屋抬到山顶后就会穿进山体或飘在半空。一律写成 `H + 相对高度`，`H` 从 `ctx.options.houseY` / `api.ctx.house.y` 取。
7. **`houseY < 0` 时别忘了挖洞**：地面平面固定在 `y = -0.05`，房子沉到基准面以下会被地面盖住。用 `ctx.plane(cv, null, hole)` 挖出房屋占地的洞，再自己补坑壁与坑底。
8. **高度只加信息、不改水平判定**：`safe.forbidden(x, z)` 恒为 2D，房屋悬空时它仍会把房子底下（水平投影）判为禁放；想在下面画东西就自己读 `safe.houseY` 比较，别指望引擎放行。可布置边界引擎不给 —— 用 `!forbidden()` + `ctx.planeSize/2 - margin` 自己钳（见 4.4）。
9. **两个平面之间必须留间隙**（立体背景最常见的闪面）：房屋地板顶面 `H`、地台底面 `H − 0.12`、贴图地面 `−0.05`、平台顶面、坑底……任意两个水平面至少错开 **0.2m**，建议统一用常量 `G = 0.25`。让平台顶面 / 山体顶面 / 房屋地板都等于 `H` 会整片出现斜条纹（z-fighting），调材质、开 `polygonOffset` 都只是遮丑。宁可留一条看得见的缝，或用一个竖直矮墙/基座把缝填上（竖直面与水平面不共面）。`ctx.plane(cv, null, hole)` 的四块拼面是严格分割、只共边不重叠，不需要额外留缝。

### 4.9 动态实体字段 `fields` 与顶层 `onData`（背景专用）

背景可以接管房屋之外的整个立体空间，其中一部分元素（太阳、雨、天气牌、光照强度）并不是「随时间匀速运动」，而是**跟着外部实体数据切换**。为此背景插件有两条**并存且互不干扰**的更新通道：

| | 时间通道 | 数据通道 |
|---|---|---|
| 写在哪 | `styles[].apply(ctx)` 的返回值里 | 注册对象**顶层** |
| 回调 | `update(t, api)` | `onData(fields, api)` |
| 触发 | `refresh > 0` 时按 Hz 节流 | 绑定的实体状态变化（含首帧与 HA 全量快照） |
| 负责 | 地面、水、云等持续运动 | 太阳、雨、天气状态等按数据切换 |
| 静态背景 | 不进调度 | **照样生效**（与 `refresh` 无关） |

**声明**：`fields` 写在注册对象顶层，和设备插件的字段结构一样（`key` / `label` / `domains` / `placeholder` / `tip`），但含义不同 —— 它是「订阅哪些实体」，不落到设备实例上。

```js
PluginEngine.register({
  id: 'sky-weather',
  kind: 'background',
  name: '天气天空',
  fields: [
    { key: 'weather', label: '天气实体', domains: ['weather'] },
    { key: 'lux',     label: '照度',     domains: ['sensor'] },
  ],
  styles: [{
    id: 'default', name: '天空', refresh: 24,
    apply(ctx) {
      const g = new ctx.THREE.Group();
      /* 地面 / 水 / 云：时间驱动，写这里 */
      return { group: g, update(t, api) { /* 云飘、水流 */ } };
    },
  }],
  /* 顶层数据通道：只负责跟着实体切的那部分元素 */
  onData(fields, api) {
    const T = api.ctx.THREE;
    const g = api.overlayGroup;
    if (!g) return;
    /* 元素少、调用频率低，整块重建最省心（不要缓存到模块级变量） */
    while (g.children.length) g.remove(g.children[0]);
    const st = fields.weather && fields.weather.state;   // 'sunny' / 'rainy' / 'cloudy' …
    const rainy = st === 'rainy' || st === 'pouring' || st === 'lightning-rainy';
    if (!rainy) {
      const sun = new T.Mesh(new T.SphereGeometry(1.6, 16, 12),
        new T.MeshBasicMaterial({ color: 0xffd76a }));
      sun.position.set(18, 26, -20);
      g.add(sun);
    }
    /* 雨、雪、雾同理；fields.lux 是 sensor 的 state 字符串，可直接 parseFloat */
  },
});
```

**可直接跑的样例**：内置「户外地面」插件 `assets/plugins/background/plugin.js` 顶层就声明了 `fields`（`weather` / `metric`）和 `onData()`，在 `api.overlayGroup` 里放一个 Sprite 天气牌。验证步骤：home 编辑页选任意背景 → 右侧「实体绑定 · 背景」把天气绑到 `weather.home`、数值绑到任意 `sensor.*`（演示模式下 `sensor.living_temp` 每 3 秒漂移，不用接真实 HA 就能看到刷新）→ 房屋右上方空中出现天气牌，状态/温度/数值随实体变化。未绑定实体或 HA 未连上时牌子自动隐藏，7 种地面的原有外观零改动；静态背景（`refresh:0`）同样生效。注意改过 `plugin.js` 要同步升 `plugin.json` 的 `version`（`?v=` 长缓存）。

**回调参数**

- `fields`：`{ <字段key>: { entity_id, state, attributes } | null }`。每个声明过的 key 都在表里；**未绑定、实体还没推过来、HA 未连接时为 `null`** —— 首屏很常见，插件必须自己写回退值（例如默认晴天）。`attributes` 里是温度、湿度、单位等，天气的中文映射可参考 `web/src/composables/useHud.js` 的 `COND_MAP` / `weatherState` computed（HUD 派生数据已 Vue 化，不再挂 `window.HUD`）。
- `api`：`{ group, mesh, size, overlayGroup, options, ctx }`。`overlayGroup` 是引擎自动建好、挂在背景 `group` 下的专属子树 —— **把数据驱动的元素都加到这里**，与 `apply` 画的内容物理隔离；背景重放时它随 `group` 一起销毁重建，所以不要跨回调缓存 mesh 引用。`ctx` 就是 `apply(ctx)` 那份（含 `THREE` / `house` / `safe` / `options`）。

**绑定与持久化**：用户在右侧「**背景设置**」面板「**背景 · 实体绑定**」分组里按字段绑定实体（与设备/门窗的实体绑定同款界面：字段名 + 未绑定状态 + 输入框 + tip；可复用项目级 `settings.weatherEntity` 填的 id，但不自动带过来），值存 `project.settings.backgroundFields['<插件id>'] = { 字段key: entityId }`，与 `backgroundOptions` 平级。**绑定是插件级的**：`fields` 声明在插件注册对象顶层，所以同一插件下的所有样式（石板 / 木栈道 / 草原…）共用这**一把 key**、共用同一份实体绑定，切换具体样式不会丢失或需要重绑；设备类插件同理，字段绑定存在实例 `obj[key]` 上，切灯体造型照样保留。只有背景的手工参数 `backgroundOptions` 仍按 `'<插件id>:<样式id>'` 存（各样式默认值可能不同）。读档 `fetchProject` 与写档 `serializeProject` 都会调用 `PluginEngine.migrateProjectBg` 把老版本分散在各样式键里的绑定自动合并成插件键（当前选中样式优先，幂等）。改绑定只推一次 `onData`，不会重建整个背景。

**引擎的调度细节**（写插件时知道即可）：

1. `applyBackground` 挂载成功后立刻补一次 `onData`（首帧，HA 可能还没连上）；
2. HA 连上推送全量快照时强制再补一次，首屏天气这时才真正到位；
3. 之后的每次 HA `change`，引擎对所有绑定字段做一次**值快照对比**（`state` + `attributes`），只有真的变了才回调 —— HA 的增量事件不一定带实体 id，所以不能靠事件参数过滤；顺带完成去重；
4. 背景重放（切换背景 / 改参数 / 切换楼层 / 房屋尺寸或层高变化）会清掉旧记录并重新走 1，**不会写到已释放对象上**；
5. 没有 `fields` / `onData` 的老插件完全走原路径，零改动兼容。

**在 studio 里开发调试**：预览引擎实现了同一套契约。项目 `fields` 会自动生成 mock 实体（左下角「预览状态」里可点切换），用 MCP 的 `studio_set_entity` 改状态即可触发 `onData` 并截图验证；`weather` 域的 mock 缺省是 `sunny`。导出/发布的是干净 `plugin.js`，顶层的 `fields` / `onData` 会原样带走。

---

## 5. 调试与排错

| 现象 | 优先检查 |
|---|---|
| 插件完全没出现 | `plugin.json` 的 `kind` / `id` / `version` 是否正确；`/api/plugins` 里能否看到它；控制台有没有 `PluginEngine.register` 之前的语法错误 |
| 改了代码没生效 | 没升 `plugin.json` 的 `version`（plugin.js 走 `?v=` 长缓存） |
| 改了 `styles[].options` 的 min/max，面板滑块上限没变 | 同上：`version` 没升，浏览器仍在跑旧 plugin.js（`/assets/plugins/<id>/plugin.js?v=<旧version>` 是一年 immutable） |
| 滑块能拖到新上限，但模型尺寸没跟着变 | 插件内部又写了一份 clamp（如 `dimsOf()` 里 `clamp(o.h, 1.6, 2.8, 2.2)`），与 `options` 脱钩。参数边界只留一处：用一张参数表同时生成 `options` 和几何夹取（见 `assets/plugins/wardrobe` 的 `P` / `OPTIONS`） |
| 设备是个灰色小方块 | `model3d` 抛错或返回了空/无 `group`，看控制台 `[plugin:<id>]` |
| 模型不显示 / 只有部分 | `ctx.glb()` 路径错或文件缺失（返回 `null`），检查 `models/` 与文件名大小写 |
| 状态不变化 | 实体没绑、`update()` 里没读状态，或实体域与 `type` 不匹配 |
| 模型发黑 | GLB 材质 metalness 过高（材质修复脚本已移除），直接替换 `models/` 下对应的 glb |
| 门窗变成半透明板 | ①`type` 没写或不是 `door` / `window`；②门/窗实例的 `obj.style` 指向了别的插件；③本插件 `model3d` 抛错或没返回 `group` |
| 样式按钮里没有我的造型 | `styles` 为空、条目缺 `id`/`name`，或 `type` 与实例类型不一致 |
| 样式参数面板不出现 | 当前样式没声明 `options`，或 `settings.backgroundOptions` / `styleOpts` 里存的是空值（会回退 `def`） |
| 背景 `onData` 不触发 | 顶层 `onData` 是否写对（不是 `apply` 返回值里的 `update`）；`fields` 有没有非空 `key`；属性面板里有没有绑实体；`PluginEngine.bgData` 是否为 null |

常用调试手段：

```js
window.__HA_DBG = true;                       // 打开引擎调试日志（生产默认关闭）
PluginEngine.byId;                            // 已注册插件表
PluginEngine.defs;                            // 已注册插件数组（按加载顺序）
PluginEngine.instances;                       // 当前场景实例
PluginEngine.bgAnim;                          // 动态背景运行态 { id, hz, interval, t, api }
PluginEngine.bgData;                          // 背景 onData 运行态 { id, fields, snap, errs }
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

### 6.2 门 / 窗（复制即用）

```js
PluginEngine.register({
  id: 'mywindow', kind: 'device', type: 'window', name: '窗',
  // 主实体（窗磁 / 智能窗）走「设备绑定」→ obj.entityId；fields 只放扩展实体
  fields: [{ key: 'posEntityId', label: '开度实体', domains: ['sensor'] }],
  click: { on: 'turn_on', off: 'turn_off', label: '开 / 关' },   // 想支持点击就写，不写即无点击控制
  model3d(ctx) {
    const W = ctx.obj.w || 1.2, H = 1.2, SILL = 0.9;   // 本地坐标：窗台 0.9m 起、高 1.2m（洞高 0.9~2.1）
    const g = new ctx.THREE.Group();
    const glassMat = ctx.lambert('#cfe6f2', { transparent: true, opacity: 0.45 });
    const glass = new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(W, H, 0.04), glassMat);
    glass.position.set(0, SILL + H / 2, 0);   // obj.z（离地高度）由引擎加在整组上，这里不要重复加
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

> 换成 `type: 'door'` 就是门插件：宽度同样读 `ctx.obj.w`，高度固定画 `0 ~ 2.06`（门洞 2.05），门/窗都**缺省不显示 3D 标签**（要显示写 `labels: true`）。

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

相关文档（插件目录规范、内置插件速查与引擎能力汇总已并入本手册，见 0.3 / 2.7 / 4.7）：

- `assets/plugins/door/plugin.js` 头部 — door 插件的完整参数手册（可作为注释版速查）
- `assets/plugins/background/plugin.js` 头部 — 背景插件 `ctx.house` / `safe` 的逐字段说明
