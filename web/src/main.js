import './engine'; // 聚合引擎模块（含 window 桥接），须在挂载 App 前执行
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import App from './App.vue';
import { installAppBridge, installHaBridge } from './bridge';
import './style.css';

/* Pinia 实例必须在任何 useStore() 之前挂上（mapWritableState 会在组件 computed 求值时调用）。
 * 编辑页与大屏页是两个独立文档、各自 createApp，因此这里是两份独立的 Pinia 实例；
 * 跨页数据同步仍由服务端 data/project.json 承担。 */
const pinia = createPinia();
const app = createApp(App).use(pinia).use(ElementPlus, { locale: zhCn });

/* engine → Pinia 桥接必须在 mount 之前装好：mounted() 里的 init() 会初始化 Editor，
 * 而 Editor.select() / setZoom() 要靠 window.App.setSelection / updateZoomLabel
 * 把选中态与缩放值写回 store。缺了这一步，右侧属性栏会永远停在「楼层设置」。 */
installAppBridge(pinia);
installHaBridge(pinia);   // HA status/change → ha store，须早于 mounted() 的 init()
app.mount('#app');
