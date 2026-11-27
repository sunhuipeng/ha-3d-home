# HA 3D Home · 全屋智能 3D 可视化

轻量级 Home Assistant 3D 户型可视化控制中心：**绘制户型 → 摆放家具 → 绑定设备 → 3D 实时展示与控制**。

> 🔗 项目介绍主页（功能演示、截图）：<https://sunhuipeng.github.io/ha3d-site/>
> 📘 插件开发手册：[PLUGIN-DEV.md](PLUGIN-DEV.md)

## 功能一览

- **2D 户型编辑器**：墙体 / 门 / 窗 / 家具 / 设备点位，0.1m 网格吸附、撤销重做、快捷键齐全(绘制2d户型图，可以先初步摆放，在精细调整)
- **登录鉴权 + 扫码授权登录**：单账号门禁（环境变量配置，Docker/本地开发默认 `admin/admin`），保护页面与全部 API；其他设备可在登录页出示一次性二维码，**已登录的 App 扫码批准后对方免密登录**——两端一内网一外网、打同一个服务即可（详见下方「登录与外网访问」）
- **对接 Home Assistant**：HA WebSocket 经本服务全代理（同源 `/api/ha-ws`），实体状态实时推送、点击设备直接控制；内网/外网隧道行为一致
- **3D 展示**：Three.js 渲染全屋，灯具开灯发光、门窗开合动画、楼层切换、多造型切换
- **实时数据**：天气 HUD、可配置数据卡片、设备状态标签实时刷新
- **PC 展示板**：只读展示 + 场景一键执行 + 快捷设备开关，适合电脑 / 壁挂大屏
- **移动端控制面板**：窄屏单列（3D 预览 + 楼层 + 场景 + 房间 + 卡片），手指上滑可压缩 3D 预览、卡片内滚动；加宽后自动切左右分栏
- **全插件化**：设备造型、门窗动画、地面背景都是插件，内置 14 个，自定义插件放 `custom/plugins/` 即插即用
- **家具包**：zip 导入自定义家具（GLB + 清单），或用 studio 制作后一键发布
- **演示模式**：未配置 HA 时自动模拟实体，完整体验全流程

## 三个项目的关系

| 项目 | 仓库 | 作用 |
|---|---|---|
| **ha-3d-home**（本项目） | 运行时 | 跑起来的 3D 可视化服务：2D 编辑 + 3D 展示 + HA 全代理，插件与家具的宿主 |
| **ha3d-plugin-studio** | 插件工坊 | 可视化开发/预览插件的编辑器：做设备插件、背景插件、家具项目，做好后一键发布到 home |
| **ha3d-skill** | AI 技能包 | 给 AI Agent 用的开发技能（含 studio 的 MCP 工具说明），让 AI 能按规范开发插件 |

典型工作流：在 **studio** 里开发 / 预览插件或家具 → 一键发布到 **home** 安装使用；想让 AI 帮你写插件，给它装 **skill** 即可按同一套规范产出。

## 快速开始

```bash
# Docker（推荐，生产形态：容器内服务监听 8099，映射到主机 8099）
docker compose up -d --build        # 打开 http://主机IP:8099

# 本地开发（两个进程）
npm install && cd web && npm install
npm run serve                      # 后端（项目根）：node --watch，默认 8077，保存即自动重启
cd web && npm run dev              # 前端 Vite dev：http://localhost:5190，/api 代理到 8077
```

### 公开镜像（CNB）

公开镜像仓库：<https://cnb.cool/sunhuipeng/ha3d-images>（打开后点顶部「**制品**」查看全部镜像与 tag）。公开仓库无需登录即可拉取，镜像为 **amd64 + arm64** 多架构。

```bash
docker pull docker.cnb.cool/sunhuipeng/ha3d-images/ha-3d-home:latest
```

