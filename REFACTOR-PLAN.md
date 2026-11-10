# ha-3d-home 前端重构计划与实施记录（REFACTOR-PLAN）

> 状态：**第 1～7 期全部完成，完整版已落地并验证通过**。
> 适用范围：ha-3d-home 前端框架现代化 + 后端 Express 迁移。
> 配套文档：`PLUGIN-DEV.md`（插件开发契约）、`DEVICE-CARD-DESIGN.md`（声明式设备卡片 schema）、`assets/plugins/README.md`（内置插件速查）。

---

## 1. 背景与重构前底座

| 层 | 重构前 |
|---|---|
| 前端框架 | 已是 Vue 3，但用全局 `vue.global.prod.js` + 经典 `<script>`，无打包；`app.js` 与 `display.js` 各起一个 `createApp` |
| 代码组织 | `public/js/*.js` 全是 IIFE / 顶层全局符号，大块头：`app.js` 72KB、`plugins.js` 77KB、`view3d.js` 44KB、`catalog.js` 26KB |
| 后端 | 真·零依赖 Node `http` 手写路由，按域拆在 `server/*.js` 的 `handle*` 函数里 |
| 页面 | 两个独立 HTML：`public/index.html → #app`（编辑页）、`public/display.html → #display`（大屏页） |
| 三维/二维 | `view3d.js`（THREE）、`editor.js`（Canvas 2D）都是命令式图形内核 |

**目标**：前端 Vite + Vue 3 SFC，中心放在组件化、复用化；后端迁到 Express；服务层保持无框架依赖，可在 Vue 外单测。

---

## 2. 架构原则：Vue 是 UI 层，其余都是服务层

> 用户明确的架构口径：「整体 Vue 是 UI 层，下面的其他比如插件、HA、渲染，都可以看成服务层」。
> 本版据此把早期的「核心层 / composables / Pinia / UI 四层」表述收敛为**两层**。

```
┌──────────────────────────────────────────────────────────┐
│ UI 层  src/ui/                                            │
│   pages/（编辑页 / 大屏页 SFC）                            │
│   components/（卡片族 / 字段族 / Viewer3D / Editor2D）     │
│   stores/（Pinia：仅跨组件共享的 UI 态与项目业务态）        │
│   composables/、install-services.js（薄桥接）              │
├──────────────────────────────────────────────────────────┤
│ 服务层  src/services/（不 import Vue，可在 Vue 外单测）     │
│   HA · PluginEngine · View3D · Editor · Recode · HUD       │
│   Catalog · Version · Cards · System · Bootstrap           │
└──────────────────────────────────────────────────────────┘
```

**红线**：

1. 服务层不 import Vue / Pinia；插件、HA、渲染、撤销、目录、卡片引擎都是纯模块或单例。
2. `View3D` / `Editor` 是命令式图形内核，一律 `markRaw` / `shallowRef`，绝不进深响应式。
3. Pinia 只放 UI 态与项目业务态；户型数据用 `shallowRef` 整体持有，避免每帧深响应重渲。
4. 服务层是服务端与浏览器之间的**逻辑**分层，不是进程分层：Express 的 `server/routes/*` 同样复用 `server/core.js` 等既有模块，不重复实现业务。

---

## 3. 落地目录结构

```
index.html / display.html     Vite 两个 MPA 入口（#app / #display）
src/
  main-editor.js              编辑页 createApp + Pinia + installServices
  main-display.js             大屏页 createApp + Pinia + installServices
  services/                   服务层：UI 层唯一 import 目标
    index.js                  统一出口 + serviceGlobals 汇总
    ha.js                    HA WebSocket / 状态缓存 / on·off·emit / callService
    catalog.js               家具目录、项目默认结构、设备类型
    hud.js editor.js recode.js plugin-engine.js view3d.js
    version.js system.js bootstrap.js
    cards.js                  声明式卡片引擎（纯逻辑，无 Vue）
  ui/
    install-services.js       服务层符号 → app.config.globalProperties
    pages/editor/EditorApp.vue
    pages/display/DisplayApp.vue
    components/cards/         CardGroup / Toggle / Range / Select / CustomButton / DeviceCardPanel
    components/fields/        FieldRow + 5 个字段控件
    components/Viewer3D.vue   components/Editor2D.vue
    composables/useSystemInfo.js
    stores/ui.js  stores/project.js
vite.config.mjs               双入口、Vue full build alias、API 代理、assetsDir=static
web-dist/                     构建产物（.gitignore 忽略）
server/
  express-index.js            npm start 默认入口，默认 8077
  express-app.js              五个 API 路由域 + 静态挂载
  cache-middleware.js         三级缓存
  routes/                     system / config / assets / install / project
  index.js                    旧站零依赖入口（start:legacy 回退，未改动）
public/                       旧站页面 + vendor(THREE) / style.css / favicon 兜底
```

