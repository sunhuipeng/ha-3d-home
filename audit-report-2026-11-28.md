# ha-3d-home 项目优化审视报告

生成时间：2026-11-28　范围：`server/`（12 文件约 2450 行）、`web/src/`（约 91 文件 19k 行）、`web/tests/` + `tests/`（12 文件约 1900 行）、README / PLUGIN-DEV / Docker / scripts / deploy。
方法：5 路并行深度扫描（后端逐文件通读 + 引擎/模型层 + 应用层 + 注释/文档核对 + 测试覆盖评审），高危项逐一实读源码复核。**本次只出报告，未改任何代码。**

## 摘要

| 类别 | 确认问题 | 其中高严重度 |
|---|---|---|
| 1. 死代码 | 15 | 0 |
| 2. 逻辑碎片/过度拆分 | 18 | 0 |
| 3. 架构/功能过度耦合 | 15 | 0 |
| 4. bug | 34 | 3 |
| 5. 注释描述不符 | 9 | 0 |
| 6. 文档描述不符/引用错误 | 2 | 0 |
| 7. 测试缺口 | 30 条新增用例清单 + 2 处既有测试缺陷 | — |

**复核状态**：标 ✅ 的条目已由主会话实读源码二次确认；标「待确认」的需按所附验证方式实测后定性。

**必须优先处理（P0）**：✅ 五项已于 2026-11-28 全部修复并回归（服务端测试 55/55、web 测试 116/116、前端 build 通过）：
- 4-后端.1　HA 媒体转发流无 error 监听 → **未处理异常可崩整个进程**（✅ 已修复：error 监听 + 客户端断开 cancel 上游流，异步拒绝一并吞掉）
- 4-引擎.1　three.js 贴图系统性泄漏：`disposeGroup` 从不 dispose 纹理（✅ 已修复：材质 dispose 时逐张贴图回收，原型共享贴图入共享集合不回收）
- 4-引擎.2　glowCache/emitterCache 误放 `_makeCtx()` 函数作用域（✅ 已修复：提升模块级，全引擎各 1 张）
- 4-应用.1　EditApp 弹窗开着时工具键/Delete 在背后生效（✅ 已修复：两个分支补 `!this.dialogOpen` 守卫）
- 4-应用.3　`window.__HA_DBG !== false` 默认恒真（✅ 已修复：改 `=== true`，plugins.js 注册告警同步统一口径）

---

## 1. 死代码（15 项）—— 全部清理 ✅（2026-11-28 第 6 项第 1 类）

> **2026-11-28 完成记录**：1.1 plainObj、1.2/1.3 COOKIE/enabled 收缩导出、1.4 autoBase/upstream 收缩导出、1.5 devicesOf（测试同步）、1.6 两常量、1.7 NARROW_MEDIA_QUERY、1.8 死变量 ux/uy、1.10 _loading 陷阱改为 _loadingKey 同参复用/异参重载、1.11 死导入、1.12 _stageNarrow、1.13 `node._cards` 回退、1.14 prefGetJSON/prefSetJSON（测试同步删 3 条用例）、1.15 HA.url/token/hasToken 镜像（loadConfig 写入同步删）均已删除或收缩。**1.9 实读 assets/plugins 复核为非死代码**：10 个内置插件真实消费 isOnState(1)/runningState(5)/fieldBits(11)/offsetOpts(1)/repeatOpt(4)/binaryRatio(12)，排除。

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 1.1 | server/shared.js:153 | `plainObj` 定义后全项目零调用（已 Grep 全仓验证） | 低 |
| 1.2 | server/auth.js:481 | 导出 `COOKIE` 无外部消费者（仅文件内使用） | 低 |
| 1.3 | server/auth.js:481 | 导出 `enabled` 无外部消费者（仅文件内使用） | 低 |
| 1.4 | server/automation-proxy.js:73 | 导出 `autoBase`/`upstream` 均仅文件内使用，测试走 HTTP 不 import | 低 |
| 1.5 | web/src/model/displayDerived.js:24-26 | `devicesOf(fl)` 一行转发，全 src 零调用 | 低 |
| 1.6 | web/src/model/historySeries.js:14-15 | `HISTORY_HOURS`/`HISTORY_TTL_MS` 零引用（useCardHistory 自定义 hours=24） | 低 |
| 1.7 | web/src/model/stageLayout.js:47-48 | `NARROW_MEDIA_QUERY` 注释称"CSS 4 处引用"，实际 CSS 无法 import JS 常量，零引用 | 低 |
| 1.8 | web/src/engine/view3d.js:1246-1247 | `buildWall` 内局部死变量 `ux/uy` | 低 |
| 1.9 | web/src/engine/plugins.js 契约面（待确认） | `isOnState`/`runningState`/`fieldBits`/`bgKit.offsetOpts`(注释自认旧版兼容)/`repeatOpt`/`ctx.binaryRatio` 等 src 内零引用，但可能被 window 端经典脚本插件消费——需查 assets/plugins 与 custom/plugins 后定性 | 低·待确认 |
| 1.10 | web/src/engine/plugins.js:198-199 | `loadAll` 的 `_loading` 永不重置：首次按需集加载后，后续任何全量 `loadAll()` 都返回第一次的 Promise（兼 4 类陷阱，当前每页只调一次未触发） | 低 |
| 1.11 | web/src/PanelApp.vue:64 | 死导入 `clampBand`、`jsGestureOf`（真实消费者在 stores/ui.js） | 低 |
| 1.12 | web/src/PanelApp.vue:973 | `_stageNarrow` 只写不读 | 低 |
| 1.13 | web/src/components/common/cards/CardView.vue:64 | `node._cards` 回退分支永不命中（engine/cards.js 只产出 `blocks`） | 低 |
| 1.14 | web/src/services/prefs.js:73-89 | `prefGetJSON`/`prefSetJSON` 零调用导出 | 低 |
| 1.15 | web/src/services/ha.js:29-31 | `HA.url`/`HA.token`/`HA.hasToken` 三份死镜像字段（stores/ha.js 用的是 loadConfig 返回值，非实例字段） | 低 |