用公开镜像部署（跳过本地构建）：把 `docker-compose.yml` 里的 `build: .` 删掉，将 `image:` 改成 `docker.cnb.cool/sunhuipeng/ha3d-images/ha-3d-home:latest`，然后 `docker compose up -d`（首次自动拉取；更新用 `docker compose pull && docker compose up -d`）。端口 `8099`、数据卷 `./data` 与 `./custom`、各项环境变量均沿用仓库自带的 compose，升级镜像不丢数据。

**端口速查**

| 端口 | 谁在监听 | 用途 |
|---|---|---|
| `8099` | Docker 容器（`PORT=8099`） | 发行形态，对外唯一入口 |
| `8077` | 本地 `node server/index.js` | 后端默认端口，也是 Vite dev 的 `/api` 代理目标 |
| `5190` | Vite dev（`web/`） | 前端开发预览，已监听 `0.0.0.0`，可局域网真机访问 |

> 本地裸跑后端访问 `/` 会 404：本地 `public/` 为空，前端产物由 Docker 构建阶段把 `web/dist` 灌进去；本地看页面请走 5190。`npm run serve` 是**开发期**的热重启脚本，生产请用 Docker 或直接 `node server/index.js`。

**页面入口**

| 地址 | 用途 |
|---|---|
| `/` 或 `/index.html` | 展示页，自动按设备分发 PC 展示板 / 移动端控制面板 |
| `/edit.html`（或 `/edit`） | 2D 户型编辑器，绘制户型、配置 HA 连接都在这里 |
| `/login.html` | 登录页（启用门禁时出现，见下「登录与外网访问」）；第三个 Vite 入口，逻辑/样式在 `web/src/login.js` + `login.css`，TV 焦点导航复用 `engine/tvFocus.js` |

首次使用：打开编辑器 `/edit.html` → 右上角「连接」→ 填 HA 地址 + 长期访问令牌（HA 用户头像 → 安全 → 长期访问令牌）→ 保存并连接。不填也能用，自动进演示模式。

> 2026-11-19 起 HA 连接改为**服务端全代理**：浏览器 WebSocket 连本服务同源 `/api/ha-ws`，由服务端转发给 HA；摄像头等媒体图走同源 `/api/ha-media/*` 由服务端带 token 转发。内外网/隧道场景行为完全一致，不再依赖浏览器能直连内网 HA 地址。
>
> 2026-11-19 进一步收紧：**HA 令牌不再下发浏览器**——服务端在代理里代管 WS 鉴权（收到 HA `auth_required` 后代发 token），`/api/config` 只回 `haUrl / hasToken` 且**全项目仅在编辑页打开「连接与服务」弹窗时请求**；展示页 / 编辑页启动序列只开 WS，未配置 HA 由服务端关闭码 4400 通知前端进演示模式。
>
> 2026-11-25 起「居控中枢」（ha3d-automation）也走**服务端代理**：编辑页「展示项配置」新增分组，可勾选中枢里的动作与场景（含图标与名字）；展示页点击经同源 `/api/automation/trigger/:id` 转发执行。中枢地址由环境变量 `HA3D_AUTOMATION_URL` 指定（默认 `http://127.0.0.1:8100`；Docker 跨容器时设为对方容器地址，如 `http://ha3d-automation:8100`）。中枢不可达时编辑页提示拉取失败、展示页 toast 显示错误原因；只有中枢的**正式版本**可被触发（列表里标「未发布」的项会给出明确拒绝）。

用户自定义模型与插件统一放 `custom/`（结构与 `assets/` 相同，同 id 覆盖内置），升级镜像不丢失。**插件包**的 zip 结构（`plugin.json` + `plugin.js` + `models/*.glb`，无顶层目录）见 [PLUGIN-DEV.md](PLUGIN-DEV.md) §0.1；**家具包**（平铺 GLB + `item.json`）由 studio 打包生成，两者都在编辑页「导入」里上传。

## 登录与外网访问

默认**不开登录**（内网直连、行为与过去一致）。要用 jmlink 之类的穿透工具暴露到公网时，加一个账号即可——**不需要用户管理**：

