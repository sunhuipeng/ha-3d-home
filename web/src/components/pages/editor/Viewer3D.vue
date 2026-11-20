<template>
  <!-- 批次 4：3D 预览容器（引擎容器）。
       View3D.init('c3dWrap') 在 App.vue 的 init() 里按 id 拿到这个 div 并往里插
       renderer.domElement；setMode('3d') 会在 $nextTick 里 View3D.resize() + rebuild()。
       因此容器必须常驻：用 v-show 而非 v-if，隐藏时只是 display:none，切换到 3D
       后容器立刻有尺寸，resize 才能拿到正确的宽高。
       组件零 props：mode 由 mapState 从全局 store 直读。 -->
  <div id="c3dWrap" v-show="mode === '3d'"></div>
</template>

<script>
import { mapState } from 'pinia';
import { useEditorStore } from '../../../stores/editor';

export default {
  name: 'Viewer3D',
  computed: {
    ...mapState(useEditorStore, ['mode']),
  },
};
</script>
