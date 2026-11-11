<template>
  <div id="furnPanel" class="flyout" v-show="open">
    <div class="flyout-head">家具 <button class="close" @click="$emit('close')">×</button></div>
    <div class="furn-cats">
      <button v-for="t in furnTabs" :key="t.key" :class="{active: t.key === 'all' ? !furnCat : furnCat === t.key}" @click="furnCat = (t.key === 'all' ? null : t.key)">{{ t.label }}</button>
    </div>
    <div class="furn-grid">
      <button class="furn-item" v-for="f in furnListByCat" :key="f.id" :class="{sel: ghostFurn === f.id}" @click="pickFurniture(f)">
        <i class="fz" v-if="f.custom">自定义</i>
        <span v-html="furnIcon(f)"></span>
        <span class="fn">{{ f.name }}</span>
        <span class="fs">{{ f.w }} × {{ f.d }} {{ f.auto ? ' · 自动发现' : '' }}</span>
      </button>
    </div>
  </div>
</template>

<script>
/*
 * FurnPanel — 家具库浮层，批次 1 从 App.vue 拆出，全局状态化后零 props。
 *
 * 目录已 Pinia 化：items / furnTabs 直接 mapState 读 stores/catalog.js 的响应式
 * 投影，加载完自动刷新 —— 删掉了原来的 `window.furnitureTabs()` /
 * `window.allFurniture()` 与两处 `void version` 手动失效缓存的版本信号。
 * 纯函数（furnIcon / isOtherFurnType）改为从 model/catalog.js 显式 ESM import。
 * 分类页签、当前类别、选中高亮仍是这块 UI 自己的局部状态；open 从 ui store 直读。
 * 点选家具只负责高亮 + emit，真正设置 Editor.ghost / 提示由父级 pickFurniture(f) 完成。
 *
 * emits: close / pick(家具形态 f)
 */
import { mapState } from 'pinia';
import { useUiStore } from '../../../stores/ui';
import { useCatalogStore } from '../../../stores/catalog';
import { furnIcon as renderFurnIcon, isOtherFurnType } from '../../../model/catalog.js';

export default {
  name: 'FurnPanel',
  emits: ['close', 'pick'],
  data() {
    return {
      furnCat: null,      // 当前类别（null=全部）
      ghostFurn: null,    // 待放置家具的形态 id
    };
  },
  computed: {
    ...mapState(useUiStore, { open: 'furnOpen' }),
    ...mapState(useCatalogStore, ['furnTabs', 'items']),
    furnListByCat() {
      if (!this.furnCat) return this.items;
      if (this.furnCat === 'other') return this.items.filter((f) => isOtherFurnType(f.type));
      return this.items.filter((f) => f.type === this.furnCat);
    },
  },
  methods: {
    furnIcon(f) { return renderFurnIcon(f); },
    pickFurniture(f) {
      this.ghostFurn = f.id;
      this.$emit('pick', f);
    },
  },
};
</script>