```bash
# docker compose：在 environment 里加（或在 docker run 用 -e）
environment:
  - HA3D_AUTH_USER=admin
  - HA3D_AUTH_PASS=你的密码
  - HA3D_SESSION_DAYS=7          # 可选，默认 7 天（滑动续期：只要在用就不会掉登录）
```

- `HA3D_AUTH_USER` 与 `HA3D_AUTH_PASS` 必须**同时**设置才启用门禁；缺任一则完全放行。
- **session 滑动续期**：剩余有效期不足一半时，任何一次通过门禁的请求都会把有效期续满并重发 cookie（浏览器 `Max-Age` 同步续上）。常用设备永不掉登录，**闲置超过 `HA3D_SESSION_DAYS` 天**才需要重新登录。改了密码不会让已登录设备下线（token 与密码无绑定），要全端强制重登：删 `data/auth-sessions.json` 后重建容器。
- **本地开发（`npm run serve`）默认已启用 `admin / admin`**（由 `server/dev-auth.cjs` 预加载注入，仅当三个认证变量都没设置时生效；前端 5190 未登录会自动跳登录页）。要改账号就在命令前显式设 `HA3D_AUTH_USER` / `HA3D_AUTH_PASS`；要临时关闭认证：`HA3D_AUTH_USER= npm run serve`（给空值）。生产 Docker 不经过此脚本，不受影响。
- 更安全的做法是不写明文密码，改用 `HA3D_AUTH_PASS_HASH`（优先于明文），格式 `scrypt:<saltHex>:<hashHex>`，生成命令：
  ```bash
  node -e "const c=require('crypto'),s=c.randomBytes(16).toString('hex');console.log('scrypt:'+s+':'+c.scryptSync('你的密码',s,32).toString('hex'))"
  ```
- session 是 HttpOnly Cookie（`SameSite=Lax`，检测到 HTTPS 才加 `Secure`），多设备各持独立 token；**已落盘到 `data/auth-sessions.json`，服务重启自动恢复，已登录设备免重登**。
- 未登录访问页面 → 302 到 `/login.html`；未登录调 `/api/*` → 401 JSON。
- **免登录白名单（2026-11-19）**：`/api/health`、`/api/version`、`/api/auth/*`，以及 studio 跨服务调用用的 `POST /api/plugins/install`、`GET /api/house/size`、`GET /api/catalog`（只读元信息）。远程安装接口虽不受登录门禁约束，但**必须由 `X-Install-Key` 校验通过**——密钥在 home 编辑页「导入插件/包」弹窗里点按钮生成/设置，落盘 `data/install-key.json`，没有密钥时远程安装一律 401；studio 设置里的密钥必须与之一致；其余 `/api/*` 仍要登录。
- 登录接口：`POST /api/auth/login`（账号密码）、`/api/auth/me`、`/api/auth/logout`。连续 5 次密码错误锁定 60 秒。
- **穿透务必用 HTTPS**：否则账号密码明文过公网。cookie 的 `Secure` 会根据 `X-Forwarded-Proto` 自动开启。

**扫码授权登录（2026-11-19 定稿授权语义）**：待登录设备（浏览器/电视）在登录页「扫码登录」页签展示一次性二维码（60 秒、单次消费）；**已登录的 App** 在应用内设置页点「扫码授权登录」扫码，用自己的 token 调 `POST /api/auth/qr-approve` 批准（不写 cookie、不改自身登录态）；登录页轮询 `/api/auth/qr-status` 看到 `approved` 后自动调 `POST /api/auth/qr-login` 兑换 session，登录态落在**待登录方**自己的 cookie 里。一句话：App 已登录 = 授权方，扫码批准别人登录；谁展示二维码谁登录。跨网络（App 内网、对方外网，或反之）同样成立——code 存在服务端内存，与双方 origin 无关，只要两端打到同一个后端进程（多实例会各存一份 code，对不上）。服务端接口：`GET /api/auth/qr`、`GET /api/auth/qr.svg`、`GET /api/auth/qr-status`（pending/approved/consumed/expired/gone；**支持 `?wait=1` 长轮询**——pending 时 hold 最多 60 秒，状态变化立即唤醒返回，授权后展示方零延迟跳转；不传 wait 则行为同旧版短轮询）、`POST /api/auth/qr-approve`（须有效 token）、`POST /api/auth/qr-login`（须已 approved）。App 未登录时设置页按钮会拒绝并提示先登录。详见 app README。

