import './engine'; // 聚合引擎模块（含 window 桥接），须在挂载 DisplayApp 前执行

// import * as ThreeCore from 'three';
// import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// const THREE = Object.assign({}, ThreeCore);
// THREE.OrbitControls = OrbitControls;
// THREE.GLTFLoader = GLTFLoader;

import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import DisplayApp from './DisplayApp.vue';
import './style.css';

createApp(DisplayApp).use(ElementPlus, { locale: zhCn }).mount('#app');
