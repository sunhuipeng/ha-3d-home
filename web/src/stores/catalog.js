/*
 * stores/catalog.js — 家具目录的全局响应式投影（Pinia）
 *
 * 分层约定：
 *   model/catalog.js 持有「引擎要同步读」的非响应式目录数据（CATALOG.items /
 *   FURNITURE_TYPES），engine/editor.js / view3d.js 在绘制热路径里读它；
 *   本 store 持有同一份数据的响应式投影，供 Vue 组件消费。
 *   两者由本文件唯一的 loadCatalog() Action 一次写入，不会各自漂移。
 *
 * 为什么 model 那份不进 reactive state：furnSpec()/furnIcon()/furnitureTabs() 每帧
 * 被 2D 绘制与 3D 重建调用，若改成 useStore() getter 会把引擎绑到 Vue 生命周期；
 * 而且 CATALOG.items 是普通数组，整份 deep reactive 化没有收益。
 *
 * 收益：以前 loadCatalog() 改的是普通全局对象，加载完必须 bumpEntities() 手动
 * 让家具列表/页签重算，组件里还要 `void version` 兜着。现在 items/types 本身就是
 * 响应式 state，FurnPanel 直接读即可，那套版本信号在目录这一块可以删掉。
 */
import { defineStore } from 'pinia';
import {
  loadCatalog as fetchCatalog,
  pluginFurniture,
  FURNITURE_TYPES,
  isOtherFurnType,
} from '../model/catalog.js';

export const useCatalogStore = defineStore('catalog', {
  state: () => ({
    items: [],          // 目录静态家具（mid → GLB）
    pluginItems: [],    // 插件动态家具（type:'furniture' 的造型，放置后进 floors.devices）
    types: [],
  }),

  getters: {
    /* 家具库全量 = 静态条目 + 插件造型（目录在前，插件在后）。
     * 面板/筛选/搜索用这个；家具实例解析（furnSpec / 同类模型）仍只能走 CATALOG.items。 */
    allItems: (s) => s.items.concat(s.pluginItems),
    /* 分类页签：全部 → 有形态的固定类型 → 其他（有 other/野值形态才显示）。
     * 与 model/furnitureTabs() 同口径，但这里从响应式 state 派生，无需版本信号。 */
    furnTabs: (s) => {
      const tabs = [{ key: 'all', label: '全部' }];
      const all = s.items.concat(s.pluginItems);
      s.types.forEach((c) => {
        if (c.type === 'other') return;
        if (all.some((f) => f.type === c.type)) tabs.push({ key: c.type, label: c.name });
      });
      if (all.some((f) => isOtherFurnType(f.type))) tabs.push({ key: 'other', label: '其他' });
      return tabs;
    },
  },

  actions: {
    /* 唯一的目录加载入口：fetch 与清洗在 model 层完成，这里同步给响应式投影。
     * EditApp.vue / PanelApp.vue 的 init() 改调本 Action；model/catalog.js 的符号由
     * engine/index.js 挂到 window，供动态插件与旧调用点按需使用。 */
    async loadCatalog() {
      const list = await fetchCatalog();
      this.items = list.slice();
      this.types = FURNITURE_TYPES.slice();
      /* 目录与插件是两条独立的加载链：这里先抓一次（LoadAll 已完成时立刻有值），
       * 正常时序下 App init 会在 PluginEngine.loadAll() 之后再调 refreshPlugins() 补一次 */
      this.refreshPlugins();
      return list;
    },

    /* 插件家具造型的响应式投影：PluginEngine 是非响应式服务层，只能在「插件注册完成」
     * 这个时点显式同步一次（EditApp.vue init: await loadAll() → refreshPlugins()）。
     * 造型的 ftype 由引擎归一化透传，这里再按 model 的枚举口径归一到家具分类。 */
    refreshPlugins() {
      this.pluginItems = pluginFurniture();
    },
  },
});
