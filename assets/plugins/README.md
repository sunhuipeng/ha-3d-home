# 有状态模型插件（assets/plugins/）

负责「固定类型且有状态变化」的模型：门、窗、灯、开关、空调、摄像头、窗帘、风扇、扫地机、音箱等。
家具类（静态 GLB、无状态）不走本目录，仍在 `assets/models/`。

> 完整的插件开发手册（通用 `ctx` 函数表 + 设备 / 门窗 / 背景三类参数与最小示例）见项目顶层 **[PLUGIN-DEV.md](../../PLUGIN-DEV.md)**。本文档偏「目录与约定」，手册偏「怎么写代码」。

## 目录结构

```
assets/plugins/<插件id>/
├── plugin.json    # 清单（服务端 /api/plugins 发现用）
├── plugin.js      # 注册代码: PluginEngine.register({...})
└── models/*.glb   # 可选静态模型（门框/门扇/窗框…）
```

## 插件定义

```js
PluginEngine.register({
  id: 'door',                 // 与目录名一致
  kind: 'opening',            // 'opening'（门窗）| 'device'（设备）| 'background'（背景，只管地面）
  type: 'light',             // device 必填: 对应 HA 设备类型
  name: '门',
  styles: [                   // device 可选: 本插件提供的造型（id 只需在本插件内唯一）
    { id: 'pendant', name: '吊灯', z: 2.25, icon: ico('<line x1="12" y1="3" x2="12" y2="8"/><path d="M7.5 8 h9 l-2 6 h-5 z"/>'), model: 'models/pendant.glb' },
    // z = 默认锚点离地高度；labelOffset = 标题标签相对锚点的抬升（可选，缺省 0.3）
    // icon = 样式按钮图标，**由插件自己提供**（SVG 字符串或 emoji），不写就显示 ⚙️
    // desc = 样式按钮下方的说明小字（可选）
    // options = 该造型的可调参数 schema（左右开 / 内外开 / 横竖装…），插件里读 ctx.options、
    //           plan2d 里读 p.options；写法见 PLUGIN-DEV.md 2.2.1
    { id: 'floor', name: '落地灯', z: 0, labelOffset: 1.75, icon: ico('<path d="M9.5 4 h5 l1.5 5.5 h-8 z"/><line x1="12" y1="9.5" x2="12" y2="19"/>') },
  ],
  fields: [                   // 扩展实体绑定（可选，device / opening 都支持）
    // device 的主实体由「设备绑定」管理，不要写进 fields；这里只放扩展实体
    { key: 'powerEntity', label: '功率', domains: ['sensor'], tip: '显示在标签/屏幕' },
  ],
  click: { on: 'toggle', off: 'toggle', label: '开 / 关' },   // 点击控制（可选，见下）
  stateText(st, obj, get) { return ''; },                       // 标签文案（可选，见下）
  async model3d(ctx) {
    // ctx: THREE / obj(门窗或设备数据，含扩展实体字段) / wallH / style(当前造型)
    //      glb(file) 加载本插件 models/*.glb（缓存）
    //      box/cyl/sphere/lambert 几何 helpers
    //      lightKit(parent, y, size) 发光灯 kit（kit.set(on, rgb)）
    //      getState(eid) / isOn(eid) / render() / animate(fn(dt))
    //      field(k) / fieldState(k) / fieldOn(k) / fieldNum(k) / fieldText(k) / hasField(k)   ← 扩展实体
    const group = new ctx.THREE.Group();
    const w = ctx.fieldNum('powerEntity');    // 绑定功率实体时拿到 45.2，未绑定为 null
    // ... 静态部分用 GLB（可多个组合），动态部分留引用
    return {
      group,                  // 插件坐标系: 原点=锚点（引擎负责摆放/旋转）
      update() { ... },       // 实体状态变化时被引擎回调
      dispose() { ... },      // 场景重建时被引擎回调
    };
  },
});
```

## 扩展实体（fields）

一个设备除了主实体，往往还能挂别的实体（插座的功率、空调的湿度、音箱的曲目……）。
插件在 `fields` 里声明这些可选字段，界面上就会出现在右侧「扩展实体」区，绑好后：

- 引擎把这些实体一起纳入监听，状态变化会触发插件 `update()`
- 插件用 `ctx.fieldNum('key')` / `ctx.fieldText('key')` / `ctx.fieldOn('key')` 读取
- 未绑定 → 一律返回 `null` / `''`，插件不用自己判空

```js
fields: [
  { key: 'powerEntity', label: '功率', domains: ['sensor'],
    placeholder: 'sensor.xxx（W，可选）', tip: '显示在插座屏/标签' },
],
```

