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
  CATALOG,
  FURNITURE_TYPES,
  isOtherFurnType,
} from '../model/catalog.js';

export const useCatalogStore = defineStore('catalog', {
  state: () => ({
    items: [],
    types: [],
    loaded: false,
    version: 0,
  }),

  getters: {
    /* 分类页签：全部 → 有形态的固定类型 → 其他（有 other/野值形态才显示）。
     * 与 model/furnitureTabs() 同口径，但这里从响应式 state 派生，无需版本信号。 */
    furnTabs: (s) => {
      const tabs = [{ key: 'all', label: '全部' }];
      s.types.forEach((c) => {
        if (c.type === 'other') return;
        if (s.items.some((f) => f.type === c.type)) tabs.push({ key: c.type, label: c.name });
      });
      if (s.items.some((f) => isOtherFurnType(f.type))) tabs.push({ key: 'other', label: '其他' });
      return tabs;
    },
    hasOther: (s) => s.items.some((f) => isOtherFurnType(f.type)),
  },

  actions: {
    /* 唯一的目录加载入口：fetch 与清洗在 model 层完成，这里同步给响应式投影。
     * App.vue / DisplayApp.vue 的 init() 改调本 Action；model/catalog.js 的符号由
     * engine/index.js 挂到 window，供动态插件与旧调用点按需使用。 */
    async loadCatalog() {
      const list = await fetchCatalog();
      this.items = list.slice();
      this.types = FURNITURE_TYPES.slice();
      this.loaded = true;
      this.version++;
      return list;
    },
  },
});

/* 便于调试：暴露 model 层的原始数据引用（不作为 store 状态）。 */
export function rawCatalog() { return CATALOG; }
