# 自定义资产目录

把文件放进本目录即可扩展应用，无需改代码。**修改后重启服务**（或刷新页面）即生效——Docker 部署时本目录可挂载出来，镜像本身不用重建。

## 核心模型：类型固定，形态动态

| 概念 | 位置 | 是否可扩展 |
|---|---|---|
| **类型（type）** | 代码固定枚举：家具 7 类（沙发/座椅、床品、桌几、柜架、厨餐、卫浴、装饰）；设备 10 类（灯、开关、传感器、空调、热水器、窗帘、风扇、影音、扫地机、摄像头，另加「其他」兜底） | ❌ 不可增删（改代码） |
| **形态（id）** | 本目录：家具 = `models/*.glb` + `catalog.json` 声明；设备造型 = 各插件的 `styles` | ✅ 放文件即可 |

同一类型下可以有任意多个形态（比如 10 种不同的沙发），界面左侧按类型聚合，右侧属性面板可切换同类型的其他形态。

## 目录结构

```
assets/
├─ catalog.json                家具形态清单（items）
├─ models/                     家具 GLB（<id>.glb）
└─ plugins/                    有状态设备/门窗插件（每个目录一个插件，见 plugins/README.md）
   ├─ door/  window/  light/  switch/  climate/  water_heater/  sensor/  camera/
   ├─ cover/  fan/  speaker/  vacuum/
   └─ background/               ← 内置背景插件（地面）
```

> 另一个背景插件 `garden`（庭院铺装）已挪到 `custom/plugins/garden/`，属于用户自定义资产，随 `custom/` 一起维护。

设备（灯/开关/空调/…）**没有独立的模型目录**：它们的 3D 外观由插件负责，模型放在各插件自己的 `plugins/<id>/models/` 下。

## 家具形态（catalog.json）

内置 20+ 种家具已生成为独立 GLB（`models/<id>.glb`，每件合并单一 mesh + 顶点色，2~6KB），并在 `catalog.json` 中声明：

```json
{ "id": "sofa2", "type": "sofa", "name": "双人沙发",
  "w": 1.6, "d": 0.9, "h": 0.75, "color": "#c9a26e",
  "icon": "<rect x=\"10\" y=\"8\" width=\"48\" height=\"30\" rx=\"7\" fill=\"none\" stroke=\"#5d6b82\" stroke-width=\"2.5\"/>",
  "model": "/assets/models/sofa2.glb" }
```

- `id`：形态标识（唯一，已放置家具通过 `mid` 引用它）
- `type`：所属固定类型，必须是上文 7 类之一（不写则归入「装饰」）
- `w/d/h`：平面尺寸与高度（米），2D 热区与 3D 拟合尺寸用；`model` 缺失或加载失败时按它画一个盒子兜底
- `color`：兜底颜色（2D 方块填充色 / 3D 缺模型时的占位色）
- `icon`：平面图标，一段 SVG 内部图元（不写 `<svg>` 外壳，坐标系固定 `viewBox="0 0 68 46"`）；
  用于家具库缩略图，不写则显示通用方块 —— 改图标只改这里，代码里没有按类型的图标表

**新增一个形态**：把 `.glb` 放进 `models/`，在 `catalog.json` 的 `items` 里加一条即可（重启服务）。
只放 `.glb` 不写清单也可以——服务端会自动发现它并作为「装饰」类展示，之后可在清单里补类型/名称。

## 设备造型（同类型不同外观）

**只由插件提供**，不在 `catalog.json` 里配置。插件注册时声明 `styles`，启动后自动聚合到右侧样式面板：

```js
PluginEngine.register({
  id: 'light', kind: 'device', type: 'light',
  styles: [
    { id: 'pendant', name: '吊灯',   z: 2.25 },
    { id: 'floor',   name: '落地灯', z: 0 },
  ],
  async model3d(ctx) { /* sid = ctx.style.id（插件内部原始 id） */ },
});
```

- 聚合 id = `<插件id>:<造型id>`（`light:pendant`）。多个插件可以有同名造型（各写 `pendant`），
  聚合时按插件前缀区分，不会互相覆盖；设备实例的 `style` 字段存的就是这个完整 id
- `z`：默认锚点离地高度（米，吸顶灯≈层高、落地灯=0）
- `icon`：可选，SVG 字符串（`ico('<path …/>')` 包裹，不写则显示 ⚙️ 兜底）
- 同一 `type` 允许多个插件并存（如 `light` 与 `light_strip`），造型各归各的插件渲染

## 有状态设备与门窗 = 插件

门、窗、灯、开关、空调等需要随实体状态变化的模型用插件实现：
静态部分用插件目录内的 GLB（可多个组合），动态部分（开门、光圈、扇片旋转）由代码控制。
详见 [`plugins/README.md`](plugins/README.md)。

## 家具模型来源

- `models/` 下每个 `<id>.glb` 就是一个家具模型（清单 `catalog.json` 里用 `model` 指向它）
- 模型可以来自 [poly.pizza](https://poly.pizza/) 等免费模型库，下载后直接放进 `models/`（内置）或 `custom/models/`（自定义）
- 下载的模型发黑时跑一次 `npm run fix:glb` 修材质
- 运行时 GLB 加载失败会按家具占位尺寸画一个盒子兜底，永不白屏