> 第一期的 `src/core/`、`src/pages/`、`src/stores/`、`src/components/`、`src/composables/` 已按两层架构重组并清理；`public/js/*.js` 与 `public/*.html` 原样保留，仅供 `start:legacy` 使用。

---

## 4. 双页面架构（保持分开）

| 维度 | 编辑页 `index.html` | 大屏页 `display.html` |
|---|---|---|
| 场景 | 画户型、摆设备、配插件、绑 HA | 看 3D、点设备、实时状态 |
| 独占重量 | 2D Editor + 大量表单 | 不需要 2D 编辑器 |
| 入口 | `main-editor.js → EditorApp.vue` | `main-display.js → DisplayApp.vue` |

- **结论**：保持 MPA 双入口，Vite `rollupOptions.input = { editor, display }`。物理与逻辑上都分开，展示页不背 2D 编辑器。
- 两页共用 `src/ui/components/`（尤其卡片族）与 `src/services/`，做到「页面分开、组件复用」。
- `bootstrapCore()` 只做 `initVersion()` + 系统信息探测，**不重复调用** `PluginEngine.loadAll()` / `HA.connect()`（页面 `init()` 已有生命周期）。
- 编辑页挂载后设置 `window.App` 并调用 `window.__bootDone()` 移除启动图。

---

## 5. 服务层 ESM 化与全局桥接（关键坑）

`public/js/*.js` 的 8 个经典脚本搬运为 `src/services/*.js`，末尾统一加 ESM 导出 + `window` 桥接：

```js
if (typeof window !== 'undefined') window.HA = HA;       // 每个服务同理
export { HA };
```

桥接原因有四点（第 4 点是 2026-11-10 线上「编辑页空白」事故的根因，务必保留）：

1. **插件契约**：插件仍是经典 `<script>` 注入，靠裸全局 `PluginEngine.register({...})` 注册；不改 `assets/plugins/*/plugin.js`，不破坏 skill 生态。
2. **模板裸标识符**：Vue SFC 模板会把 `HA` / `deviceTypeOf` 等编译成 `_ctx.xxx`；`installServices(app)` 把 `serviceGlobals` 注入 `app.config.globalProperties`，并为 `window` / `document` / `localStorage` / `navigator` / `location` 提供 getter。
3. **导入顺序**：`services/index.js` 的 import 顺序 = 旧 `public/index.html` 的 `<script>` 顺序（`catalog` 顶层函数被 `plugin-engine` 裸调用、`hud` 依赖 `ha`、`view3d` 依赖 `THREE` 全局），ESM 按声明顺序求值，顺序即依赖顺序。
4. **`<script>` 裸标识符 ≠ 模板 `_ctx.xxx`**：SFC 的 `<script>` 是 ESM 模块作用域，`methods` / `computed` 里直接写的 `loadCatalog()`、`Editor.init()` 等只沿「模块 → 全局对象」解析，`app.config.globalProperties` **救不了它们**。因此每个被页面 `<script>` 直接调用的服务符号都必须在 `src/services/*.js` 末尾挂 `window.X = X`。特别地，桥接清单要覆盖 **`async function`**——`catalog.js` 的 `loadCatalog` / `fetchProject` 最初只因是 `async function` 而被生成脚本漏收，导致编辑页 `init()` 首句抛 `ReferenceError`，`Editor.init()` / `loadProject()` 全部没跑，2D 画布空白、`0 面墙 · 0 台设备`、`连接中…`。

> 排查手法（可复用）：用 `acorn` 解析 SFC `<script>` 收集自由标识符、用 `@vue/compiler-sfc` 编译模板收集 `_ctx.xxx`，分别与「window 桥接集合」「serviceGlobals 键集合」做差集；再在 Node 里令 `globalThis.window = globalThis` 加载 `services/index.js`，逐个断言这些标识符运行时可解析。