- `domains: ['binary_sensor', 'cover']`（可选）→ 只在这些域里搜索
- `tip`（可选）→ 字段下方的一行说明
- 面板每行会显示该实体的**当前读数**与解绑按钮；清空输入框等同于解绑

**ctx 读取 API（model3d 内可用）**

| 方法 | 返回 | 说明 |
|---|---|---|
| `ctx.field(k)` | `sensor.xxx` \| null | 绑定的实体 ID |
| `ctx.hasField(k)` | bool | 是否绑定 |
| `ctx.fieldState(k)` | state \| null | 完整 HA 状态对象 |
| `ctx.fieldOn(k)` | bool | `state === 'on'` |
| `ctx.fieldNum(k)` | number \| null | 数值；`unknown`/`unavailable`/非数值 → null |
| `ctx.fieldText(k)` | string | `'45.2 W'`，未绑定 → `''` |

**ctx 其它常用能力**：`THREE`（别自带 CDN）、`obj`（实例数据）、`wallH`（层高）、`baseUrl`；
`glb('models/x.glb')`（Promise，内部已 clone）、`box/cyl/sphere/lambert`（画几何）、
`frame(g, L, ref, fallback)`（门窗框统一入口：共享 frame.glb + 缺模型兜底）、
`lightKit(parent, y, size, { dir })`（灯具光效）、`getState(eid)`/`isOn(eid)`、
`binaryRatio(eid)`（on/open→1，其它→0，未绑→null）、`toNum(v)`（宽松数值解析）、
`animate(fn)`（每帧回调，重建自动注销）、`render()`。

**PluginEngine 现成小工具**（别在插件里各写一份）：
`PluginEngine.ico(svg内片段)`（样式按钮图标包装）、`isOnState(st)`（on/open 判定）、
`runningState(st, {countOff})`（多模式域的运行态判定）、`baseStateText(st, map)`（标签文案底座）、
`fieldBits(obj, get, list)`（扩展实体拼进标签）。

**2D 绘制助手**（`plan2d(c, p)` 的 `p`）：`p.rrect(x,y,w,h,rad)` 建圆角矩形路径、
`p.draw(fn, { fill:false } / { stroke:false })` 建路径后按调色板一步填色+描边；
颜色仍取 `p.fill / p.ink / p.accent / p.accent2`，`p.ppm` 是像素/米。

**model3d 返回值归一**：只返回 `{ group }` 也行 —— 引擎补 `dispose` 空实现，
`update` 缺失置 `null`；有 `update` 时引擎会替你在挂上场景后**调一次初值**，不用自己调。

> **写新插件从这里抄**：`assets/plugins/door/plugin.js` 头部是一份完整的参数手册 ——
> 注册字段（id/kind/type/name/styles/fields/click/stateText）、ctx 全表、obj 字段、
> model3d 返回值与生命周期、坐标换算、常见坑、最小可跑模板。

**当前各设备插件声明的扩展实体**

| 插件 | 字段 | 用途 |
|---|---|---|
| light | `motionEntity` 人体感应、`luxEntity` 环境照度 | 标签显示「有人 / 320lx」 |
| switch | `powerEntity` 功率、`energyEntity` 电量 | 标签显示「45W / 1.2kWh」 |
| sensor | `batteryEntity` 电量、`humidityEntity` 湿度 | 标签显示「湿度 55% / 🔋85%（≤20% 变 ⚠）」 |
| climate | `humidityEntity` 湿度、`outdoorEntity` 室外温度 | 机身屏幕右下显示湿度；标签显示室内外对比 |
| water_heater | `powerEntity` 功率、`ambientEntity` 环境温度 | 主实体无 `heating_power` 时用功率驱动屏幕与呼吸灯 |
| cover | `luxEntity` 照度、`rainEntity` 雨感 | 标签显示「320lx / 有雨」 |
| fan | `tempEntity` 室温、`humidityEntity` 湿度 | 标签显示环境温湿度 |
| vacuum | `batteryEntity` 电量、`areaEntity` 清扫面积 | 标签显示「🔋78% / 32㎡」 |
| camera | `motionEntity` 移动侦测、`storageEntity` 存储余量 | 检测到移动时模型红灯 3Hz 快闪 + 标签提示 |
| speaker | `sourceEntity` 音源、`titleEntity` 当前曲目 | 触屏左上显示音源；曲目缺失时用它补 |

门窗（`door` / `window`）沿用同一套机制，`fields` 里放门磁 / 开度实体 —— 那是它们的**主绑定**（opening 没有独立的「设备绑定」输入框）。