**内外网地址切换免登录（仅 App 端）**：cookie 按 origin（协议+域名+端口）隔离，浏览器/WebView 在内网地址与穿透域名之间切换必然要重新登录——这是浏览器安全模型，换任何纯 Web 鉴权方式都绕不开。App 端通过**原生 token**解决：登录成功后服务端在响应体返回 `token`（同时照旧写 cookie，兼容浏览器），App 把它存进原生私有存储；之后每次加载页面前把同一个 token 预置到目标 origin 的 cookie（保证首屏 document 导航通过 guard），页面内 `/api/*` 请求由 `services/apiAuth.js` 额外注入 `X-HA3D-Token` 头（双保险）。服务端 `guard()` / `/auth/me` / `/auth/logout` 同时接受 `X-HA3D-Token`、`Authorization: Bearer` 与 cookie 三种来源，指向同一张 session 表。因此 App 在内网/外网地址间切换无需重新登录；浏览器端行为不变，换地址仍需各登一次。**session 落盘（2026-11-19）**：账号虽只有一个，但 App/平板/PC 各持一条独立 token，整表落盘 `data/auth-sessions.json`（200ms 节流合并写），服务重启时自动恢复并过滤过期条目——重启后所有已登录设备免重新登录；二维码与失败锁定为短命数据不落盘。退出登录走 logout 清对应 token 并同步落盘。

## 页面与设备适配

前端只有两个 HTML：`index.html`（展示页）与 `edit.html`（编辑器）。展示页固定挂载 `web/src/PanelApp.vue`，PC / 手机 / 平板 / 空壳 App 都是同一套页面，由组件自身按窗口自适应（判据 `isWideViewport`，见 `web/src/model/stageLayout.js`）：

| 判定 | 布局 |
|---|---|
| CSS 宽 ≥ 1024px | 左侧 3D + 右侧 340px 竖栏（原逻辑，零回归） |
| 横屏大屏兜底：宽 ≥ 768px 且高 ≥ 450px 且宽高比 ≥ 1.3 | 同上宽屏布局 |
| 其余（手机竖屏、平板竖屏、横屏手机、小窗） | 窄屏单列（3D 预览 + 楼层 + 场景 + 房间 + 卡片），手指上滑压缩 3D 预览、卡片内滚动 |

兜底那一条专治「物理横屏大屏、但 CSS 像素被浏览器/系统缩放压到 1024 以下」被误判成窄屏——典型是 1080p 投影 / 电视盒子缩放 150%~200% 后变成 CSS 960×540。`H ≥ 450` 这道闸排除横屏手机（短边多在 390~430）。JS 与 CSS 的等价 media query 必须同步（常量与说明集中在 `stageLayout.js`）。

2026-11-15 起不再按设备 UA / URL 参数分发，原 PC 展板 `DisplayApp.vue` 已下线（Element Plus 仍由编辑页使用）。PC / 手机 / 平板 / 空壳 App 一律是同一套 PanelApp，页面不读取任何类型参数，也不改写地址栏。左上角 🏠 在空壳 App 内唤起「服务器地址设置」，普通浏览器里为纯装饰。

```
http://localhost:8077/                 # 展示页（统一 PanelApp）
http://localhost:8077/edit.html        # 编辑器
```

> 上面示例用的是本地后端 8077；Docker 形态换成 `主机IP:8099`，本地开发预览换成 `localhost:5190`。

本地开发时 Vite dev（默认 5190）已监听 `0.0.0.0`，手机连同一 Wi-Fi 打开 `http://<电脑局域网IP>:5190/` 即可真机预览，无需带任何参数；注意手机里不要写 `localhost`。页面已声明 `color-scheme: light`，会拒绝浏览器跟随系统的自动深色（若浏览器里手动开启了「强制深色网页」开关，需自行关闭）。