排除项：three-legacy.js 仍被 view3d.js 与 engine/index.js 引用，**不是**死代码；stores/editor 的 HA 代理 getters、全部卡片组件、ui store 8 个 flyout 开关均有真实消费。

## 2. 逻辑碎片 / 过度拆分（18 项）—— 已全部收敛 ✅（2026-11-28 第 6 项第 2 类 + 前序轮次）

> **2026-11-28 完成记录**：2.1 haBase 收敛 shared.js 导出；2.2 sendJSON 别名转发删除（调用点同步）；2.3 installZipHandler 共用（/install 末尾调用、/import 直用）；2.4 返回值删零消费 ids；2.5 maskUpstream 统一抹上游地址；2.6 _floorBounds() 共用；2.7 orientedSnap 统一管道（三份 Point 收敛）；2.8 startDragEnd(wall, end)；2.9 model/bgId.js 唯一出处（plugins.js 委托、neededPlugins 删本地副本）；2.10 useStageBoot 统一 toRaw 注入；2.11 cards.js toNum→numOrNull；2.12 Esc 双注册删除（engine 先注册先执行，useEditorKeys 分支清理）；2.13 labelOffset 共享纯函数（3.11 轮完成）；2.14 CardPane 已无状态透传 + cardKey 统一 displayDerived.cardKeyOf；2.15 cardMixins.js（cardDisabled 五处 + cardRelay 四处，CardButton 内联改 :disabled="dis" 同口径）；2.16 services/devName.js 唯一出处（RoomsPanel/DevOrderPanel 收敛，补齐 itemDisplayName 回退漂移）；2.17 composables/useSceneMode.js 四段装配底座（toggleLabelsCore/applySceneCore/pickHi/refresh3dQuiet，补齐 PanelApp onHAChange 漂移的 try/catch）。

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 2.1 | server/config.js:21 vs ha-proxy.js:27 | `haBase()` 同逻辑两处定义，已现微差（一处 trim 一处不 trim） | 低 |
| 2.2 | server/shared.js:326 | `json()` 是 `sendJSON()` 的一行纯转发别名，全仓两套命名并存 | 低 |
| 2.3 | server/install.js:42-77 | `/plugins/install` 与 `/plugins/import` 两个 handler 主体逐字重复（差异仅密钥校验和 requireId） | 低 |
| 2.4 | server/library.js:420-425 | `installCatalogPackage` 返回值把同一数据投影三遍（items/ids/count） | 低 |
| 2.5 | server/ha-proxy.js:31-35 vs automation-proxy.js:45 | "错误消息抹上游地址"逻辑两处实现 | 低 |
| 2.6 | web/src/engine/editor.js:93-133 | `fit()` 与 `center()` 约 40 行仅差一句，逐字重复 | 中 |
| 2.7 | web/src/engine/editor.js:542-576 | `wallPoint`/`roomPoint`/`measurePoint` 三份几乎相同（仅基准点不同），可收敛 `orientedSnap()` | 中 |
| 2.8 | web/src/engine/editor.js:196-203,345-352 | 拖墙端点装配 + openings 重投影两处手抄 | 低 |
| 2.9 | web/src/engine/plugins.js:64 vs model/neededPlugins.js:27 | `BG_ID_ALIAS` 双份手工同步 + `migrateBgId`/`pluginIdOf` 两套同逻辑（漏同步会让旧项目背景解析失败） | 中 |
| 2.10 | composables/useStageBoot.js:159-161 vs EditApp.vue:640 | bgOptions/bgFields 注入策略两页不一致（深拷贝隔离 vs toRaw 直接引用），编辑页注入共享引用可绕过响应式 | 中 |
| 2.11 | engine/cards.js:116 vs plugins.js:1554 | `toNum` 同名不同义（一个认数值、一个排除 unknown） | 低 |
| 2.12 | engine/editor.js:1696 vs EditApp.vue:1254 | Esc 清标线两处注册（幂等不冲突，但同职责双路径） | 低 |
| 2.13 | EditApp.vue:231-243 vs SelectionInspector.vue:287-299 | `labelOffsetDefault`/`labelOffsetVal` computed 逐字重复，EditApp 副本仅被自身 wheelDevLabelOffset 消费 | 中 |
| 2.14 | PanelApp.vue:604-611 vs CardPreviewLayer.vue:52-59 | `onCardAct` 逐字重复；`cardKey` 双实现（displayDerived.cardKeyOf 与本地版等价） | 中 |
| 2.15 | 卡片组件五连抄 | `dis()` 在 CardRange/Choice/Toggle/Select/Button 五处同式；`relay()` 在 CardView/CardDevices/CardGroup/CardPane 四处重复 | 中 |
| 2.16 | RoomsPanel.vue:163 vs DevOrderPanel.vue:114 | `devName` 第 2、3 份实现（services/ha.js:545 注释已警告"别再发明第三种拼法"，fallback 链还不一致） | 低 |
| 2.17 | EditApp vs PanelApp 四段同源装配 | `toggleLabels`/`applySceneMode vs applyStageMode`/`watch sel → applyPickHi`/`onHAChange` 各两份且已漂移（PanelApp 的 onHAChange 无 try/catch），约 60 行可抽 `useSceneMode` | 中 |
| 2.18 ✅（2026-11-28：动作名单唯一出处 inspectorActs.js + :act props 注入——SI 删 20-emits 与 20 个转发壳、EditApp 模板 20 个 @ 收敛为 1 个 :act，新增输入框从改 4 处减到 2 处） | SelectionInspector.vue:175-181 | 20 个 emits 通道，EditApp 侧约 90 行"参数预设不同的转发壳"，新增输入框要同步改 4 处 | 中 |

