import './engine'; // 聚合引擎模块（含 window 桥接），须在挂载 DisplayApp 前执行


import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import DisplayApp from './DisplayApp.vue';
import { installAppBridge, installHaBridge } from './bridge';
import './style.css';

/* 两个入口都挂 Pinia，保持基础设施一致。大屏页目前仍用组件本地状态（它只读展示，
 * 数据经 fetchProject() 从服务端取），但将来接入共享 store 时无需再改入口。 */
const pinia = createPinia();
const app = createApp(DisplayApp).use(pinia).use(ElementPlus, { locale: zhCn });
installAppBridge(pinia);
installHaBridge(pinia);
const vm = app.mount('#app');

/* 大屏页有自己的气泡提示（DisplayApp.toastMsg），覆盖 store 版 tooltip toast：
 * 编辑页的 tooltip DOM 只存在于编辑页，大屏页调它看不到任何反馈。
 * View3D 的设备控制成功/失败提示因此也能在大屏正常显示。 */
window.App.toast = (msg) => vm.toastMsg(String(msg));