## TV / 遥控模式

展示页支持用电视遥控器（或 PC 方向键）操作，焦点以蓝色描边高亮，确认键触发点击。核心实现在 `web/src/engine/tvFocus.js`。

**开启条件（必须宽屏 `innerWidth ≥ 1024`，窄屏一律不启用、走普通触摸）**

| 环境 | 条件 |
|---|---|
| App 壳内（`ha3d-app`） | 宽屏自动开启，无需参数（遥控键经壳转发） |
| 浏览器 | 宽屏 + URL 带 `?tv=1`（桌面调试后门），如 `http://localhost:5190/?tv=1` |

**四个区域与导航**（方向键先在当前区内按真实方向移动，到边界才切相邻区）
- 🏠 左上信息（房子图标 / 数据卡）、右上工具（旋转 / 标签 / 夜间）、右侧面板（场景 / 房间 / 设备卡片）、左下楼层
- **左右键**：同行移动，到行尾折到下一行行首，因此一直按右键可从左到右、从上到下走完整区；
- **上下键**：在区内找正下方 / 正上方最近的元素（如设备卡「关机」下键命中「设定温度」滑杆）；
- **跨区**：某方向本区到头后按位置邻接切换（家→右=工具、家→下=楼层、工具→右=面板、面板→右=楼层、面板→左=工具、楼层→右=面板、楼层→上=家），到边界无相邻区则原地停住；
- **滑杆**：焦点在数值滑杆上时左右键用于调节数值（不寻焦），上下键离开；
- **确认键**：对焦点元素执行 `click()`；触摸 / 鼠标按下会清除焦点环。

可聚焦元素由 `v-tap` 指令统一打 `tv-clickable` 标记（区域容器带 `#tv-zone-*` id）。App 侧按键映射与设置键见 `ha3d-app` 的 README。

**调试**：URL 加 `&debug=1` 在右上角显示焦点状态、各区候选数与最近按键轨迹；浏览器控制台可用 `__tvFocus.debug()` / `__tvFocus.key('down')` / `__tvFocus.clear()` / `__tvFocus.focusFirst()`。

**登录页同样支持**：`/login.html` 是第三个 Vite 入口，复用同一套 `tvFocus.js`——App 壳内宽屏或 `?tv=1` 下，方向键在 tab / 输入框 / 按钮间移动、确认键点击；亮/暗色跟随展示页的夜间偏好（同一个 `ha3d.nightMode` localStorage 键，登录页首帧读它写 `data-theme`，与展示页一致，不跟系统）。

## 开发

一切 3D 表现（设备 / 门 / 窗 / 背景）都是插件。目录规范、`ctx` 能力、三类插件模板、调试与常见坑，全部见 **[PLUGIN-DEV.md](PLUGIN-DEV.md)** —— 写插件前先读它。

## 开源协议

本项目基于 [PolyForm Noncommercial 1.0.0](LICENSE) 协议开源：

- ✅ **免费使用**：个人使用、学习研究、兴趣爱好项目等一切非商业用途完全免费
- ✅ **自由二次开发**：可以修改源码、二次开发、分发衍生版本
- ❌ **禁止商用**：不可出售、付费分发、付费托管 / SaaS 化；衍生项目同样禁止商用
- 💼 **商用授权**：确有商业使用需求，请单独联系作者

> 协议要点为中文摘要，法律效力以 [LICENSE](LICENSE) 中的英文原文为准。

## 更新与维护

本项目由作者**提供思路与需求 + AI Agent 全程开发**完成。项目维护需要消耗 token（AI 开发成本），因此：

- 在 token 充足的情况下会**持续维护**：修复 bug、适配新版 Home Assistant、打磨功能
- 维护节奏取决于可用资源，不承诺固定排期
- 欢迎提 Issue 反馈问题；按本协议提交的 PR 同样以非商业方式共享给所有用户