## 3. 架构 / 功能过度耦合（15 项）

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 3.1 ✅（第一轮：zip 解析器已拆到 server/zip.js，余 891 行） | 单文件 5 块独立职能：静态托管+缓存 / 目录快照+底图 / 家具包安装 / 插件包安装+**手写 zip 解析器**（unzipEntries 是库级代码）/ 原子替换+卸载。zip 解析器是最明确的拆分线 | 中 |
| 3.2 ✅（第一轮：normProject/ELEM_CHECKS/checkOpening 已拆到 server/project-schema.js，余 225 行） | 自称"基础层"却内嵌约 150 行项目域校验（normProject/ELEM_CHECKS/checkOpening + 专用常量）+ config/installKey 状态仓，改项目校验规则要动"基础层" | 中 |
| 3.3 | 后端全局态 | 4 个模块共享 7 份隐式模块级可变状态（shared.config/installCfg/projectCache、library 四份缓存），安装动作隐式影响 catalog/plugins API 响应 | 中 |
| 3.4 | server/install.js:87 vs library.js:594 | `PLUGIN_ID_RE` 白名单校验执行两遍（防御性重复，口径注释只提一处） | 低 |
| 3.5 ✅（2026-11-28：view3d.setLightingGain(gain) setter 收敛 lighting 直写；plugins.js 删 v3.root.position.y 旧兜底，setHouseY 唯一入口；pick.onPick 实核已是唯一赋值点） | engine/view3d.js 单例 | View3D 全字段是跨模块通信总线：lighting.js 直写 lightingGain/setGridNight、plugins.js 直写 v3.root.position.y、pick.js 直写 onPick | 中 |
| 3.6 ✅（2026-11-28：view3d/plugins 头注补「生命周期契约」段，跨模块单例字段全部走显式 setter/入口） | 引擎模块级可变单例清单 | plugins（instances/defs/bgOptions…）、view3d（含惰性 Map）、editor（spaceHeld/shiftHeld + 永不移除的全局键监听）、tvFocus（cur/inited）、tapGesture（gestureState 双方直读直写）、catalog（可变 export let） | 中 |
| 3.7 ✅（2026-11-28：四模块 bind() 记录式监听 + dispose()/stopLoop() 出口 + services/ha.off + editor 具名键监听 disposeEditorKeys + tvFocus disposeTvFocus + disposeLighting，engine/index.js disposeEngine() 聚合，两页 beforeUnmount 接线） | 引擎生命周期不对称 | view3d/editor/lighting/tvFocus 四模块监听器只有注册没有卸载（engine/ 内 Grep removeEventListener 仅组件级 useTap 命中）；view3d 有 `startLoop` 无 `stopLoop`。MPA 页面级常驻现无实害，HMR/未来 SPA 化全变叠加泄漏（注释自述防 HMR 双监听，只挡入口没做出口） | 中 |
| 3.8 ✅（2026-11-28：register() 热刷新注销旧 def 实例（dead 标记 + dispose + instances 过滤）；loadAll 修 1.10 陷阱——_loadingKey 同参复用、异参重载） | engine/plugins.js:180-187 | `register()` 热刷新覆盖旧 def 不注销旧实例（开发期影响） | 低 |
| 3.9 ✅（2026-11-28：serializeProject/fetchProject/buildDefaultProject verbatim 搬到 model/projectIO.js（裸 PluginEngine 改 window.PluginEngine 保 Node 测试口径），catalog re-export 保 window 面与消费方兼容，catalog 558→约 300 行） | model/catalog.js（800 行） | 模型层混装项目序列化 IO（serializeProject/fetchProject 约 200 行），边界含糊 | 低 |
| 3.10 ✅（2026-11-28：SelectionInspector.vue window.* 全改 ESM import，仅剩 devStyleIcon/furnIcon 两个图标桥接消费；bgId 一族收敛 model/bgId.js） | engine/index.js:44 | `Object.assign(window, …)` 全量铺 window，ESM import 与 window 直调双轨消费并存（SelectionInspector.vue:409 直调 window.devStyleIcon） | 低 |
| 3.11 ✅（2026-11-28 第二轮全拆：7 个方法组 useNumEditing/useRefImage/useBackground/useRooms/useDeviceOrder/useEditorKeys/useFloors 摊进 methods，EditApp 1288→774 行（-514）；labelOffset 双份收敛消 2.13；20-emits 消 2.18。UI 层手动冒烟留给用户） | 上帝组件：script 约 1168 行 / 85 methods / 13 类职责。可抽：`useNumEditing`（205 行属性编辑家族+消 20-emits）、`useRefImage`（90 行）、`useBackground`、`useEditorKeys`、`useFloors`/`useRooms`/`useDeviceOrder` | 中 |
| 3.12 ✅（第二轮已拆：useStageCamera（取景 13 方法）/ usePanelGesture（手势 15 方法）摊进 methods，事件绑定留根组件，PanelApp 1153→602 行） | 上帝组件：script 约 1012 行。取景体系 287 行（`useStageCamera`）+ 手势体系 292 行（`usePanelGesture`）一次可搬走约 580 行 | 中 |
| 3.13 ✅（第一轮：演示模拟器已拆到 web/src/services/haDemo.js，余 507 行） | 传输客户端混 4 类职责：WS 传输/重连状态机 + **演示模式模拟器**（约 155 行 26 个假实体，可拆 haDemo.js）+ 业务判定层（isOn/deviceIsOn 依赖 PluginEngine，与"只负责连接"的自述不符）+ 历史缓存 | 中 |
| 3.14 ✅（2026-11-28：pickFurniture/pickEntity 双真相修复——`this.tool` 与 `Editor.tool` 一次写完，不走 setTool 避免 toggle 语义翻转；同步点加注释说明手工双写契约） | EditApp.vue 双真相 | `Editor.tool` 在 store 与引擎两处真相靠手工双写；pickFurniture(:609)/pickEntity(:686) 直接写引擎绕过 store（工具栏高亮漏亮风险），Esc 分支要逐个手清引擎游离态 | 中 |
| 3.15 ✅（2026-11-28：17 个选中项派生 getters 收敛进 editor store（服务层走 window.X + getter 内 void entVersion 显式建依赖，store 不 import engine 口径不变），SelectionInspector 改 mapState 直读、不再手写 void entVersion，EditApp labelOffset 两 computed 改 mapState） | 编辑面板组件 | 8 个组件部分派生直读 `window.HA/PluginEngine/deviceStyles` 靠 `void entVersion` 手动建依赖（10+ 处），可仿 catalog store 收敛进 ha store getter | 低 |