其它约束：

- **Vue full build**：旧 `EntityInput` / `OptionRow` 用 `template: \`...\`` 字符串模板，需运行时编译器，`vite.config.mjs` 必须 `alias vue → vue/dist/vue.esm-bundler.js`，并显式定义 `__VUE_OPTIONS_API__` 等特性开关。
- **`publicDir: false`**：旧 `public/` 下也有同名 HTML，不关会被原样复制覆盖新入口。
- **`assetsDir: 'static'`**：避开 Vite 默认 `assets/` 与 Express `/assets`（内置模型目录）的路径语义重叠。
- **Node/SSR 可测试**：服务层所有顶层 `window` 用法都加 `typeof window !== 'undefined'` 守卫，顶层 `addEventListener('keydown'/'keyup'/'blur')` 同样守卫；THREE / Canvas 相关裸用法只留在函数体内，不影响模块加载。

---

## 6. 设备卡片（衔接 `DEVICE-CARD-DESIGN.md`）

插件可选 `cards(ctx)` 返回 **key 化 JSON**；服务层 `cards.js` 负责 resolve / 值映射 / wire / 兜底，UI 层只消费解析结果。

```
Pinia projectStore（房间→设备） → buildCard（服务层） → CardGroup 递归渲染
   → runAction → HA.callService → HA.on('change') 定点 rebuild
```

- **服务层** `cards.js`：`collectKeys` / `resolveKey` / `applyVars` / `resolveBound` / `controlValue` / `toServiceValue` / `wireAction` / `defaultCard` / `buildCard` / `runAction` / `SERVICE_RULES`。不 import Vue，纯逻辑可单测。
- **UI 层** `components/cards/`：`CardGroup`（自引用递归）/ `ToggleControl` / `RangeControl`（180ms 拖动节流）/ `SelectControl` / `CustomButton` / `DeviceCardPanel`。
- **字段组件族** `components/fields/`：`FieldRow` 按 `option.type` 分派到 5 个控件，统一 `emit('set', value)`。
- **精准订阅**：`collectKeys` 同时收集声明式 key、裸 `entity_id` 和 resolve 后的 `_eid`；面板按受影响实体定点 rebuild，不全量重渲；`HA.off()` 在卸载时解绑。
- **向后兼容**：插件没提供 `cards()` 时，`defaultCard` 用 `clickSpec` / `fieldsOf` / `SERVICE_RULES` 生成 baseline 卡，12 个内置插件零改动即可用。

---

## 7. 后端 Express 迁移

> ⚠️ 有意变更：推翻此前 home「Node 零依赖」约定（用户指定 Express）。运行时镜像需 `npm ci --omit=dev` 装 `express`。

- 旧 `server/index.js` 的 5 个 `handle*` 域函数迁为 `server/routes/*.js` 的原生 Express Router；**第一期的 `/api` 转发代理已删除**。
- 全部复用 `server/core.js` / `assets.js` / `plugins.js` / `catalog-import.js` / `atomic-dir.js`，零重复业务逻辑：包含 zip 二进制上传（`readRawBody`）、`X-Install-Key`、`?id=`、`X-Plugin-Id`、锚点局部合并、`house/size` 按楼层墙体现算。
- 未知 API 路径返回纯文本 `404 Not Found`（与旧站静态托管兜底逐字节一致，而不是 Express 默认 JSON）。
- 静态挂载顺序：`/assets`、`/custom` → `web-dist`（新前端优先）→ `public`（vendor / style.css / favicon 兜底）。
- `npm start` → `server/express-index.js`（默认 8077）；旧站保留 `npm run start:legacy`（默认 8078）。

---

## 8. 缓存、构建与 Docker

**三级缓存**（`server/cache-middleware.js`，复刻旧 `assets.js`）：

| 资源 | 策略 |
|---|---|
| `/api/*`、HTML | `no-store` |
| 带 `?v=` 的静态资源 | `public, max-age=31536000, immutable` |
| 其余静态资源 | `no-cache` + ETag（size-mtime）→ 命中返回 304 |

> 新站产物由 Vite 文件哈希控制缓存；旧站 `public/*.html` 的 `?v=N` 版本号约定仍只对旧站生效。