## 点击控制（click）

设备被点击（3D 模型或标题标签）时执行什么服务，由插件注册参数声明；**不声明则用内置默认**，设备级还可在右侧「点击控制」勾选覆盖。

```js
PluginEngine.register({
  id: 'speaker', kind: 'device', type: 'media_player',
  click: {
    on:  { domain: 'media_player', service: 'media_play' },   // 当前未开启时发
    off: { domain: 'media_player', service: 'media_pause' },  // 当前已开启时发
    isOn: (st) => !!(st && st.state === 'playing'),           // 可选: 自定义"已开启"判定
    label: '播放 / 暂停',                                      // 可选: 属性面板勾选文案
    defaultOn: false,                                         // 可选: 默认是否响应点击（缺省 true）
  },
  ...
});
```

- `on`/`off` 可写字符串（服务名）或 `{ domain, service }`；同一域时可省 domain
- `isOn` 缺省判定: `state` 既不是 `off` 也不是 `unavailable` 即视为已开启
- 内置默认（未声明 click 的 type）: 灯/开关/风扇/窗帘 → `toggle`；热水器/空调 → `turn_on` / `turn_off`
- 没声明 click 且不在内置默认表里的 type（如 `sensor` / `vacuum`）返回 null = 不可点击；
  `camera` 由插件自己声明 turn_on / turn_off（defaultOn:false，默认不响应）
- 设备数据字段 `click: true|false` 强制开/关，未设置则跟随 `defaultOn`

当前各插件的点击行为:

| 插件 | type | 点击行为 | 默认 |
|---|---|---|---|
| light | light | `toggle` 开 / 关 | 可点 |
| switch | switch | `toggle` 开 / 关 | 可点 |
| fan | fan | `toggle` 开 / 关 | 可点 |
| cover | cover | `open_cover` / `close_cover`（state=open 或 position>0 视为已打开） | 可点 |
| water_heater | water_heater | `turn_on` / `turn_off` | 可点 |
| climate | climate | `turn_on` / `turn_off`（state 非 off 视为运行） | 可点 |
| vacuum | vacuum | `start` / `return_to_base`（cleaning/returning/paused 视为清扫中） | 可点 |
| sensor | sensor | `homeassistant.update_entity` 刷新读数（带 toast 反馈） | 可点 |
| speaker | media_player | `media_play` / `media_pause`（state=playing 视为播放中） | **不可点**（防误触出声） |
| camera | camera | `turn_on` / `turn_off`（多数摄像头不支持，默认关闭） | **不可点** |

door / window 属于 `kind: 'opening'`，不参与点击控制。

## 状态文案（stateText）

标题标签上显示什么文字属于各设备的领域知识，由插件声明，`view3d` 不再维护 type 映射表：

```js
stateText(st, obj, get) {
  // st  = HA 归一化后的 { state, attributes, last_changed }（主实体）
  // obj = 设备/门窗数据，含扩展实体绑定字段
  // get = (eid) => state，读扩展实体状态
  if (!st) return '';
  const m = { cleaning: '清扫中', returning: '回充中', docked: '已回充' };
  const base = m[st.state] || st.state;
  // 扩展实体用引擎提供的拼接工具：返回 ' · 🔋78% · 32㎡'（未绑定则空串）
  return base + PluginEngine.fieldBits(obj, get, [
    ['batteryEntity', (s, n) => (n != null ? '🔋' + Math.round(n) + '%' : '')],
    ['areaEntity', (s, n) => (n != null ? Math.round(n) + '㎡' : '')],
  ]);
}
```

- 返回非空字符串 → 直接显示（可自带单位/百分比/图标，如 `播放中 21% · 网易云音乐`、`58° → 60°`）
- 返回空 → 调用方回退通用规则：`on`/`off` → 已开启/已关闭，其余 `state + unit`
- `PluginEngine.fieldBits(obj, get, list)`：`list = [[字段key, (state, num) => 文本], ...]`，自动跳过未绑定/无状态/返回空的项，末尾拼成 ` · a · b`
- 引擎调用入口: `PluginEngine.labelOf(type, state, obj, get?)`；异常会被捕获并回退通用规则

## 造型命名空间

同一 `type` 可以有多个插件（比如 `light` 和以后的 `light_strip`），每个插件都可能写 `{ id: 'strip' }`。
引擎聚合时把 id 拼成 `<插件id>:<造型id>`（`light:strip` / `light_strip:strip`），因此：

- 界面下拉/按钮里用聚合 id（设备实例的 `style` 字段也存它）
- 插件 `model3d(ctx)` 拿到的 `ctx.style.id` 是**插件内部原始 id**（`strip`），插件代码不用关心命名空间