## 4. bug（34 项：3 高 / 9 中 / 22 低；含 8 项待确认）

### 服务端

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 4-后端.1 ✅ | server/ha-proxy.js:177 | `Readable.fromWeb(up.body).pipe(res)` 无 error 监听：HA 侧图片流中途出错 → uncaught exception → **整个进程崩溃**（try/catch 只覆盖 fetch 阶段）；且客户端断开时上游流不 cancel，HA 连接继续下载到完。修复：挂 stream error 监听 + `res.on('close', () => up.body.cancel())` | **高** |
| 4-后端.2 ✅ | server/auth.js:269-274 + library.js:770-787 | 页面门禁/静态托管路径大小写敏感，Windows/macOS 文件系统不敏感：未登录访问 `/EDIT.HTML` 绕过 guard 拿到 SPA 壳（`/api/*` 仍 401）。生产 Linux 镜像不受影响，开发机实际可复现。修法：guard/serveStatic 统一小写归一 | 中 |
| 4-后端.3 ✅ | server/install.js:49 | 安装密钥明文 `!==` 比较非 timing-safe（同体系 auth.js 特意用了 timingSafeEqual，标准不一致；该端点可匿名访问） | 低 |
| 4-后端.4 | server/auth.js:346,454（待确认） | login/qr-login 在 JSON body 回传明文 session token（注释称给 App 原生持久化用，浏览器忽略）——HttpOnly cookie 的 XSS 防线被响应体绕过。若 App 已改走 cookie 可删 | 低·待确认 |
| 4-后端.5 | server/ha-proxy.js:80-88（待确认） | WebSocket 构造后先挂只打日志的 error 监听，真正的 close/error 处理在 handleUpgrade 回调内——upstream 极速失败时事件丢失，已 101 的客户端 socket 无人关闭。窗口极小，需集成测试复现 | 低·待确认 |