**Dockerfile 三阶段**：`minify`（旧静态压缩）→ `frontend`（`npm ci` + `npm run build` 产出 `web-dist/`）→ 运行层（`npm ci --omit=dev`，复制 `web-dist/`、`server/`、`public/`、`assets/`）；`CMD ["node", "server/express-index.js"]`，容器 `PORT=8099` 由 compose 指定。

---

## 9. 关键技术决策（全部已拍板）

| 项 | 决策 | 理由 |
|---|---|---|
| 后端 | Express | 用户指定 |
| 语言 | 仍用 JS，不引入 TS | 8 个服务模块 + 12 个插件全是 JS，可零改造迁入；TS 留作渐进增量 |
| 页面形态 | MPA 双入口 | 与现有物理结构一致，展示页不背 2D 编辑器 |
| 插件加载 | **保留经典 `<script>` 注入 + `window` 桥接**，不改 ESM 动态 import | 保持 `PLUGIN-DEV.md` 与 skill 生态契约；改契约会破坏已发布插件 |
| 状态管理 | Pinia 只放 UI/项目态；服务层不响应式 | WS 高频 `change` 与 rAF 循环不能进深响应式 |
| Vue 构建 | full build alias | 旧字符串模板组件需运行时编译器 |
| 缓存 | 三级策略原样复刻 | 旧站与新站行为一致，方便对比回归 |
| 回退 | 旧站 `public/` + `server/index.js` 原样保留 | 随时 `npm run start:legacy` 对比 / 回退 |

---

## 10. 实施路线（分期，全部完成）

| 期 | 内容 | 状态 |
|---|---|---|
| 1 | Vite + Vue3 + Pinia 双入口脚手架；Express 骨架；三级缓存；旧站零改动并行 | ✅ |
| 2 | 8 个经典脚本搬入服务层并 ESM 化；`window` 桥接；`serviceGlobals` 注入 | ✅ |
| 3 | 卡片控件族 + 编辑器字段组件族（组件化收益点） | ✅ |
| 4 | `Viewer3D` / `Editor2D` 包装组件（THREE / Canvas `markRaw`） | ✅ |
| 5 | Express 五个 API 域原生迁移；删代理；切换 `start` / Dockerfile CMD | ✅ |
| 6 | Pinia 接 `/api/project`（`ui` / `project` store，`shallowRef` 户型） | ✅ |
| 7 | 双页面接入真实 SFC + 设备卡片两页复用 + 完整验证与文档回填 | ✅ |

第一期采用**增量并行**策略（旧站零改动、Express 独立 8097 并行），第 5 期完成全部 API 域后切换默认入口；旧站至此仅作回退。

---

## 11. 完整版验证结果

> 合计 **153 项断言全部通过**（单元/契约 53 + 运行时 44 + 写接口/二进制 24 + 编辑页空白事故复盘 32），另有 `npm run build` 与 `node --check` 通过。前 121 项是完整版交付时的验证；最后 32 项见 §11.6。

### 11.1 构建与语法

| 项 | 结果 |
|---|---|
| `node --check src/services/*.js` | 全部通过 |
| `npm run build` | **59 modules**，`web-dist/index.html` 2.76 kB、`display.html` 9.22 kB、`static/bootstrap-*.css` 3.51 kB、`display-*.js` 12.85 kB、`editor-*.js` 77.16 kB、`bootstrap-*.js` 288.43 kB（gzip 105.26 kB） |
| 构建告警 | `<script src="/vendor/...">` 不带 `type="module"` 无法打包、`/style.css?v=12` 构建期不存在 —— 二者设计上由 Express `public/` 静态托管于运行时提供，**属预期**，不阻塞构建 |

### 11.2 单元 / 契约验证（53 项，全部通过）

- 服务层在**无 `window` 的 Node/SSR 环境**可加载；16 个关键导出齐全；不导出 Vue 响应式 API。
- 真实插件 `assets/plugins/light/plugin.js` 以经典脚本方式执行成功 → `PluginEngine.defFor('light')` 可查，`model3d` / `styles` / `fields` 契约保留；`window.PluginEngine` 与 ESM 导出是同一对象。
- `HA.on/off` 成对可用，`off` 能真正移除监听。
- 卡片引擎：`collectKeys` / `resolveKey` / `applyVars` / `resolveBound`（`attr:`）/ `controlValue` / `toServiceValue`（50 → 128）/ `wireAction`（toggle、range、无 key 自定义服务）/ `runAction` / `buildCard`（嵌套 group、动态边界、select options、只读读数、裸 entity_id、变量注入）/ `defaultCard` 兜底 / `cards()` 抛错自动降级。
- **插件契约未变的旁证**：`public/js/*.js` 与 `src/services/*.js` 逐文件 diff 仅 6～43 行，全部是末尾 `window` 桥接 / ESM 导出、`typeof window` 守卫与 `HA.on/emit/off` 健壮性加固；其中 `plugins.js → plugin-engine.js` 主体逐行一致，12 个内置插件的 `register` / `click` / `fields` / `model3d` 契约没有改动。

