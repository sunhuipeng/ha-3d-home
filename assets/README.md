# 内置资产目录（最小存量集）

> **扩展请去 `custom/`，不要改这里**：本目录随镜像一起升级，改动会在升级时被覆盖；用户自己的家具、
> 插件放在单独挂载的 `custom/`，升级不丢。内置家具模型已精简为 15 件（只保留现有项目 / 示例户型 /
> Docker 初始项目在用的），新家具走 `kind:"catalog"` 自定义家具包，详见 [家具形态](#家具形态catalogjson)。
> 修改本目录后**重启服务**（或刷新页面）生效。

## 核心模型：类型固定，形态动态

| 概念 | 位置 | 是否可扩展 |
|---|---|---|
| **类型（type）** | 家具 8 类，唯一出处是 `assets/catalog.json` 的 `types` 数组（沙发/座椅、床品、桌几、柜架、厨餐、卫浴、装饰、其他；前后端与家具包校验共用）；设备 10 类（灯、开关、传感器、空调、热水器、窗帘、风扇、影音、扫地机、摄像头，另加「其他」兜底） | 家具分类改 `catalog.json`，设备分类改代码 |
| **形态（id）** | 内置：`assets/models/*.glb` + `catalog.json`（仅存量）；**扩展：`custom/models/<项目id>/` 家具包**；设备造型 = 各插件的 `styles` | ✅ 导入家具包即可 |

同一类型下可以有任意多个形态（比如 10 种不同的沙发），界面左侧按类型聚合，右侧属性面板可切换同类型的其他形态。

## 目录结构

```
assets/
├─ catalog.json                家具分类枚举 types + 内置形态 items（最小存量集 15 条）
├─ models/                     内置家具 GLB（<id>.glb，15 件；不再新增）
└─ plugins/                    有状态设备/门窗/背景插件（每个目录一个插件，见 plugins/README.md）
   ├─ door/  window/  light/  switch/  climate/  water_heater/  sensor/  camera/
   ├─ cover/  fan/  speaker/  vacuum/
   └─ background/              ← 内置背景插件（户外地面）
```

> 背景插件（`background`）随镜像升级；要长期自定义可复制到 `custom/plugins/`。

设备（灯/开关/空调/…）**没有独立的模型目录**：它们的 3D 外观由插件负责，模型放在各插件自己的 `plugins/<id>/models/` 下。

## 家具形态（catalog.json）

> **内置家具已精简为最小存量集（15 件）**：只保留 `data/project.json`、新建项目示例户型、Docker 初始项目
> （`deploy/seed/data/project.json`）实际引用的模型，纯粹为兼容已有数据。**新增、替换家具请一律走
> `kind:"catalog"` 自定义家具包**（见下），不要再往 `assets/models/` 里放文件、也不要在 `catalog.json`
> 的 `items` 里追加条目。内置目录随镜像升级会被覆盖，而 `custom/` 是单独挂载卷，升级不丢。

`models/<id>.glb` 与 `catalog.json` 的 `items` 一一对应，条目示例：

```json
{ "id": "sofa", "type": "sofa", "name": "三人沙发",
  "w": 2.2, "d": 0.9, "h": 0.75, "color": "#c9a26e",
  "icon": "<rect x=\"10\" y=\"8\" width=\"48\" height=\"30\" rx=\"7\" fill=\"none\" stroke=\"#5d6b82\" stroke-width=\"2.5\"/>",
  "model": "/assets/models/sofa.glb" }
```

- `id`：形态标识（唯一，已放置家具通过 `mid` 引用它）
- `type`：所属分类，必须命中 `catalog.json` 的 `types`（8 类，含 `other`）
- `w/d/h`：平面尺寸与高度（米），2D 热区与 3D 拟合尺寸用；`model` 缺失或加载失败时按它画一个盒子兜底
- `color`：兜底颜色（2D 方块填充色 / 3D 缺模型时的占位色）
- `icon`：平面图标，一段 SVG 内部图元（不写 `<svg>` 外壳，坐标系固定 `viewBox="0 0 68 46"`）；
  用于家具库缩略图，不写则显示通用方块 —— 改图标只改这里，代码里没有按类型的图标表

### 完全用自定义家具包扩展（推荐）

编辑器右上角「导入插件」上传 `kind:"catalog"` 的 zip → 服务端把整包装进 `custom/models/<项目id>/`，
扫描后合并进 `GET /api/catalog`。因此**不碰 `assets/` 也能拥有任意多家具**：

- 包内 `item.json` 的 `items` 一条对应一个 glb，`type` 必填且必须命中上面的 `types`；
  条目最终 id 是 `<项目id>:<包内id>`，多个包写同名互不冲突
- 想**接管内置** `sofa` 这类 id：在 `custom/catalog.json` 里写同 id 的完整条目整条覆盖，
  或把同名 glb 放进 `custom/models/` 只换模型文件
- 兼容旧机制：直接丢进 `assets/models/` 或 `custom/models/` 的散装 glb 仍会被自动发现，
  但会归到「其他」类且没有中文名/尺寸，**不推荐**
- 包结构与字段详见根目录 [README.md 的「家具包」](../README.md#家具包)，或看现成的
  `custom/models/p519e0758/`（studio 导出的「客厅通用」包）

`catalog.json` 的 `types` 数组是分类枚举的唯一出处（服务端校验家具包、前端生成页签都读它），
**不要删**；`items` 只删/改存量，不新增。

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
- `z`：默认锚点离地高度（吸顶灯≈层高、落地灯=0）
- `icon`：可选，SVG 字符串（`ico('<path …/>')` 包裹，不写则显示 ⚙️ 兜底）
- 同一 `type` 允许多个插件并存（如 `light` 与 `light_strip`），造型各归各的插件渲染

## 有状态设备与门窗 = 插件

门、窗、灯、开关、空调等需要随实体状态变化的模型用插件实现：
静态部分用插件目录内的 GLB（可多个组合），动态部分（开门、光圈、扇片旋转）由代码控制。
详见 [`plugins/README.md`](plugins/README.md)。

## 家具模型来源

- `models/` 下每个 `<id>.glb` 对应 `catalog.json` 里一条 `items`（目前 15 件，只减不增）
- 新模型一律走自定义家具包：`custom/models/<项目id>/`（studio 导出 zip → 编辑器「导入插件」上传）。
  免费低多边形模型可取自 [poly.pizza](https://poly.pizza/)（Quaternius、Kenney 等作者）
- 想只替换某个内置模型的外观：把同名 glb 放进 `custom/models/`，或用 `custom/catalog.json` 整条覆盖
- 下载的模型发黑时跑一次 `npm run fix:glb` 修材质（脚本覆盖 assets 与 custom 下的 models 目录）
- 运行时 GLB 加载失败会按家具占位尺寸画一个盒子兜底，永不白屏