## 生命周期

- `model3d` → 场景构建时调用（可 async），返回 `{ group, update?, dispose? }`
- `update` → 插件引擎监听 HA WebSocket 状态，实体变化时统一回调所有实例
- `dispose` → 切楼层/重建场景时调用
- `animate(fn)` → 每帧回调（开关门缓动、扇叶旋转等动画）

## 引擎职责（public/js/plugins.js）

1. `/api/plugins` 发现插件并加载 plugin.js
2. 聚合插件 styles（`<插件id>:<造型id>`）供右侧样式面板使用（catalog.js 直接读引擎，不再有 catalog.json styles 这一层）
3. 场景构建时按 kind/style 匹配插件并创建实例；**插件缺失或 model3d 失败时由引擎放通用占位**
   （`devicePlaceholder` / `openingPlaceholder`，含设备自定义 GLB 的加载与失败兜底）
4. 统一监听实体变化分发 update；驱动每帧动画
5. 提供 `clickSpec()` / `labelOf()` / `labelOffset()` / `styleOf()` 给 UI 查询

> 造型归属：灯的外形与照射方向（`lightKit` 的 dir/angle/strength）、门窗的门扇窗扇与开合、
> 各类设备机身细节，全部只在插件里实现。`view3d.js` 是纯抽象层——不含任何 type 的造型知识：
> `buildDevice()` 只调 `PluginEngine.spawnDevice()` 再做通用变换与热区，
> `build()` 直接调 `PluginEngine.spawnOpening()`；占位逻辑也归引擎（不是 view3d）。
>
> **图标也归插件**：`styles[].icon` 由插件自己给（SVG 字符串或 emoji），面板直接 `v-html` 渲染；
> 引擎里没有内置图标映射表，插件不写就只有 ⚙️ 兜底。门窗的 2D 平面符号同理，走插件的 `plan2d(c, p)`。


## 背景插件（kind: 'background'）

背景 = **房屋外围的地面**。`apply(ctx)` **只返回一个 3D 模型**：`{ group: THREE.Group }`——扁平背景只是「比较扁的 3D 模型」，引擎不做任何平铺/UV 假设；天空由页面底色负责（渲染器透明），插件不参与。

```js
PluginEngine.register({
  id: 'background',           // 与目录名一致
  kind: 'background',         // 背景插件; 不需要 model3d()
  name: '户外地面',            // 面板分组标题
  styles: [                   // 背景样式列表（与设备/门窗插件统一叫 styles）
    // ① 扁平地面：图案平铺画进整张画布，再用 ctx.plane() 变成 120m 平面网格
    { id: 'grass', name: '草地', icon: '🌿', refresh: 0,
      options: [{ key: 'repeat', label: '颗粒密度', type: 'range', min: 8, max: 40, step: 2, def: 26 }],
      apply(ctx) {
        const g = new ctx.THREE.Group();
        g.add(ctx.plane(myGrassCanvas(ctx.options.repeat)));   // 平铺次数在画布内部自己消化
        return { group: g };
      } },

    // ② 立体地面：同一个 group 里再放起伏地形 / 草丛 / 石头
    { id: 'meadow', name: '草原', icon: '🌾', refresh: 0,
      apply: (ctx) => ({ group: buildMeadow(ctx) }) },

    // ③ 动态：声明 refresh(Hz) 后引擎按频率调 update(t, api)；
    //    贴图引用存在闭包里，改完自己 tex.needsUpdate = true
    { id: 'water', name: '水面', icon: '💧', refresh: 15,
      apply(ctx) {
        const T = ctx.THREE;
        const canvas = myWater(0);
        const tex = new T.CanvasTexture(canvas);
        const g = new T.Group();
        g.add(ctx.plane(tex));
        return { group: g, update(t) { myWater(t, canvas); tex.needsUpdate = true; } };
      } },
  ],
});
```

**条目字段**

| 字段 | 说明 |
|---|---|
| `id` / `name` / `icon` | 插件内唯一 id、按钮文案、图标（Emoji 或短文本） |
| `repeat` | **不是引擎字段，引擎会忽略**。要平铺次数请自己在 `options[]` 里声明同名 key，在 `apply` 里读取 |
| `refresh` | **刷新率 Hz**。`0`/缺省 = 静态（只画一次，零每帧开销）；`1..30` = 每秒回调 `update` 这么多次 |
| `options` | 可配置参数 schema，选中背景后在右侧属性栏自动渲染控件 |
| `apply(ctx)` | **必须**返回 `{ group, refresh?, update? }`；只返回 canvas/url/texture 会被判为没画好（背景清空） |