### 引擎层

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 4-引擎.1 ✅ | web/src/engine/view3d.js:1884-1911 | `disposeGroup` 只 dispose geometry/material，**从不 dispose 纹理**（three.js material.dispose 不级联释放 texture）。背景插件 2048² CanvasTexture 每次防抖重放（:643）泄漏一张 ≈16MB GPU 内存；注释声称"换背景先释放上一份（几何+贴图）"与实现不符。长时间运行展示大屏内存持续增长 | **高** |
| 4-引擎.2 ✅ | web/src/engine/plugins.js:1205-1248 | `glowCache`/`emitterCache` 声明在 `_makeCtx()` **函数体内**，注释写"跨实例共享"实际每盏灯各建一套 256² 贴图——既没共享又因 4-引擎.1 永不回收。修法：提升到模块级 | 中 |
| 4-引擎.3 | web/src/engine/plugins.js:1617-1629,1679-1691 | `reset()` 置 dead 后 resolve 回调不 dispose 已构建 group（内存抖动）；`devicePlaceholder` 的 loadModel.then 无 dead 检查，重建后仍向已销毁 body add 旧 mesh（与 _spawn 防护口径不一致） | 中 |
| 4-引擎.4 | web/src/engine/view3d.js:1483-1489 | GLB 加载失败的 Promise 永久缓存进 `_gltfCache` 不重试：一次瞬时网络失败后该模型整个会话都是兜底盒 | 中 |
| 4-引擎.5 | web/src/engine/view3d.js:687-706（待确认） | `buildAsync` 与同步 `build` 无互斥：帧间隙再进同步 build 时两个 generator 交错拆建同一 scene。当前调用方不并发，属未引爆竞态 | 中·待确认 |
| 4-引擎.6 | web/src/model/catalog.js:665 | `wallOpacity: N(fl.wallOpacity) \|\| 45`：用户设 0（全透明）保存后被写成 45（同函数其他 `\|\|` 兜底中唯此合法域含 0） | 低 |
| 4-引擎.7 | web/src/engine/tvFocus.js:419 | debug 正则双反斜杠：`\?` 成"可选反斜杠"，`nodebug=1` 之类子串误命中（字节级 od -c 核实） | 低 |
| 4-引擎.8 | web/src/engine/editor.js:205 | 'wall' 工具分支 `this.floor.walls.find` 无判空（同文件其他 hitTest 均有 `!this.floor` 守卫），floor 未挂时 TypeError | 低 |
| 4-引擎.9 | web/src/engine/editor.js:1694-1696 | 全局 keydown 不过滤输入焦点：文本框按空格也置 spaceHeld（tvFocus 侧有 input/textarea/select 过滤，editor 侧没有） | 低 |
| 4-引擎.10 | web/src/engine/view3d.js:187-191 | mousemove 每次全场景双 raycast 无节流（大场景 hover 开销可观） | 低 |
| 4-引擎.11 | web/src/model/sceneRunner.js:160（待确认） | `callService` Promise 无超时：WS 半开悬挂时 busy 永久 true、磁贴永久转圈（低概率，心跳断链会先触发 catch） | 低·待确认 |
| 4-引擎.12 | web/src/engine/tvFocus.js:321-322,396-399（待确认） | "单列区"启发式会把任何竖排单列区域误判 vert 区（左右键直接跨区）；ok 键在元素暂时滚出视口时回落到"区域首个"再 confirm，可能点错目标 | 低·待确认 |
| 4-引擎.13 | web/src/composables/useCards.js:84 | 非 device 分支构造的最小 isOn 判定对象不含 style/styleOpts，依赖样式参数的插件顶层 isOn 误判（3D 标签路径传完整对象，两路径口径不一致） | 低 |

### 应用层

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 4-应用.1 ✅ | web/src/EditApp.vue:1235-1246 | 工具快捷键分支（`map[k] && !mod && mode==='2d'`）与 Delete/Backspace 分支缺 `!this.dialogOpen` 守卫（1231 行顶栏键分支有）：弹窗开着时按 v/h/r/w/d… 在背后切工具，按 Delete **删除选中对象**并压撤销栈。与 1206-1208 行自述口径矛盾 | 中 |
| 4-应用.2 | web/src/components/common/EntityInput.vue:43,94-99（待确认） | onInput emit trim 后值 → 父级回写 modelValue → watch 重置 text：尾随空格被吞，含空格实体名（"客厅 吸顶灯"）无法继续输入搜索，功能退化。建议实测 | 中·待确认 |
| 4-应用.3 ✅ | web/src/services/ha.js:155 | `window.__HA_DBG !== false` 默认 undefined → 恒真：生产每个 WS 事件 JSON 序列化 + console.log（645 实体场景每秒数十条），主线程持续开销。应为 `=== true` | 中 |
| 4-应用.4 | web/src/EditApp.vue（全组件） | 无 beforeUnmount：window keydown/beforeunload 监听 + 5 个定时器不清理（PanelApp 有完整清理，单侧遗漏；HMR/测试环境叠加） | 低 |
| 4-应用.5 | web/src/PanelApp.vue:265-284 | 窄屏切层 `_applyFloorAsync` 只有 try/finally 无 catch：rebuildAsync 抛错成 unhandled rejection，遮罩撤了但没切成功且零提示 | 低-中 |
| 4-应用.6 | web/src/EditApp.vue:1093-1109 | `applyBgImage` 的 img.onload 无失效守卫：加载期间 undo/redo 整份替换 project 后 meta 写到新项目（同文件 syncBg:1140 有守卫，不对称） | 低 |
| 4-应用.7 | DispCfgModal.vue:178-190（待确认） | `loadAutomation` 无竞态令牌：快速关/开弹窗并发 fetch，晚到的旧响应覆盖新 automationOptions（对比 useCardHistory 的 seq 范式） | 低·待确认 |
| 4-应用.8 | web/src/components/pages/editor/ConnModal.vue:116-123 | `testConn` 按钮无 disabled，可并发连点 | 低 |
| 4-应用.9 | web/src/PanelApp.vue:234-237 | 3D 初始化失败后 `slow && !stageReady` 占位动画（infinite CSS）永不撤，页面停留"看似在加载"的死态 | 低 |
| 4-应用.10 | web/src/services/ha.js:145-152（待确认） | `auth_invalid` 后静默降级演示模式：26 个假实体填充卡片/统计/场景条，TV 端易把假状态当真。可能是有意设计，建议演示模式加全局横幅 | 低·待确认 |
| 4-应用.11 | web/src/login.js:48,150,167 | QR 一次性 code 经 URL（location.search / qr.svg?text= / qr-status 轮询）泄漏到历史/日志/referer 面（一次性+短时效缓解，safeNext 已挡开放重定向） | 低 |
| 4-应用.12 ✅ | web/src/services/automation.js:31-33 ✅ | `safeSvgHtml` 两处绕过：① 事件属性正则要求引号，`onload=evil()`（无引号）不剥；② `<script>` 无闭合标签时不命中、脚本内容原样保留。来源是自家 automation 服务风险有限，但 sanitizer 应补齐（测试先行固化，见第 7 类） | 低-中 |

