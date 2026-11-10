/*
 * engine/index.js — 引擎聚合入口
 *
 * 把原本由后端 public/ 以「经典 <script> 全局」方式提供的共享模块，
 * 收敛成一份 ESM 依赖图：各模块用 import/export 互相引用（不再依赖全局变量）。
 *
 * 向下兼容桥接：仍把全部导出符号挂到 window，供尚未改为 import 的 App.vue（编辑器）消费。
 * 后续把 App.vue 也改成 `import { ... } from './engine'` 后，可删除下面的 window 桥接。
 */
import * as THREE from 'three';
// import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// const THREE = Object.assign({}, ThreeCore);
// THREE.OrbitControls = OrbitControls;
// THREE.GLTFLoader = GLTFLoader;

import * as ha from './ha.js';
import * as hud from './hud.js';
import * as catalog from './catalog.js';
import * as recode from './recode.js';
import * as editor from './editor.js';
import * as view3d from './view3d.js';
import * as plugins from './plugins.js';
import './version.js'; // 副作用：读取 /api/version 并填充页面占位

if (typeof window !== 'undefined') {
  window.THREE = THREE;
  Object.assign(window, ha, hud, catalog, recode, editor, view3d, plugins);
}

export { ha, hud, catalog, recode, editor, view3d, plugins };
