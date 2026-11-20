import './engine'; // 聚合引擎模块（含 window 桥接），须在挂载 EditApp 前执行
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import EditApp from './EditApp.vue';
import { installAppBridge, installHaBridge } from './bridge';
import { installApiAuthGuard } from './services/apiAuth';  // 我方 API 401 → 登录页（与 HA 鉴权无关）
import './style.css';
installApiAuthGuard();   // 须早于任何组件 init() 发 /api/ 请求；只装一次
/* 编辑页恒为浅色：不再做展示页那种「挂载前写 data-theme=dark」的首帧防闪。
   edit.html 的 <html data-page="edit"> + style.css 的 :not() 兜底 + lighting.js 的
   S.editPage 三重保证：夜间偏好不影响编辑页 UI，3D 场景光照也恒为白天基线。 */

/* Pinia 实例必须在任何 useStore() 之前挂上（mapWritableState 会在组件 computed 求值时调用）。
 * 编辑页与大屏页是两个独立文档、各自 createApp，因此这里是两份独立的 Pinia 实例；
 * 跨页数据同步仍由服务端 data/project.json 承担。 */
const pinia = createPinia();
const app = createApp(EditApp).use(pinia).use(ElementPlus, { locale: zhCn });

/* engine → Pinia 桥接必须在 mount 之前装好：mounted() 里的 init() 会初始化 Editor，
 * 而 Editor.select() / setZoom() 要靠 window.App.setSelection / updateZoomLabel
 * 把选中态与缩放值写回 store。缺了这一步，右侧属性栏会永远停在「楼层设置」。 */
installAppBridge(pinia);
installHaBridge(pinia);   // HA status/change → ha store，须早于 mounted() 的 init()
app.mount('#app');
