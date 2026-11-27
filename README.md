# HA 3D Home · 全屋智能 3D 可视化

轻量级 Home Assistant 3D 户型可视化控制中心：**绘制户型 → 摆放家具 → 绑定设备 → 3D 实时展示与控制**。

> 🔗 项目介绍主页（功能演示、截图）：<https://sunhuipeng.github.io/ha3d-site/>
> 📘 插件开发手册：[PLUGIN-DEV.md](PLUGIN-DEV.md)

## 目录

- [一、项目概览](#一项目概览)：功能一览、五个项目的关系
- [二、部署与运行](#二部署与运行)：Docker Compose（完整示例）、公开镜像、本地开发、端口与页面入口
- [三、页面与设备适配](#三页面与设备适配)：自适应布局、TV / 遥控模式
- [四、开发](#四开发)：命令、插件与家具包
- [五、开源协议](#五开源协议) · [六、更新与维护](#六更新与维护)

---

## 一、项目概览

### 1.1 功能一览

- **2D 户型编辑器**：墙体 / 门 / 窗 / 家具 / 设备点位，0.1m 网格吸附、撤销重做、快捷键齐全（先初步绘制，再精细调整）
- **登录鉴权 + 扫码授权登录**：单账号门禁（环境变量配置，本地开发默认 `admin/admin`，Docker 默认免登录），保护页面与全部 API；其他设备可在登录页出示一次性二维码，**已登录的 App 扫码批准后对方免密登录**——两端一内网一外网、打同一个服务即可
- **对接 Home Assistant**：HA WebSocket 经本服务全代理（同源 `/api/ha-ws`），实体状态实时推送、点击设备直接控制；内网 / 外网隧道行为一致
- **3D 展示**：Three.js 渲染全屋，灯具开灯发光、门窗开合动画、楼层切换、多造型切换
- **实时数据**：天气 HUD、可配置数据卡片、设备状态标签实时刷新
- **PC 展示板**：只读展示 + 快捷操作一键执行 + 快捷设备开关，适合电脑 / 壁挂大屏
- **移动端控制面板**：窄屏单列（3D 预览 + 楼层 + 场景 + 房间 + 卡片），手指上滑可压缩 3D 预览、卡片内滚动；加宽后自动切左右分栏
- **全插件化**：设备造型、门窗动画、地面背景都是插件，内置 14 个，自定义插件放 `custom/plugins/` 即插即用
- **家具包**：zip 导入自定义家具（GLB + 清单），或用 studio 制作后一键发布
- **演示模式**：未配置 HA 时自动模拟实体，完整体验全流程

### 1.2 五个项目的关系

| 项目 | 仓库地址 | 作用 |
|---|---|---|
| **ha-3d-home**（本项目） | <https://gitee.com/sunhuip/ha-3d-home.git> | 运行时：跑起来的 3D 可视化服务，2D 编辑 + 3D 展示 + HA 全代理，插件与家具的宿主 |
| **ha3d-plugin-studio** | <https://gitee.com/sunhuip/ha3d-plugin-studio.git> | 插件工坊：可视化开发 / 预览插件的编辑器，做设备插件、背景插件、家具项目，做好后一键发布到 home |
| **ha3d-skill** | <https://gitee.com/sunhuip/ha3d-skill.git> | AI 技能包：给 AI Agent 用的开发技能（含 studio 的 MCP 工具说明），让 AI 能按规范开发插件 |
| **ha3d-app** | <https://gitee.com/sunhuip/ha3d-app.git> | Android 壳：WebView 承载展示页，提供全屏 / 遥控按键转发 / 服务器地址设置等原生能力 |
| **ha3d-automation** | <https://gitee.com/sunhuip/ha3d-automation.git> | 居控中枢：独立于 HA 原生的自动化执行服务，常驻自动化 + 动作与场景（影子 / 正式版本），经服务端代理供 home 展示与触发 |

典型工作流：在 **studio** 里开发 / 预览插件或家具 → 一键发布到 **home** 安装使用；想让 AI 帮你写插件，给它装 **skill** 即可按同一套规范产出；手机 / 电视端用 **app** 壳打开 home 展示页；复杂自动化逻辑在 **automation** 里编写验证，发布正式版后在 home 快捷操作里勾选触发。

---

## 二、部署与运行

### 2.1 Docker Compose（推荐，生产形态）

仓库自带 `docker-compose.yml`，容器内服务监听 `8099`，映射到主机 `8099`。下面是一份**完整示例**，注释说明了每一项的含义；不需要的项直接删掉即可（尤其是登录相关项，两项都设才启用门禁）：

```yaml
services:
  ha-3d-home:
    image: docker.cnb.cool/sunhuipeng/ha3d-images/ha-3d-home:latest
    # 然后 docker compose pull && docker compose up -d
    container_name: ha-3d-home
    restart: unless-stopped
    ports:
      - "8099:8099"                 # 对外唯一入口（宿主机 8099 → 容器 PORT）
    volumes:
      - ./data:/data                # 连接配置 + 户型项目 + 贴图；首启自动补默认 config.json / project.json
      - ./custom:/custom            # 用户自定义模型与插件（models/ plugins/；家具包来自 studio 发布），升级不丢
                                    # 内置 assets 不挂载，直接用镜像自带的，升级镜像即升级资产
    environment:
      NODE_ENV: production          # 生产模式：默认不打印日志
      HA3D_LOG: "0"                 # 排查时改成 "1" 打开日志
      PORT: 8099                    # 容器内监听端口，与 ports 映射右侧一致
      HA3D_DATA_DIR: /data          # 数据目录在容器内的挂载点

      # ---- 登录门禁（可选；两项都设才启用，删掉/注释任一项 → 免登录）----
      # HA3D_AUTH_USER: admin
      # HA3D_AUTH_PASS: 你的密码   # 可以使用，建议改用下面的 PASS_HASH，避免明文
      # HA3D_AUTH_PASS_HASH: scrypt:<saltHex>:<hashHex>   # 优先于明文密码
      # HA3D_SESSION_DAYS: 7       # 可选，默认 7 天，滑动续期
      # TRUST_XFF: "1"             # 仅反向代理场景：显式采信 X-Forwarded-For 作为客户端 IP

      # ---- 居控中枢（ha3d-automation）地址（可选）----
      # HA3D_AUTOMATION_URL: http://ha3d-automation:8100   # 同一 compose / 同一 docker network 时用容器名
      # HA3D_AUTOMATION_URL: http://192.168.31.16:8100     # 分开部署时用宿主机内网 IP + 映射端口
      # 不配时默认 http://127.0.0.1:8100 —— 容器内指向自己，连不到宿主机上的中枢，跨容器务必显式配置
    mem_limit: 128m                 # 内存上限（实际占用约 40~60MB）
```

启动与更新：

```bash
docker compose pull && docker compose up -d   # 用现成镜像时更新到最新版
```

### 2.2 公开镜像（CNB）

公开镜像仓库：<https://cnb.cool/sunhuipeng/ha3d-images> 公开仓库无需登录即可拉取，镜像为 **amd64 + arm64** 多架构。

```bash
docker pull docker.cnb.cool/sunhuipeng/ha3d-images/ha-3d-home:latest
```

部署时把 compose 里的 `build: .` 删掉、`image:` 改成 `docker.cnb.cool/sunhuipeng/ha3d-images/ha-3d-home:latest`，再 `docker compose up -d`（首次自动拉取）。端口 `8099`、数据卷 `./data` 与 `./custom`、各项环境变量均沿用仓库自带的 compose，升级镜像不丢数据。

### 2.3 本地开发（两个进程）

```bash
npm install && cd web && npm install   # 首次：后端依赖 + 前端依赖
npm run serve                          # 项目根：node --watch，后端默认 8077，保存即自动重启
cd web && npm run dev                  # 前端 Vite dev：http://localhost:5190，/api 代理到 8077
```

> `npm run serve` 是**开发期**的热重启脚本，会由 `server/dev-auth.cjs` 预加载 `admin/admin` 门禁（仅当三个认证变量都未设置时生效）；本地 5190 未登录会自动跳登录页。生产请用 Docker 或直接 `node server/index.js`。
>
> 本地裸跑后端访问 `/` 会 404：本地 `public/` 为空，前端产物由 Docker 构建阶段把 `web/dist` 灌进去；本地看页面请走 5190。

### 2.4 端口与页面入口速查

| 端口 | 谁在监听 | 用途 |
|---|---|---|
| `8099` | Docker 容器（`PORT=8099`） | 发行形态，对外唯一入口 |
| `8077` | 本地 `node server/index.js` | 后端默认端口，也是 Vite dev 的 `/api` 代理目标 |
| `5190` | Vite dev（`web/`） | 前端开发预览，已监听 `0.0.0.0`，可局域网真机访问 |

| 地址 | 用途 |
|---|---|
| `/` 或 `/index.html` | 展示页，自动按设备分发 PC 展示板 / 移动端控制面板 |
| `/edit.html`（或 `/edit`） | 2D 户型编辑器，绘制户型、配置 HA 连接都在这里 |
| `/login.html` | 登录页（启用门禁时出现）；第三个 Vite 入口，逻辑/样式在 `web/src/login.js` + `login.css`，TV 焦点导航复用 `engine/tvFocus.js` |

上表地址示例：本地后端 `http://localhost:8077/`，Docker 形态 `http://主机IP:8099/`，本地开发预览 `http://localhost:5190/`。

---

## 三、页面与设备适配

### 3.1 展示页自适应

前端只有两个 HTML：`index.html`（展示页）与 `edit.html`（编辑器）。展示页固定挂载 `web/src/PanelApp.vue`，PC / 手机 / 平板 / 空壳 App 都是同一套页面，由组件自身按窗口自适应（判据 `isWideViewport`，见 `web/src/model/stageLayout.js`）：

| 判定 | 布局 |
|---|---|
| CSS 宽 ≥ 1024px | 左侧 3D + 右侧 340px 竖栏（原逻辑，零回归） |
| 横屏大屏兜底：宽 ≥ 768px 且高 ≥ 450px 且宽高比 ≥ 1.3 | 同上宽屏布局 |
| 其余（手机竖屏、平板竖屏、横屏手机、小窗） | 窄屏单列（3D 预览 + 楼层 + 场景 + 房间 + 卡片），手指上滑压缩 3D 预览、卡片内滚动 |

### 3.2 TV / 遥控模式

展示页支持用电视遥控器（或 PC 方向键）操作，焦点以蓝色描边高亮，确认键触发点击。核心实现在 `web/src/engine/tvFocus.js`。

**开启条件（必须宽屏 `innerWidth ≥ 1024`，窄屏一律不启用、走普通触摸）**

| 环境 | 条件 |
|---|---|
| App 壳内（`ha3d-app`） | 宽屏自动开启，无需参数（遥控键经壳转发） |
| 浏览器 | 宽屏 + URL 带 `?tv=1`（桌面调试后门），如 `http://localhost:5190/?tv=1` |
---

## 四、开发

一切 3D 表现（设备 / 门 / 窗 / 背景）都是插件。目录规范、`ctx` 能力、三类插件模板、调试与常见坑，全部见 **[PLUGIN-DEV.md](PLUGIN-DEV.md)** —— 写插件前先读它。

常用命令（项目根）：

```bash
npm run serve        # 开发期：后端 node --watch，默认 8077
cd web && npm run dev      # 前端 Vite dev，默认 5190
cd web && npm test         # 前端测试
cd web && npm run build    # 前端构建（Docker 构建阶段用 --assetsDir static）
node --test tests/*.test.mjs  # 服务端测试
```

镜像推送脚本由作者维护（内网 NAS / CNB 公开仓库），普通部署不需要执行。

---

## 五、开源协议

本项目基于 [PolyForm Noncommercial 1.0.0](LICENSE) 协议开源：

- ✅ **免费使用**：个人使用、学习研究、兴趣爱好项目等一切非商业用途完全免费
- ✅ **自由二次开发**：可以修改源码、二次开发、分发衍生版本
- ❌ **禁止商用**：不可出售、付费分发、付费托管 / SaaS 化；衍生项目同样禁止商用
- 💼 **商用授权**：确有商业使用需求，请单独联系作者

> 协议要点为中文摘要，法律效力以 [LICENSE](LICENSE) 中的英文原文为准。

---

## 六、更新与维护

本项目由作者**提供思路与需求 + AI Agent 全程开发**完成。项目维护需要消耗 token（AI 开发成本），因此：

- 在 token 充足的情况下会**持续维护**：修复 bug、适配新版 Home Assistant、打磨功能
- 维护节奏取决于可用资源，不承诺固定排期
- 欢迎提 Issue 反馈问题；按本协议提交的 PR 同样以非商业方式共享给所有用户
