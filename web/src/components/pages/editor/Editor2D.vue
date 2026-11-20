<template>
  <!-- 批次 4：2D 户型图画布（引擎容器）。
       引擎 Editor.init(document.getElementById('c2d')) 在 App.vue 的 init() 里持有这个元素，
       因此它必须常驻 DOM —— 用 v-show（只改 display），绝不能改成 v-if，
       否则切换 2D/3D 时元素被销毁重建，Editor 里缓存的 canvas / 事件监听全部失效。
       组件零 props：mode / tool 由 mapState 从全局 store 直读。 -->
  <canvas id="c2d" v-show="mode === '2d'"></canvas>
</template>

<script>
import { mapState, mapActions } from 'pinia';
import { useEditorStore } from '../../../stores/editor';
import { useUiStore } from '../../../stores/ui';

export default {
  name: 'Editor2D',
  computed: {
    ...mapState(useEditorStore, ['mode', 'tool']),
  },
  methods: {
    ...mapActions(useUiStore, ['closeFlyout']),
    /* 原来绑在 App.vue init() 里的「点画布收起家具/设备浮层」。
     * 搬到组件自己身上后不再靠 document.getElementById 跨组件找 DOM，
     * 关闭动作直接走 ui store 的 Action。 */
    onCanvasDown() {
      if (this.tool === 'select') {
        this.closeFlyout('furn');
        this.closeFlyout('dev');
      }
    },
  },
  /* 子组件 mounted 早于 App.vue 的 mounted()，所以事件在 Editor.init() 之前就绑好，
   * 不影响引擎自身的鼠标监听（两者互不覆盖）。 */
  mounted() {
    this.$el.addEventListener('mousedown', this.onCanvasDown);
  },
  beforeUnmount() {
    this.$el.removeEventListener('mousedown', this.onCanvasDown);
  },
};
</script>
