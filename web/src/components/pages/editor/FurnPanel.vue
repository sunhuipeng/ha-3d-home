<template>
  <div id="furnPanel" class="flyout" v-show="open">
    <div class="flyout-head">家具 <button class="close" @click="$emit('close')">×</button></div>
    <div class="furn-cats">
      <button v-for="t in furnTabs" :key="t.key" :class="{active: t.key === 'all' ? !furnCat : furnCat === t.key}" @click="furnCat = (t.key === 'all' ? null : t.key)">{{ t.label }}</button>
    </div>
    <div class="furn-grid">
      <button class="furn-item" v-for="f in furnListByCat" :key="f.id" :class="{sel: ghostFurn === f.id}" @click="pickFurniture(f)">
        <i class="fz" v-if="f.custom">自定义</i>
        <!-- 插件家具标记（左上角）：条目来自 type:'furniture' 的插件造型，放置后进 floors.devices，
             与目录静态 GLB 家具（mid）区分开；「自定义」角标仍在右上角，两者可同时出现 -->
        <i class="fz fz-plugin" v-if="f.plugin">插件</i>
        <span v-html="cardIcon(f)"></span>
        <span class="fn">{{ f.name }}</span>
        <span class="fs">{{ f.plugin ? '插件 · 动态绘制' : f.w + ' × ' + f.d + (f.auto ? ' · 自动发现' : '') }}</span>
      </button>
    </div>
  </div>
</template>

<script>
/*
 * FurnPanel — 家具库浮层，批次 1 从 App.vue 拆出，全局状态化后零 props。
 *
 * 目录已 Pinia 化：allItems / furnTabs 直接 mapState 读 stores/catalog.js 的响应式
 * 投影，加载完自动刷新 —— 删掉了原来的 `window.furnitureTabs()` /
 * `window.allFurniture()` 与两处 `void version` 手动失效缓存的版本信号。
 * allItems = 目录静态家具（mid） + 插件动态家具（type:'furniture' 的造型，卡片左上角
 * 标「插件」）。两类只在这里合并展示，点选后由父级 pickFurniture 按 f.plugin 分流到
 * floors.furniture / floors.devices 两条数据路径。
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
    ...mapState(useCatalogStore, ['furnTabs', 'allItems']),
    /* 家具库 = 目录静态条目 + 插件动态造型（store 的 allItems 已合并，目录在前插件在后） */
    furnListByCat() {
      if (!this.furnCat) return this.allItems;
      if (this.furnCat === 'other') return this.allItems.filter((f) => isOtherFurnType(f.type));
      return this.allItems.filter((f) => f.type === this.furnCat);
    },
  },
  methods: {
    /* 卡片图标：目录条目走家具图标渲染（48 宽 viewBox 内拼图元）；
     * 插件造型的 icon 是 PluginEngine.ico() 生成的完整 <svg>（24×24），不能再套一层，
     * 直接交给 v-html —— 尺寸由 CSS `.furn-item svg` 统一缩放 */
    cardIcon(f) {
      return (f.plugin && /^<svg[\s>]/i.test(f.icon || '')) ? f.icon : renderFurnIcon(f);
    },
    pickFurniture(f) {
      this.ghostFurn = f.id;
      this.$emit('pick', f);
    },
  },
};
</script>
