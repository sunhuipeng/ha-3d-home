/*
 * engine/index.js — 引擎聚合入口
 *
 * 把原本由后端 public/ 以「经典 <script> 全局」方式提供的共享模块，
 * 收敛成一份 ESM 依赖图：各模块用 import/export 互相引用（不再依赖全局变量）。
 *
 * 向下兼容桥接：把全部导出符号挂到 window，供运行时注入的动态插件、以及两页里
 * 仍按全局标识符使用的少量调用点（HA / Editor / PluginEngine 等）消费。
 * 注意被聚合的 ha 与 catalog 分别来自 services/ 与 model/，不属于引擎实现。
 */

/* HA 客户端与目录数据都不属于引擎层：前者是 WebSocket 传输服务（services/），
 * 后者是无 Vue 依赖的领域模型（model/）。这里只负责把它们与其它引擎模块一起
 * 挂到 window，供运行时注入的动态插件和尚未改为 import 的调用点使用。 */
import * as ha from '../services/ha.js';
import * as catalog from '../model/catalog.js';
import * as recode from './recode.js';
import * as editor from './editor.js';
import * as view3d from './view3d.js';
import * as plugins from './plugins.js';

/* 渲染管线：把 three 0.160 拉回 r147 legacy 观感（ColorManagement 关闭 + 线性输出）。
 * 作为副作用在引擎聚合阶段就引入，保证任何 Color / CanvasTexture 创建前生效。 */
import './three-legacy.js';

/* 版本号已改为 Vite 编译期导入（src/version.js 读仓库根 package.json），
 * 不再由 engine 侧 fetch('/api/version') + MutationObserver 填充占位。 */
if (typeof window !== 'undefined') {
  Object.assign(window, ha, catalog, recode, editor, view3d, plugins);
}

/* hud.js 已删除：HUD 派生数据改由 composables/useHud.js 的 computed 提供，
 * 不再需要 window.HUD 全局；插件与外部脚本均不依赖这个符号。 */
export { ha, catalog, recode, editor, view3d, plugins };