排除项（已复核不成立，避免误报）：后端 atomicDirReplace/saveRefImg 并发（全同步链天然串行）、serveStatic 路径穿越（decode→normalize→startsWith 兜底正确）、auth 会话/QR/锁定的定时器清理、collectBody 413；引擎 pluginCleanup 职责定位（运行时清理由 PluginEngine.reset 承担）、pick.js 与 editor 拾取（3D raycast vs 2D 离屏像素，非重复）、tapGesture vs panelGesture（点按 vs 滚动，非重复）、recode 合并/分叉逻辑、tvFocus ZONE_LINKS 邻接表、lighting tween；应用层认证链路（token 不落 localStorage、不进 URL、服务端代管，自洽）。

## 5. 注释描述不符（9 项）—— 全部修复 ✅（2026-11-28 第 4 轮）

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 5.1 ✅ | 分层注释列出的 `/api/anchor` 路由不存在（全仓仅此注释 1 处命中） | 低 |
| 5.2 ✅ | 注释引用已改名的 `push:image` 脚本（实际 image:nas/image:public） | 低 |
| 5.3 ✅ | "前端默认浏览器直连 HA WebSocket"与 ha-proxy.js"改为全代理"（2026-11-19 起 WS 走 /api/ha-ws）口径相反 | 中 |
| 5.4 ✅ | 头注仍写"连接 /api/websocket → auth 长期令牌"，正文 wsUrl() 已是 /api/ha-ws、token 字段自述废弃——头注与正文自相矛盾 | 中 |
| 5.5 ✅ | 注释引用不存在的 `server/catalog-import.js`（校验实际在 server/library.js） | 中 |
| 5.6 ✅ | :91 写"类型=代码固定枚举"，:17 与实际（运行时从 assets/catalog.json 下发）矛盾 | 低 |
| 5.7 ✅ | 注释引用错误路径 `js/recode.js`（实际 web/src/engine/recode.js） | 低 |
| 5.8 ✅ | `say()` 注释"生产模式默认静默"与实现相反：HA3D_LOG 未设置时默认**打印**，显式 0/false 才静默 | 低-中 |
| 5.9 ✅ | "真正敏感的 HA 令牌在项目数据里，只经 /api/* 暴露"是过期注释——令牌已收归服务端代管（ha-proxy.js:11-13），不再出现在任何下发行 | 低 |

其余核对一致项：library/auth/ha-proxy/install/automation-proxy 注释逐段吻合；plugins.js ftype 枚举与 catalog.json 实测一致；cards.js §2.9 引用存在；view3d/editor/stageLayout 数值注释抽查吻合；全仓 TODO/FIXME 零残留。

## 6. 文档描述不符 / 引用错误（2 项）—— 全部修复 ✅

| # | 位置 | 问题 | 严重度 |
|---|---|---|---|
| 6.1 ✅ | scripts/push-image.sh:7-8,36 | 注释与报错提示给 `npm run push:image:arm64/push:image:public`，package.json 实际是 `image:nas`/`image:public`——与 automation 项目同款问题（那边刚修，home 未同步） | 中 |
| 6.2 ✅ | "写入默认 project.json（示例户型）"实为**空户型**（仅结构骨架，floors/walls 全空） | 低 |

其余核对一致项：README 端口表/命令/14 个内置插件数/§3.1 布局数值全部相符；PLUGIN-DEV.md 章节引用一致；Dockerfile/compose 环境变量与 config.js 一致；web vite 代理 5190→8077 一致；seed config.json 结构一致。

## 7. 测试缺口评审 + 新增用例清单

### 7.0 现状评估