### 11.3 运行时验证（44 项，全部通过）

- **API 逐字节一致**：`/api/version`、`/api/config`、`/api/project`、`/api/anchor`、`/api/catalog`、`/api/plugins`、`/api/install/config`、`/api/house/size`、`/api/refimg`、`/api/not-exist` 十个端点，新 Express(8077) 与旧站(8078) 的 status / content-type / body 完全一致；`/api/health` 因 `uptime`/`memMB` 动态，做字段形状对比通过。
- **缓存**：`?v=` immutable 一年；无 `v` → `no-cache` + ETag；带 `If-None-Match` → 304；API 与 HTML → `no-store`。
- **静态托管**：两个 HTML 命中新构建产物（hashed chunk 可访问），`#app` / `#display` 挂载点正确；`/vendor/three.min.js`、`/favicon.svg`、`/style.css` 从 `public/` 兜底。
- **Vite dev 5190**：双入口分别注入 `main-editor.js` / `main-display.js`；8 个 SFC / 服务模块编译可访问；`/api/version` 与 `/style.css` 经 proxy 通 Express 8077。
- **启动约定**：`package.json` 的 `main` / `start` 指向 Express、`start:legacy` 保留、`dev` / `build` 齐全；Dockerfile 的 CMD、frontend 阶段、`npm ci --omit=dev` 均核对通过。

### 11.4 写接口 / 二进制上传对比（24 项，全部通过）

为避免触碰用户真实 `data/` 与 `custom/`，两个服务都以 `HA3D_DATA_DIR` / `HA3D_CUSTOM_DIR` 指向 `/tmp` 下的隔离目录启动，同一份写请求分别打到 Express(8077) 与旧站(8078) 对比：

- **逐字节一致**：`POST /api/install/config`、`POST /api/config`、`PUT /api/anchor`、`POST /api/upload`（1×1 PNG base64）——响应与落盘后的 GET 都一致。
- **形状一致**：`POST` / `PUT /api/project` 的保存响应自带 `Date.now()` 时间戳，两次请求字节必然不同，改比 `saved: true` + `time: number`；落盘后 `GET /api/project` 逐字节一致。
- **二进制 zip**：用真实最小插件包（`plugin.json` + `plugin.js`）验证 `POST /api/plugins/install?id=...`（带 `X-Install-Key`）与 `POST /api/plugins/import`，两边安装成功、响应一致、安装后 `/api/plugins` 清单一致；无效 zip / 缺 id / 错密钥三种错误分支响应也逐字节一致。
- 验证结束确认项目真实 `data/project.json` 未被改动。

### 11.5 验证中发现并修复的实现问题

| # | 问题 | 修复 |
|---|---|---|
| 1 | `collectKeys` 只收声明式 key，扩展字段实体状态变化不会触发卡片刷新 | 同时收集 resolve 后的 `_eid` |
| 2 | `defaultCard` 直接调 `HA.getState(eid)`，遇到部分 stub / SSR 会抛错 | 加 `typeof HA.getState === 'function'` 守卫 |
| 3 | `buildCard` 对 range 初值做了两次 `scale` 换算（128 → 20 而非 50） | `_display` 直接取 `controlValue()` 的结果，并同步 `_value` |
| 4 | `button` / `custom` 未解析 `_eid`，只读读数按钮恒为 `—` 且 disabled | `BOUND_TYPES` 纳入解析 |
| 5 | 控件声明裸 `entity_id` 时未优先采用 | resolve 阶段裸 id 优先，再按 key 解析 |
| 6 | `HA.on(evt)` 对自定义事件名崩溃（`listeners[evt]` 未初始化） | `on` 自动初始化数组，`emit` 对未注册事件幂等 |
| 7 | `DeviceCardPanel` 只认 `entity_id` / `full`，漏掉 HA 的 `batch` / `demo` 整批事件 | handler 补齐 `full` / `batch` / `demo` 分支 |
| 8 | **编辑页 / 大屏页打开后画布空白**：`catalog.js` 的 `loadCatalog` / `fetchProject` 是顶层 `async function`，桥接生成器只收普通 `function` / `const`，两者没挂 `window`；页面 `<script>` 里是裸标识符调用（globalProperties 不生效），`init()` 首句 `await loadCatalog()` 即抛 `ReferenceError`，后续 `loadProject()` / `Editor.init()` / `HA.connect()` 全部未执行，连带 `Editor.fit()` 报 `null.width` | `src/services/catalog.js` 桥接块补 `window.loadCatalog` / `window.fetchProject`（并补 `FURN_ICON_H`），export 同步补齐；`src/services/index.js` 具名重导出补 `loadCatalog` / `fetchProject`；桥接注释写明「async function 也必须挂 window」 |

