/* 展示页唯一入口（index.html 专用）：固定挂载 PanelApp。
 *
 * 2026-11-15 起不再按设备 / URL 参数分发：PC、手机、平板、空壳 App 一律是
 * PanelApp，由组件自身用 wide 断点适配窄屏单列（3D 预览 + 楼层 + 场景 + 房间 +
 * 卡片）与 ≥1024px 的左侧 3D + 右侧 340px 竖栏。原 PC 展板 DisplayApp.vue 已下线。
 *
 * 实现说明：先建 Pinia、装桥接（须早于 mount，且 window.App.toast 用闭包延迟读
 * vm，页面组件提供 toastMsg），再挂载。Element Plus 只有 edit.html 的编辑器用，
 * 这里不再动态加载，展示页不再背这份体积。 */

import './engine'; // 聚合引擎模块（含 window 桥接），须在挂载任何根组件前执行
import { initTvFocus } from './engine/tvFocus';   // TV 遥控焦点导航（App 内或 ?tv=1 才激活）
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { installAppBridge, installHaBridge } from './bridge';
import './style.css';
/* 首帧防闪：style.css 已注入，挂载前先把夜间主题写上（走 prefs 唯一入口，不裸写
   localStorage）。3D 光照与房间亮度的完整初始化在 useStageBoot 里做。 */
import { PREF_KEYS, prefBool } from './services/prefs';
import { installApiAuthGuard } from './services/apiAuth';  // 我方 API 401 → 登录页（与 HA 鉴权无关）
installApiAuthGuard();   // 须早于任何组件 init() 发 /api/ 请求；只装一次
if (prefBool(PREF_KEYS.nightMode, false)) document.documentElement.setAttribute('data-theme', 'dark');
/* MDI 图标字体（HA 实体 attributes.icon 的渲染底座，见 services/haIcon.js）：
 * 场景磁贴 / 场景列表用。woff2 约 400KB，随 bundle 离线分发；只在本页引入，
 * 编辑页不出实体图标，不背这份体积。 */
import '@mdi/font/css/materialdesignicons.min.css';
import PanelApp from './PanelApp.vue';

const pinia = createPinia();
let vm = null;
installAppBridge(pinia, { toast: (msg) => vm && vm.toastMsg(String(msg)) });
installHaBridge(pinia);   // HA status/change → ha store，须早于 mounted() 的 init()

/* 单页同步挂载，不再需要 async boot() / 顶层 await（Vite 默认 target 不含 TLA） */
vm = createApp(PanelApp).use(pinia).mount('#app');
initTvFocus();   // 挂载后打全局键盘/壳回调监听（.tv-clickable 由各指令/组件 mounted 打）
