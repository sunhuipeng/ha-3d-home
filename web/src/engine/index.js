/*
 * engine/index.js — 引擎聚合入口
 *
 * 把原本由后端 public/ 以「经典 <script> 全局」方式提供的共享模块，
 * 收敛成一份 ESM 依赖图：各模块用 import/export 互相引用（不再依赖全局变量）。
 *
 * 向下兼容桥接：把全部导出符号挂到 window，供运行时注入的动态插件、以及两页里
 * 仍按全局标识符使用的少量调用点（HA / Editor / PluginEngine 等）消费。
 * 另外单独挂一份 window.THREE（three 本体 + OrbitControls + GLTFLoader）—— 动态插件
 * 是经典脚本，拿不到 ESM import，内置插件大量直接写 `new THREE.Mesh(...)`。
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
import * as cards from './cards.js';

/* three 本体 + 两个常用扩展：只为了给 window 桥接供料，引擎内部一律用各自的 ESM import。
 * 动态插件是运行时注入的经典 <script>，作用域里没有 import，全靠 window.THREE
 * （内置插件如 climate / light / fan 大量直接写 THREE.BoxGeometry）。 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/* 渲染管线：把 three 0.160 拉回 r147 legacy 观感（ColorManagement 关闭 + 线性输出）。
 * 作为副作用在引擎聚合阶段就引入，保证任何 Color / CanvasTexture 创建前生效。 */
import './three-legacy.js';

/* 版本号已改为 Vite 编译期导入（src/version.js 读仓库根 package.json），
 * 不再由 engine 侧 fetch('/api/version') + MutationObserver 填充占位。 */
if (typeof window !== 'undefined') {
  /* window.THREE 必须是「可写副本」而不是 ESM namespace 本身：
   * namespace 对象是只读的，插件若往 THREE 上挂东西（自定义 GLB 分支等）会静默失败，
   * 反过来把 namespace 直接赋给 window 也会破坏 Rollup 的静态分析。
   * 插件契约里 window.THREE / window.PluginEngine / window.HA 三件套缺一不可。 */
  window.THREE = Object.assign({}, THREE, { OrbitControls, GLTFLoader });
  Object.assign(window, ha, catalog, recode, editor, view3d, plugins, cards);
}

/* hud.js 已删除：HUD 派生数据改由 composables/useHud.js 的 computed 提供，
 * 不再需要 window.HUD 全局；插件与外部脚本均不依赖这个符号。 */