- 现有 12 个测试文件质量总体扎实（差分基准、假时钟、边界 ±1px 都有），`display-derived`/`panel-math`/`scene-runner`/`v-tap-directive` 尤其好。
- **零测试的重点模块**：服务端全部（仅 automation-proxy 有 1 个集成测试）——`shared.js`（normPathname 是 2026-11-20 修过真实路径绕过漏洞的地方，**无回归测试**）、`library.js`（手写 zip 解析器 + 路径穿越防护）、`auth.js`（登录/锁定/QR 链）；前端 `catalog.js`（serializeProject 是 project.json 的脏数据防线）、`prefs.js`、`apiAuth.js`、`recode.js`、`services/ha.js` 纯面（norm）。
- **既有测试缺陷 2 处**（均已修复）：
  - `web/tests/history-series.test.mjs:75` ✅ **恒真断言**：`assert.ok(...< 1e-9 || b.span > 10)` 对数据 10..20 恒真（span≈23.2），"8% 余量"口径实际没锁定，应拆两条精确断言；
  - `web/tests/pick.test.mjs:42-48` 与 `:82-87` 完全重复用例，删一处。

> **2026-11-28 完成记录**：第 7 类全部落地——P0 15 条（safeSvgHtml×2、normPathname、normProject、auth guard/login/token/QR×4、zip 穿越与卸载防护、静态穿越、ha.norm 三格式、ha-media 崩进程回归、config/install API）+ P1（catalog serializeProject/房间几何/cloneFloor、prefs 双进程、recode 合并窗/截断/裁剪、project API、automation-proxy 非 JSON/超时/兜底、shared-io、session 落盘）；流程统一（根 package.json test/test:web/test:all；注：Node 22 目录参数扫描不可用，test script 沿用 glob 形式由 node 内部展开）；两处既有测试缺陷修复。测试过程顺带发现并修复 1 个真 bug：`catalog.js floorFootprint` 对脏 walls 字符串 `|| 兜底` 放行后 .forEach 崩溃（脏数据防线自身崩溃），改 Array.isArray 守卫。最终：服务端 62/62、web 147/147、前端 build 通过。P2 5 条（锦上添花）未做，按需补充。

### 7.1 新增用例清单（P0=防 bug/安全回归，15 条）

| # | 目标 | 用例要点 | 放哪 |
|---|---|---|---|
| P0-1 | safeSvgHtml | 未加引号 `onload=evil()` 必须剥掉（**当前实现会失败**，先行固化缺陷，修复时改正则） | 补 web/tests/automation-display.test.mjs |
| P0-2 | safeSvgHtml | 未闭合 `<script>` 必须整段拒绝返回空 | 同上 |
| P0-3 | server/shared.js normPathname | `/%63ustom/…` 解码归一回归（2026-11-20 漏洞修复）、`..` 归一、`%5C`、非法编码不抛 | 新建 tests/shared-norm.test.mjs |
| P0-4 | server/shared.js normProject | 坏元素丢弃/字符串收数字/超限截断/wallOpacity=-1→45/height 收口等全字段校验 | tests/shared-project.test.mjs |
| P0-5 | auth guard（集成） | `/%63ustom` 编码绕过仍 401；/api/catalog GET 放行 POST 拦截；OPTIONS 放行 | tests/auth-guard.test.mjs |
| P0-6 | auth 登录（集成） | 成功写 HttpOnly cookie；错误 401；连续 5 次失败 → 429 锁定 | 同上 |
| P0-7 | auth token（集成） | X-HA3D-Token 与 Bearer 双通道过门禁；伪 token 401 needLogin | 同上 |
| P0-8 | auth QR 链（集成） | approve→login 一次性消费；未登录 approve 401；同 code 二次 login 400 | 同上 |
| P0-9 | library installPackage | 手写最小 zip（stored 条目辅助 ~40 行）测路径穿越（`../evil.js` 等 4 变体全 400 且不落盘）、zip bomb 限额 | tests/library-install.test.mjs |
| P0-10 | library uninstall | 目录名白名单 + 父目录双重防护：`../models`/`..`/`a/b`/`../../data` 全 400 | 同上 |
| P0-11 | 静态托管（集成） | `/%63ustom/../package.json`、`/custom/%2e%2e/…` 不泄漏文件内容 | 补 tests/auth-guard.test.mjs |
| P0-12 | services/ha.js norm | subscribe_entities 三种增量格式归一（+ 包装 diff / 精简 s / 属性 diff）——实体渲染数据入口 | web/tests/ha-norm.test.mjs（window shim） |
| P0-13 | server/ha-proxy 媒体路由 | 上游失败→502 且进程不崩（配合修 4-后端.1 写回归） | tests/ha-media.test.mjs |
| P0-14 | config API（集成） | GET /api/config 不下发 token 只给 hasToken；token 传数字回退旧值 | tests/config-api.test.mjs |
| P0-15 | install API（集成） | 未设密钥 401；错 key 401；`?id` 与 `X-Plugin-Id` 不一致 400；最小插件 zip 安装成功落盘 | tests/install-api.test.mjs（复用 zip 辅助） |

### 7.2 P1（补覆盖，10 条）