**ctx（引擎给的上下文，插件不用自己算）**

| 字段 | 说明 |
|---|---|
| `house` | 全屋墙包围盒 `{ minX,maxX,minY,maxY,w,d,cx,cy,floors,hash }`（所有楼层并集，切楼层不跳） |
| `safe` | 安全边界 `{ inner:1.5, outer:45, forbidden(x,z), allowed(x,z) }`：房屋占地外扩 1.5m 内禁放；45m 是可布置半径 |
| `options` | 参数当前值（默认值 ∪ 已保存值） |
| `refresh` | 本条目声明的刷新率（只读） |
| `THREE` / `size` | Three 命名空间 / 建议画布边长（512） |
| `plane(src, sizeM?)` | 地面网格工厂：传 canvas 或 THREE.Texture，返回 120m 平面网格（已摆正、中心对准背景中心 y=-0.05、防闪面、带各向异性）——`g.add(ctx.plane(cv))` 即用 |

**api（动态背景 `update(t, api)` 的第二个参数）**：`{ group, mesh, size }`。
没有 `needsUpdate()` / `texture` / `canvas`——动态改图请自己持有 CanvasTexture，改完直接 `tex.needsUpdate = true`。

**`PluginEngine.bgKit`（背景插件共享底座，多个背景插件共用，不用自己抄）**：
`canvas(size)` 空白画布 · `speckle(c, colors, n, min, max)` 均匀噪点 ·
`seed(str)` + `rand(seed)` 确定性随机（配合 `house.hash` 撒草/撒石位置不跳） ·
`retile(cv, tile, n)` / `fullPlane(tile, n)` 无缝 tile 铺满 2048² 大图 ·
`flat(ctx, cv, name?)` 扁平背景组装（平面网格 + 整图） · `repeatOpt(def)` 「颗粒密度」参数。
内置 `background` 与自定义 `garden` 两个插件都在用，参考它们的写法即可。

**坐标换算（新手最容易翻车的地方）**：2D 平面坐标 `(x, y)` → 3D `(x, z)`，高度方向才是 y 轴；所以 `house.minY / maxY / cy` 说的都是平面 y（即世界 z）。**`house.cx / cy` 是房屋相对背景中心的偏移量**（原点 = 背景中心，偏移由 `offsetX/offsetZ` 决定），所以画布中心对的是背景中心、房屋画在 `(house.cx, house.cy)` 上。

> 想自己写一个背景：完整的逐字段解释、坐标说明、可复制的最小示例和两个常见坑，都在 `assets/plugins/background/plugin.js` 文件头部注释里。

**参数 schema**：`{ key, label, type, min, max, step, def, choices? }`
`type` 支持 `range`（滑块 + 数字框）/ `number` / `select`（配 `choices:[{v,label}]`）/ `checkbox` / `text`；**不写 type 或写了不认识的值一律按 `text` 处理**。
值存在 `project.settings.backgroundOptions['<插件id>:<背景id>']`；改参数只重绘地面，不重建户型。

**生命周期与约定**

- 聚合 id = `<插件id>:<背景id>`（如 `background:grass`），存在 `project.settings.background`
- 房屋尺寸变化（拖墙 / 加层）时引擎自动重放背景；`house.hash` 不变则完全不重建
- 需要确定性随机（撒草 / 撒石）请用 `house.hash` 做种子，否则每次重建位置会跳
- 找不到插件或未选择 → 回退默认网格地台
- 能力边界：`setBackdrop(group)`（统一 3D 挂载）/ `clearBackdrop()` / `setGridVisible(v)` / ；组装扁平地面用 `ctx.plane(canvas|texture)`

**多插件并存**：背景插件可以有多个，彼此独立（各自分组、各自参数、各自刷新率）。
仓库内自带两个示例，可作为新建插件的模板直接复制：

| 目录 | 分组名 | 内容 | 覆盖形态 |
|---|---|---|---|
| `assets/plugins/background/` | 户外地面 | 草地 / 沙滩 / 石板 / 木栈道 / 雪地 / 水面(动态15Hz) / 草原(自绘) | 平铺 + 动态 + 自绘 |
| `custom/plugins/garden/` | 庭院铺装 | 鹅卵石 / 青砖 / 白砂枯山水 / 溪水(动态12Hz) / 汀步小径(自绘) | 平铺 + 动态 + 自绘 |

复制一份目录 → 改 `plugin.json` 的 `id`（与目录名一致）、`plugin.js` 里 `register({ id })` 与 `name`，
重启服务即出现在面板里，与已有插件并列。