### 11.6 编辑页空白事故复盘验证（32 项，全部通过）

用户反馈编辑页除顶栏/工具栏外没有任何内容，控制台报 `ReferenceError: loadCatalog is not defined`。修复后补做：

- **AST 全量排查**：两个页面 SFC 的 `<script>` 共 26 + 7 个自由标识符，与 8 个服务模块的 `window.X =` 桥接集合求差集 → 修复前恰好缺 `loadCatalog` / `fetchProject`，修复后差集为空；纯 ESM 新模块（cards / bootstrap / system / version）的顶层声明不通过裸标识符访问，无需桥接。
- **模板编译检查**：`@vue/compiler-sfc` 编译后，编辑页 164 个、大屏页 24 个 `_ctx.xxx` 引用全部能由组件自身绑定或 `serviceGlobals` 提供，编译错误 0。
- **运行时全局验证**：Node 中令 `globalThis.window = globalThis` 加载 `services/index.js`，断言 26 个页面裸标识符在全局对象上均可解析；`loadCatalog()` 真实取回 23 个家具形态，`fetchProject()` 真实取回 2 层 / 10 面墙，`serializeProject()` / `floorFootprint()` 正常。
- **构建与产物**：`npm run build` 59 modules 通过；`web-dist/static/bootstrap-*.js` 含新桥接；Express 8077 首页已指向新 hashed chunk；Vite dev 5190 返回的 `/src/services/catalog.js` 已含 `window.loadCatalog` / `window.fetchProject`，`/api/project`、`/api/catalog` 代理均 200。

---

## 12. 启动方式与回退

```bash
npm install             # 首次：express / vue / pinia / vite
npm run build           # 构建到 web-dist/（改了 src/ 必须重跑）
npm start               # Express 8077（默认入口，打开 http://localhost:8077）

npm run dev             # Vite 5190，/api 代理到 8077（需后端已启动）
npm run start:legacy    # 旧站零依赖入口 8078，用于回归对比 / 回退
```

> `npm run dev` 默认绑 `localhost`，局域网访问用 `npm run dev -- --host 0.0.0.0`。
> 改 `server/` 需重启服务；改 `src/` 需 `npm run build`；旧站 `public/*.html` 的 `?v=N` 只对旧站生效。

---

## 13. 遗留与后续建议

- **双份代码**：`public/js/*.js` 与 `src/services/*.js` 并存，前者仅供 legacy 回退。确认不再需要回退后可删，届时同步清理 README 目录说明与 Dockerfile 的 `minify` 阶段。
- **插件加载**：仍为经典脚本注入；若将来改成 ESM 动态 import，需同步 `PLUGIN-DEV.md`、`ha3d-skill` 与所有已发布插件，成本高，建议维持现状。
- **卡片 schema**：`DEVICE-CARD-DESIGN.md` §「待拍板设计点」中的值映射规则已在 `SERVICE_RULES` / `scale` 落地；尚未给内置插件写 `cards()`，目前全部走 `defaultCard` baseline，可按插件逐个增补自定义卡。
- **TS / 路由库**：均未引入，当前规模下无需；若编辑页面板继续膨胀，再考虑局部组件拆分而非上路由。
- `src/ui/styles/` 是一个空目录（系统扩展属性导致无法 `rmdir`），git 不跟踪空目录，对构建与运行无影响。