| # | 目标 | 用例要点 |
|---|---|---|
| P1-1 | catalog serializeProject | 白名单清洗/旧字段剥离/displayItems 校验/pts 取整/houseW 现算/bgImage.src 去 ?t= |
| P1-2 | catalog 房间几何 | roomArea 符号/共线退化/pointInRoomStrict 三态/贴边 tol |
| P1-3 | catalog cloneFloor | id 全换新且 roomId/displayItems eid 跟随映射、两层无重复 id |
| P1-4 | prefs.js | localStorage 坏 JSON/异常/未定义兜底 |
| P1-5 | recode.js | 600ms 合并窗口/redo 分叉截断/MAX=100 裁剪/pushView 同步 floorIdx/undo 深拷贝 |
| P1-6 | project API（集成） | 坏数据 400/house/size 现算 vs 回退 |
| P1-7 | automation-proxy 补 | 上游超时 502 且不泄漏上游地址；非 JSON 上游；actions 非数组兜底 |
| P1-8 | shared writeJSON/readBody | 原子写无 .tmp 残留/413/非法 JSON→null |
| P1-9 | sceneRunner run | ha 为 null 时明确失败且无定时器残留 |
| P1-10 | auth session 落盘（集成） | data/auth-sessions.json 格式与 logout 消失 |

### 7.3 P2（锦上添花，5 条）

furnIcon/furnSpec 兜底链；wxEmoji 和风分桶；useCardHistory seq 令牌竞争；HA isOn/unitOf/friendly 边界；apiAuth fetch 守卫（token 注入三形态 + 401 跳登录豁免）。

### 7.4 流程统一建议

1. 根 package.json **无 test script**，补：`"test": "node --test tests/"`、`"test:web": "npm test --prefix web"`、`"test:all"`。
2. `web/package.json` 的 `node --test tests/*.test.mjs` 在 Windows cmd 下 glob 不展开（潜在"跑不起来"隐患），改 `node --test tests/`。
3. zip 构造辅助抽 `tests/helpers/zip.cjs`（约 40 行，zlib 内置），P0-9/P0-15 共用。
4. 服务端测试文件必须在 require 服务端模块**之前**设 env（HA3D_DATA_DIR 等）——照抄根 automation-proxy.test.mjs 范式，可在 tests/ 放模板注释固化。
5. 修 7.0 的两处既有测试缺陷应与新增用例同一改动完成。

---

## 附：处理顺序建议

1. **P0 三高危**：4-后端.1（崩进程）、4-引擎.1（纹理泄漏）+ 4-引擎.2（一并修）、4-应用.3（一行修复）+ 4-应用.1（弹窗键泄漏）。
2. **安全回归** ✅：4-后端.2（大小写门禁）、4-应用.12（safeSvgHtml 补齐）+ P0 测试先行固化。（2026-11-28 完成：guard/serveStatic 小写归一 + auth-guard 新增 5 组大小写绕过用例；safeSvgHtml 补无引号/未闭合/连写三类绕过并循环剥至收敛 + 整体丢弃兜底，新增 6 组绕过固化用例）
3. **第 7 类** ✅：按清单补测试（P0 15 条 → P1 10 条），顺带修两处既有测试缺陷 + 根 package.json test script。（2026-11-28 完成：服务端 62/62、web 147/147；新 7 个测试文件 + automation-proxy 扩展；顺带修 catalog.js floorFootprint 脏 walls 崩溃真 bug）
4. **注释/文档** ✅（第 5、6 类，低风险文本修正）。（2026-11-28 完成：5.1-5.9 全修——index.js 去 /api/anchor 残引、shared.js/version.js 脚本名改 image:nas/image:public、config.js 与 ha.js 头注改全代理口径、catalog.js 改 library.js 引用与 types 枚举出处、EditApp.vue 改 recode.js 真实路径、entrypoint.sh say() 注释如实化 + project.json「空户型骨架」、auth.js 令牌注释改服务端代管；6.2 同轮修复）
5. **结构重构**（第 3 类大头）：library.js 拆分、shared.js 剥离 normProject、EditApp/PanelApp 抽 composable、services/ha.js 拆 haDemo——建议单独分轮，每轮跑全量测试 + 前端 build + 手动冒烟。（2026-11-28 第一轮完成：zip.js / project-schema.js / haDemo.js 三处拆分全绿；第二轮完成 EditApp 抽 composable：六个职责方法组拆到 composables/，labelOffset computed 双份收敛，EditApp 1288→857 行，新增 num-edit.test.mjs 13 条回归；同轮完成 PanelApp 抽 composable：useStageCamera / usePanelGesture 两体系搬走约 550 行，PanelApp 1153→602 行。web 160/160、服务端 62/62、build 通过。3.11/3.12 闭环：EditApp 七方法组 1288→774、PanelApp 1153→602、20-emits 消 2.18。2026-11-28 第三轮闭环 3.5-3.10/3.14/3.15 + 第 1、2 类全部清理（见各节完成记录），最终 web 157/157（prefs JSON 用例随死代码删除 3 条）、服务端 62/62、build 通过。剩：UI 手动冒烟）
6. **第 1、2 类**顺手清理。✅（2026-11-28 全部完成：第 1 类 15 项（1.9 复核排除）、第 2 类 18 项全收敛——详见第 1、2 节完成记录）
