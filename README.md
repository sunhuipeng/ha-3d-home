# HA 3D Home · 全屋智能 3D 可视化

轻量级 Home Assistant 3D 户型可视化控制中心：**绘制户型 → 摆放家具 → 绑定设备 → 3D 实时展示与控制**。

> 🔗 **项目介绍主页**：<https://sunhuipeng.github.io/ha3d-site/> —— 功能演示、截图与使用说明都在这里，想先了解这个项目是什么，从这一页看起最快。
>
> 📘 **开发文档**：[插件开发手册 · PLUGIN-DEV.md](PLUGIN-DEV.md)　·　[插件目录规范](assets/plugins/README.md)　·　详见 [插件开发](#插件开发)

**快速导航**：[功能](#功能) · [插件开发](#插件开发) · [架构](#架构) · [Docker 部署](#docker-部署) · [自定义资产](#自定义资产custom-目录) · [开源协议](#开源协议与更新维护) · [目录](#目录)

**插件化 · 全自定义 · 零侵入**——从设备造型、地面背景到门窗动画，一切 3D 表现都是插件；模型、清单、插件三个层级都支持「内置 + 自定义」双目录合并，同 id 自定义覆盖内置，不改一行代码就能换掉任何东西。



## 功能

- 📐 **2D 户型编辑器**：墙体绘制（0.1m 网格吸附、实时长度）、门/窗、家具库（8 类 × 任意形态，custom 家具包动态扩展）、设备点位
- 🛋 **家具摆放**：拖拽移动、旋转、调 X/Y/离地高度/整体比例（滑条实时预览 2D + 3D），同一类型可切换不同形态模型（GLB）。**内置只保留 15 件最小存量模型**（供现有项目 / 示例户型 / Docker 初始项目兼容），新增或替换家具推荐直接「导入插件」上传 `kind: catalog` 的家具包 zip（见 [家具包](#家具包)），落到 `custom/models/<项目id>/`，不用改 `assets/`、不用重建镜像
- 📡 **对接 Home Assistant**：浏览器**直连** HA WebSocket（`subscribe_entities` 实时推送，零延迟），支持灯光/开关/传感器/空调/窗帘/风扇等实体
- 🏠 **3D 展示**：Three.js 渲染墙体/门窗/家具/吊灯，灯具开灯发光、彩色灯支持，点击设备直接控制，楼层切换
- 📊 **实时数据**：天气 HUD（温度/湿度/天气现象）、可配置数据卡片、设备状态标签实时刷新、悬停查看状态
- 🖥 **大屏展示页**（`display.html`）：只读展示 + 场景一键执行（执行回执 ✓/已发送）、快捷设备两列开关、楼层记忆、自动旋转、相机取景记忆（拖动后刷新自动恢复）
- 🧩 **全插件化 3D 表现**：设备造型/门窗动画/地面背景都是独立插件（内置 14 个：门、窗、灯、开关、空调、窗帘、风扇、摄像头、传感器、音箱、扫地机、热水器、户外地面、庭院铺装），自定插件放 `custom/plugins/` 即插即用、可覆盖内置。**门窗也支持多造型**：门有单开门/双开门（卷帘门 `door_rolling` 在 custom），窗有推拉窗/对开窗（固定窗 `window_fixed` 在 custom），右侧面板一键切换，3D 动画与 2D 平面符号同步（门窗平面符号与设备简笔图都由插件 `plan2d()` 自绘，编辑器只留通用兜底；门窗传洞口在屏幕上的宽度 `L = w × ppm`，设备传 `ppm` 按「米 × ppm」自算尺寸）；样式按钮的图标同样由插件自带 SVG，引擎里没有任何造型/图标硬编码。**写插件见 [插件开发](#插件开发) → [PLUGIN-DEV.md](PLUGIN-DEV.md)**
- 🔌 **连接面板**：填 HA 地址 + 长期访问令牌，保存到 `data/config.json`，重启自动恢复
- 🧩 **演示模式**：未配置 HA 时自动模拟实体，完整体验全流程

## 插件开发

设备造型、门窗动画、地面背景**全部是插件** —— 想加自己的，从这里开始：

| 你想做什么 | 看哪一份 |
|---|---|
| **写一个新插件**：注册项全表、`ctx` 能力、设备 / 门 / 窗 / 背景模板、调试与常见坑 | **[PLUGIN-DEV.md](PLUGIN-DEV.md)** — 插件开发手册（按「目录与加载 → 通用 ctx → `kind:'device'`（设备 / 门 / 窗） / `kind:'background'` → 复制即用模板」编排，1000+ 行） |
| 搭插件骨架：`plugin.json` 怎么写、模型放哪、加载顺序与覆盖规则 | [assets/plugins/README.md](assets/plugins/README.md) — 插件目录规范 |
| 只想换造型 / 改参数，不写逻辑 | 见 [自定义资产（custom/ 目录）](#自定义资产custom-目录)：双目录合并与覆盖规则 |

最短路径（以「加一个自己的灯造型」为例，详见 [PLUGIN-DEV.md 2.6 最小示例](PLUGIN-DEV.md)）：

1. 把 `assets/plugins/light/` 整个复制到 `custom/plugins/my_light/`，改 `plugin.json` 里的 `id` / `name`
2. 改 `plugin.js` 的 `styles` 与 `model3d(ctx)`（照手册里的最小示例填，`ctx` 已给好 `box/cyl/sphere/lambert` 等原语）；同一造型的差异项（左右开、内外开…）用 `styles[].options` 声明，插件里读 `ctx.options`，见 [PLUGIN-DEV 2.2.1](PLUGIN-DEV.md#221-样式参数-stylesoptions)
3. 重启 `node server/index.js` → 编辑器「设备」面板的灯造型里出现新样式，选中即生效；想加 2D 平面符号再写 `plan2d(c, p)`

调试：控制台 `PluginEngine.defs` 可看已注册插件及其字段；插件异常只 warn 不中断渲染（引擎对 `model3d` / `plan2d` / `stateText` 都包了 try/catch）。

## 架构

```
浏览器 ──WebSocket直连──> Home Assistant (:8123/api/websocket)   实时状态 + 控制
   │
   └──HTTP──> 本服务 (Node + Express)                              静态页面 + 配置/项目存储 + HA 连接测试
                 ├─ /data      config.json · project.json · refimg.*（2D 参考底图）
                 └─ /app/assets 内置家具模型与插件（镜像内，只读）
```

内存占用约 **50-60MB**（docker-compose 限制 128m）。

## Docker 部署

```bash
docker compose up -d --build
# 或
docker run -d --name ha-3d-home --restart unless-stopped \
  -p 8099:8099 \
  -v "$PWD/data:/data" -v "$PWD/custom:/custom" \
  ha-3d-home:latest
```

镜像说明（生产模式）：

- **镜像即内置资产**：`assets/`（模型 + 插件）直接打进镜像，不挂载、不解压，升级镜像 = 升级内置资产
- **用户数据全在挂载卷**，升级/重建镜像都不丢：
  - `/data`（容器路径）— 连接配置 + 户型项目 + 贴图（首启缺 `config.json` / `project.json` 时写入默认值，已有则不动）
  - `/custom`（宿主机 `custom/`）— 用户自定义模型与插件，镜像只建目录、永不写入
- **日志**：`NODE_ENV=production` 下默认静默（服务端 + 前端调试日志全关）；排查时 `-e HA3D_LOG=1`
- 首次安装的示例户型与连接配置来自 `deploy/seed/data/`（构建时打进镜像，容器首启缺文件才写入）

打开 `http://主机IP:8099` → 右上角「连接」→ 填入 HA 地址（如 `http://192.168.31.16:8123`）和
长期访问令牌（HA 用户头像 → 安全 → 长期访问令牌）→ 保存并连接。

> ⚠️ 令牌会下发到浏览器用于直连 HA WebSocket，请仅在可信内网使用。

## 自定义资产（custom/ 目录）

内置资产在 `assets/`（直接打进镜像），**用户自定义放 `custom/`，结构与 assets 完全相同**，服务端自动合并，**同名/同 id 时自定义覆盖内置**：

> 🛋 **家具扩展只走 `custom/`**：`assets/models/` 与 `assets/catalog.json` 的 `items` 已精简为 15 件最小存量集
> （现有 `data/project.json`、新建项目示例户型、Docker 初始项目在用），**只减不增** —— 内置目录随镜像升级会被覆盖。
> 想要任意多自己的家具，用 studio 做家具项目导出 zip → 编辑器「导入插件」上传，整包落到
> `custom/models/<项目id>/`（见 [家具包](#家具包)）。`assets/catalog.json` 只保留 `types` 分类枚举供前后端与包校验共用。

```
custom/
├─ models/        自定义家具模型 *.glb（与内置同 id 同名 → 直接替换该家具模型）
│  └─ <项目id>/   导入的家具包：一个项目一个文件夹（item.json + 多个 glb，见「家具包」）★ 推荐
├─ plugins/       自定义插件 <目录>/plugin.json + plugin.js（同插件 id → 覆盖内置插件）
└─ catalog.json   （可选）自定义家具清单，条目覆盖内置同名 id
```

- 本地开发：直接在项目根 `custom/` 下放文件，重启 `node server/index.js` 生效
- Docker：`-v "$PWD/custom:/custom"` 单独挂载（compose 已配好），升级/重建镜像不丢失
- 覆盖示例：想换内置的「单人床」模型，把新 glb 命名为 `bed_single.glb` 放进 `custom/models/`，清单和代码都不用动
- 自己写插件：目录结构 → [assets/plugins/README.md](assets/plugins/README.md)；写代码 → [PLUGIN-DEV.md](PLUGIN-DEV.md)（速览见 [插件开发](#插件开发)）

## 安装包（zip）：插件与家具共用一个入口

编辑器右上角「导入插件」收的是 **zip**，服务端按清单里的 `kind` 自动判断这是插件还是家具，前端流程与文案不变：

| 包类型 | 判定依据 | 落地位置 |
| --- | --- | --- |
| 插件包 | `plugin.json` 的 `kind` = `device`（门窗 / 灯 / 开关…所有有状态设备）或 `background`（户外地面等背景），且包根有 `plugin.js` | `custom/plugins/<id>/` |
| 家具包 | 包根有 `item.json`（`kind` = `catalog`），且带若干个 `.glb` 模型 | `custom/models/<项目id>/` |

**`kind` 是必填项**：清单里没写 kind 直接拒绝导入（不再按文件形状猜类型），报错会点名是哪个文件缺 kind，避免装错位置后难排查。

两类都**按 id 定位目录**：同一个 id 重复导入 = 整体覆盖升级（先写临时目录再原子替换，失败自动回滚旧版本）。

### 插件包

插件包结构（**无顶层目录**，和 studio 导出的压缩包一致）：

```
plugin.json    清单：id / name / version / kind（device 或 background）…（id 决定安装目录名）
plugin.js      注册代码（PluginEngine.register）
models/*.glb   可选，插件自带模型
```

两种安装方式，都落到 `custom/plugins/<id>/`：

1. **编辑器右上角「导入插件」**：把 zip 拖进弹窗（或点选文件）→ 自动上传 → 成功后页面自动刷新，插件立即可用
2. **远程安装（studio 一键发布）**：`POST /api/plugins/install?id=<id>&version=<v>`
   - 头 `X-Install-Key`：先在 HA 3D Home 里配安装密钥（见下），studio 设置里填同一个
   - 头 `Content-Type: application/zip`，body 就是 zip 字节
   - 返回 200 `{ ok, kind, id, version, upgraded, files }`；密钥错 401、包不合法 400
   - 插件包与家具包都收（按清单 `kind` 分流）；家具包的包内 `id` 必须与 URL 里的 `?id` 一致

### 家具包

**一个家具包 = studio 里的一个「家具项目」**，包里可以有多件家具（多个 glb），整包装到
`custom/models/<项目id>/`。包内结构（`item.json` 与所有模型**平铺**在包根，允许整体套一层目录）：

```
item.json     包清单：kind: "catalog" + id（项目随机 id）+ items 数组（每个 glb 一条）
sofa.glb      模型，与 item.json 平铺
armchair.glb  想放几件放几件，每件在 items 里各占一条
```

清单示例：

```json
{
  "kind": "catalog",
  "id": "p_r7k2m9q1",
  "name": "客餐厅套装",
  "version": "1.0.0",
  "items": [
    { "id": "sofa", "name": "三人沙发", "type": "sofa", "w": 2.1, "d": 0.9, "h": 0.8,
      "color": "#c9a26e", "model": "sofa.glb" },
    { "id": "armchair", "name": "单人椅", "type": "sofa", "w": 0.8, "d": 0.82, "h": 0.78,
      "model": "armchair.glb" }
  ]
}
```

- `id` **必填**（项目随机 id，小写字母/数字开头，字母/数字/_ . -，最长 64）：它就是安装目录名
  `custom/models/<id>/`。**同一个 id 重复导入 = 整包覆盖升级**（先写临时目录再原子替换，失败回滚）
- `name` / `version` 可选：包名用于导入成功提示；条目没写 `version` 时继承包级版本
- `items` **必填且至少 1 条**，一条对应一个 glb：
  - `items[].id` **包内唯一**即可 —— 最终目录条目 id 是 `<项目id>:<包内id>`，所以两个包都写 `sofa` 也不会互相顶掉
  - `type` **必填**，且必须命中分类表（`assets/catalog.json` 的 `types`）：`sofa`（沙发/座椅）/ `bed`（床品）/ `table`（桌几）/ `cabinet`（柜架）/ `kitchen`（厨餐）/ `bath`（卫浴）/ `deco`（装饰）/ `other`（其他，不确定归哪类就写它）
    - 缺失或超出 → **拒绝导入**并指出是第几条（大小写不敏感，存小写）
    - 分类表**只有一处**：`assets/catalog.json` 的 `types` 数组。服务端按它校验导入的 type，前端通过 `GET /api/catalog` 的 `types` 字段拿到同一份来生成家具库页签 —— 加/删/改分类名只改这一处，两端同时生效，不用改代码
    - `other` 的家具在家具库进「其他」页签
  - `w` / `d` 必填（米，2D 摆放与碰撞按它算），`h` 缺省 0.6，`color` 缺省灰蓝
  - `model` 写包内文件名即可；**省略时包里只能有一个 glb**，多模型必须逐条指明（否则报错列出候选）
  - `icon` 可选（64×64 的 SVG 图元字符串，2D 平面图标，省了只画方块）、`scale` 可选（模型额外缩放）
- 导入后服务端扫描 `custom/models/<项目id>/` 合并进 `GET /api/catalog`；内置家具仍是
  `assets/catalog.json` + `assets/models/` 平铺，不受影响 —— 但内置已是 15 件最小存量集，
  **扩展请只走家具包**，不要往 `assets/models/` 加文件
- 条目 id 带项目前缀，所以**不会覆盖内置家具**（想接管内置 `sofa` 请改 `custom/catalog.json`）
- 老格式（一件家具一个目录、目录里放自己的 json + glb）仍然可读，目录名直接当条目 id
- **能不能完全不用内置模型？** 能。新建项目后把示例户型里的家具删掉，再导入自己的家具包即可；
  服务端 `GET /api/catalog` 会把内置 15 条与所有家具包条目一起返回，两类可混用、也可只用后者。
  只有 `assets/catalog.json` 的 `types`（分类枚举）必须保留 —— 它是包校验与前端页签的唯一出处

## 安装密钥配置（二选一，环境变量优先）

- 「连接与服务」弹窗里的**安装密钥**输入框（存 `data/install-key.json`，接口 `/api/install/config`）
- 环境变量 `HA3D_INSTALL_KEY`（容器部署推荐，页面会显示为不可修改）

> 未配置密钥时远程安装一律 401，编辑器里的「导入插件」不受影响。

## 本地开发（无需 Docker）

```bash
npm install             # 首次安装 express（服务端唯一生产依赖）
npm start               # = node server/index.js；端口默认 8077（PORT=xxxx 可改）
# 打开 http://localhost:8077
```

> **应用版本号**：唯一出处是根目录 `package.json` 的 `version`。服务端 `GET /api/version`
> 每次请求都重新读文件（不用 `require` 缓存），前端 `public/js/version.js` 自动填充带
> `data-app-version` 的占位，页面里不写死任何版本号。`npm run push:image` 自动升版后
> **刷新页面即更新，连服务都不用重启**。编辑页在页面左下角（2D/3D 常驻），大屏页在标题右侧，
> 两处共用同一份数据、同一个填充脚本。

> **大屏旋转锚点**：默认 = 房屋中心（`View3D.center`，按户型包围盒实时算），长按 3D 画面可改，
> 「◎ 重置锚点」回到默认。锚点存服务端 `data/project.json` 的 `settings.anchors`（按楼层 id）：
> `GET /api/project` 随项目下发、`PUT /api/anchor` 局部更新，因此跨设备 / 跨浏览器一致。
> 专用接口只合并 `settings.anchors` 一个字段，不会整份覆盖编辑页保存的户型；编辑页整份保存时
> 服务端也会以磁盘上的锚点为准，不被旧快照抹掉。服务端不可用或没有记录时退到前端
> `localStorage`，**两边都没有、或数据损坏时一定回房屋中心**。取景记忆与锚点的本地键同为
> 楼层 id（`ha3d.displayCam.<id>` / `ha3d.displayAnchor.<id>`），与服务端口径一致；旧版按楼层
> 索引的 `...f0` / `...f1` 键不再读写（残留可在浏览器 DevTools 手动清理）。
> 改了 `server/*.js` 记得重启服务。

## 目录

```
server/            后端（Express 4 是唯一生产依赖，其余仍用 Node 内置模块；全部平铺、无子目录）
  index.js         唯一入口：启动 + 应用组装 + 按域挂载路由 + 静态/异常兜底
  shared.js  唯一共用基础层：目录常量/日志/data 持久化 + JSON 响应 + 请求体读取 + 路由公共件
  library.js 共用能力层：静态托管与缓存 + 家具目录/2D 底图 + 家具包 + 插件清单/zip 安装 + 原子替换
  system.js     /api/health、/api/version
  config.js     /api/config、/api/config/test（含 HA 连接测试）
  assets.js     /api/upload、/api/refimg、/api/catalog、/api/plugins
  install.js    /api/install/config*、/api/plugins/install、/api/plugins/import
  project.js    /api/project、/api/anchor、/api/house/size
public/            前端（编辑器 / 3D / HA 客户端，交互逻辑全在前端）
  index.html       编辑器（2D 户型 + 3D 预览 + 面板）
  display.html     大屏展示页（只读 + 场景执行 + 快捷设备）
  js/ha.js         HA WebSocket 直连客户端 + 演示模式
  js/editor.js     2D 户型编辑器
  js/view3d.js     Three.js 3D 视图（frame(opts) 取景由调用端自控）
  js/catalog.js    固定类型枚举 + assets 目录动态加载（家具形态）+ 插件造型聚合
  js/plugins.js    有状态插件引擎（门窗/设备 GLB + 状态动画 + 背景插件生命周期）
  js/app.js        总控 / 面板 / HUD
  js/display.js    大屏页面逻辑（场景回执 / 取景记忆 / 楼层记忆）
data/              运行时配置与项目（勿删）
assets/            内置目录数据 + 家具模型 + 设备/背景插件（见 assets/README.md）
custom/            用户自定义模型与插件（结构同 assets，同名/同 id 覆盖内置）
PLUGIN-DEV.md      插件开发手册（通用 ctx 函数表 + 设备/门窗/背景三类参数与示例）
```

> 📘 上表里的 `PLUGIN-DEV.md` 是插件开发手册 —— 直接打开：[PLUGIN-DEV.md](PLUGIN-DEV.md)；配套的目录规范：[assets/plugins/README.md](assets/plugins/README.md)。

## 脚本工具（scripts/）

以下脚本只用 Python / bash，本身不需要 npm install：

| 脚本 | 作用 | 用法 |
|---|---|---|
| `fix-glb-materials.py` | 检查并修复 GLB 材质问题（见下） | `npm run fix:glb` |
| `push-image.sh` | 自动升版 → 构建 arm64 镜像 → 推送到内网仓库 `192.168.31.16:4000/sunhuipeng`，见下方说明 | `npm run push:image` |

### push-image.sh 推送到内网仓库

当前发布口径：**只推 `linux/arm64`**。每次执行先把 `package.json` 的 `version` 递增一位
（默认 patch，`1.0.0 → 1.0.1`），然后只推两个 tag：

- `192.168.31.16:4000/sunhuipeng/ha-3d-home:<version>`（版本固定，如 `1.0.2`）
- `192.168.31.16:4000/sunhuipeng/ha-3d-home:latest`（始终最新，**必推**）

```bash
npm run push:image                    # 自动升版 + 只推上面 2 个 tag
npm run push:image:arm64              # 显式平台，等价
BUMP=none npm run push:image          # 不升版，沿用当前 version 重推
BUMP=minor npm run push:image         # 升 minor（1.0.1 → 1.1.0）
VERSION=2.0.0 npm run push:image      # 手动指定版本号（不自动升版）
```

前置条件（换一台机器跑脚本时才需要处理）：

1. 内网仓库是 **HTTP**，Docker 必须把 `192.168.31.16:4000` 加进 `insecure-registries`
   （Docker Desktop / OrbStack → Settings → Docker Engine → `"insecure-registries": ["192.168.31.16:4000"]` → 重启 Docker）。
2. 首次推送先 `docker login 192.168.31.16:4000`（凭据存 `~/.docker/config.json`）。

目标机使用：

```bash
docker pull 192.168.31.16:4000/sunhuipeng/ha-3d-home:latest
# 或者把 docker-compose.yml 里的 build: . 删掉，image: 换成上面这行完整地址
docker compose up -d
```

> 目标机不是 arm64 时会 `exec format error`；确有 x86 需求时显式
> `bash scripts/push-image.sh linux/amd64` 单独推一个 amd64 tag。

> 不带登录态直接 `curl .../tags/list` 会返回 401；确认上传用 `docker pull <镜像>:<version>` 或仓库页面。

### fix-glb-materials.py 材质检查与修复

从网上下载的模型放进 3D 场景发黑时跑一遍即可根治（修改的是模型文件本身，运行时不再兜底处理）。**无参数运行 = 默认扫描项目 `assets/` + `custom/`**（递归收集所有 `.glb`，覆盖家具模型和插件里的模型），先逐项报告问题再批量原地修复，原文件备份到 `backups/<相对路径>`（同名覆盖）：

```bash
npm run fix:glb            # 扫描 assets/ + custom/，检查并批量修复
npm run fix:glb:check      # 只检查不修改
python3 scripts/fix-glb-materials.py model.glb         # 修指定文件（可传多个文件/目录）
python3 scripts/fix-glb-materials.py ~/Downloads --out ./fixed   # 修复版另存（保留目录结构）
```

判定规则（参数在合适范围内不调整，可重复运行不会二次修改）：

- 无贴图材质最亮通道 `< 0.25` → sRGB 颜色被当线性存了，gamma 提亮（`≤ 0.05` 视为有意的纯黑，不动）
- `metallic > 0.05` → 压到 0（无环境贴图的场景里金属度必然发黑；与贴图相乘，有贴图同样有效）
- `roughness < 0.7` → 抬到 0.7（柔化高光）
- 移除 `KHR_materials_specular` 等压暗扩展

已有贴图的材质不动颜色（贴图本身就是对的）；修完刷新页面即可看效果。

### 模型哪里找

推荐 [poly.pizza](https://poly.pizza/)——免费低多边形模型库（Quaternius、Kenney 等作者），按分类/关键词搜索，直接下载 GLB 放进 `custom/models/` 即用。下载的模型若在场景里发黑，跑一次 `npm run fix:glb` 修复材质即可。

## 快捷键

`V` 选择 · `H` 平移 · `W` 墙体 · `D` 门 · `N` 窗 · `F` 家具 · `E` 设备 · `B` 贴图 · `G` 背景 · `Del` 删除 · `Esc` 取消 · 空格+拖拽 平移 · 滚轮 缩放

## 开源协议与更新维护

### 开源协议

本项目基于 [PolyForm Noncommercial 1.0.0](LICENSE) 协议开源：

- ✅ **免费使用**：个人使用、学习研究、兴趣爱好项目等一切非商业用途完全免费
- ✅ **自由二次开发**：可以修改源码、基于本项目做二次开发、分发衍生版本
- ❌ **禁止商用**：不可出售、出租、付费分发本项目或基于它的作品，不可付费托管 / SaaS 化，不可用于任何商业目的
- ❌ **衍生项目同样禁止商用**：基于本项目二次开发的项目必须同样遵循本协议，也不能拿来卖钱或商用
- 💼 **商用授权**：确有商业使用需求，请单独联系作者获得商业授权
- 📋 **传递义务**：把本项目（或其衍生版本）提供给任何人时，必须同时附上本协议文本或其链接

> 协议要点为便于快速理解的中文摘要，法律效力以 [LICENSE](LICENSE) 中的英文原文为准。

### 更新与维护

本项目由作者**提供思路与需求 + AI Agent 全程开发**完成。项目维护需要消耗 token（AI 开发成本），因此：

- 在 token 充足的情况下会**持续维护**：修复 bug、适配新版 Home Assistant、打磨功能
- 维护节奏取决于可用资源，不承诺固定排期
- 欢迎提 Issue 反馈问题；按本协议提交的 PR 同样以非商业方式共享给所有用户
