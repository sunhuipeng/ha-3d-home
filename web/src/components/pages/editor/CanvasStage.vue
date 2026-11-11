<template>
  <!-- 批次 4：编辑页画布区容器。DOM 结构（#canvasWrap / #tooltip / #zoomBar /
       #houseBadge / #statusBar）与拆分前的 App.vue 逐字一致，全局 style.css 仍按 id 命中，
       因此这里刻意不加 scoped。两个引擎容器拆成 Editor2D / Viewer3D，均用 v-show 常驻。

       全局状态口径：mode / zoomPct / houseW / houseD / savedState 从 editor store 直读，
       tooltip 三件套从 ui store 直读，零 props；缩放换算走 Action setZoomFromPpm()。
       只有「压视图撤销栈」需要根组件的 Recode 编排，才 emit('view-dirty') 回去。 -->
  <main id="canvasWrap">
    <editor-2d />
    <viewer-3d />

    <!-- 3D 预览提示（大屏 HUD 在 /display 页面） -->
    <div id="tooltip" :class="{hidden: !tooltipShow}" :style="tooltipStyle">{{ tooltipMsg }}</div>

    <div id="zoomBar" v-show="mode === '2d'">
      <button @click="zoomStep(1 / 1.2)">−</button>
      <span id="zoomVal">{{ zoomPct }}%</span>
      <button @click="zoomStep(1.2)">＋</button>
      <button @click="zoomCenter" title="居中">⌖</button>
      <button @click="zoomFit" title="适应">⤢</button>
    </div>
    <!-- 本层户型长宽（米，跟随当前楼层）：studio 背景占位盒取「各层最大尺寸」，保存时落盘 -->
    <div id="houseBadge" v-show="mode === '2d' && houseW > 0"
      :title="'本层户型 ' + houseW + ' × ' + houseD + ' 米；studio 背景占位盒参考各层最大尺寸'">
       {{ houseW }} × {{ houseD }}
    </div>
    <div id="statusBar" v-show="mode === '2d'">
      <span>编辑模式</span>
      <span :class="{saved: savedState === '已保存'}">{{ savedState }}</span>
      <span>数据存储于 data 目录</span>
    </div>
  </main>
</template>

<script>
import { mapState, mapActions } from 'pinia';
import { useEditorStore } from '../../../stores/editor';
import { useUiStore } from '../../../stores/ui';
import Editor2D from './Editor2D.vue';
import Viewer3D from './Viewer3D.vue';

export default {
  name: 'CanvasStage',
  /* 必须用显式 kebab 键注册：Vue 的 hyphenate('Editor2D') 得到的是 'editor2-d'，
   * 与模板里惯用的 <editor-2d /> 对不上，组件会静默解析失败 —— SSR 只是 warn，
   * 浏览器里则连 canvas / div 都不渲染，Editor.init() 会拿到 null。 */
  components: { 'editor-2d': Editor2D, 'viewer-3d': Viewer3D },
  emits: ['view-dirty'],
  computed: {
    ...mapState(useEditorStore, ['mode', 'zoomPct', 'houseW', 'houseD', 'savedState']),
    ...mapState(useUiStore, ['tooltipMsg', 'tooltipShow', 'tooltipStyle']),
  },
  methods: {
    /* 缩放百分比换算下沉到 store Action：这里只把引擎的 ppm 传进去，
     * 不再重复 Math.round(Editor.ppm / 60 * 100)（原先 App.vue 里散写 4 处）。 */
    ...mapActions(useEditorStore, ['setZoomFromPpm']),
    zoomStep(f) {
      Editor.setZoom(Editor.ppm * f);
      this.setZoomFromPpm(Editor.ppm);
    },
    zoomFit() {
      Editor.fit();
      this.setZoomFromPpm(Editor.ppm);
      this.$emit('view-dirty');
    },
    zoomCenter() {
      Editor.center();
      this.$emit('view-dirty');
    },
  },
};
</script>
