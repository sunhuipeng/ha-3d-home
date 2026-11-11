<template>
  <div id="bgPanel" class="flyout" v-show="open" style="width:240px">
    <div class="flyout-head">参考贴图 <button class="close" @click="$emit('close')">×</button></div>
    <div class="bg-ops">
      <button class="sp-btn" @click="pickBackground">📁 上传户型图…</button>
      <template v-if="info.has">
        <div class="bg-slider" v-show="!info.hidden">
          <label>贴图缩放（宽度）<b>{{ bgWidth }} m</b></label>
          <input type="range" min="2" max="40" step="0.5" :value="bgWidth" @input="$emit('scale', $event)">
        </div>
        <button class="sp-btn" @click="$emit('toggle')">{{ info.hidden ? '👁 显示贴图' : '🙈 隐藏贴图' }}</button>
        <button class="sp-btn warn" @click="$emit('clear')">🗑 删除贴图</button>
      </template>
      <div class="sp-tip" style="margin:2px 2px 0">上传户型图作为 2D 画布底图辅助描墙（默认置于原点、宽 10、半透明）。全楼层共用一张：服务器只存 data/refimg.* 一张图（重复上传自动覆盖），随项目持久化；画完户型图可删。</div>
    </div>
    <!-- 原模板里这个 input 是 #bgPanel 的兄弟节点；移进组件根内（display:none，定位/视觉无差异）。
         组件只负责 DOM 与上传请求，图片写回项目仍由根组件的 applyBgImage 统一处理。 -->
    <input type="file" ref="bgFile" accept="image/*" style="display:none" @change="onBgFile">
  </div>
</template>

<script>
/*
 * BgPanel — 参考贴图（2D 户型底图）浮层，批次 1 从 App.vue 拆出。
 *
 * 归属：
 *  - 组件内：文件选择框引用、上传请求 /api/upload
 *  - 全局 store：open 来自 ui store 的 bgOpen；info / bgWidth 来自 editor store 的
 *    bgInfo / bgW（mapState 重命名后模板变量名不变，因此去掉了 3 个 props）
 *  - toast 原先是 emit 回根组件，现在直接调 ui store 的 Action（少一层事件透传）
 *  - 父级保留：applyBgImage / writeBg / syncBg / toggleBg / onBgScale / clearBg
 *    —— 它们要改 Editor.backgroundImage、project.bgImage 并压撤销栈，且 syncBg 在
 *       楼层切换 / 载入 / 撤销恢复时被 setFloor() 调用，不能收进只在浮层里存在的组件。
 *
 * emits: close / uploaded({url,name}) / toggle / scale(Event) / clear
 */
import { mapState, mapActions } from 'pinia';
import { useUiStore } from '../../../stores/ui';
import { useEditorStore } from '../../../stores/editor';

export default {
  name: 'BgPanel',
  computed: {
    ...mapState(useUiStore, { open: 'bgOpen' }),
    ...mapState(useEditorStore, { info: 'bgInfo', bgWidth: 'bgW' }),
  },
  emits: ['close', 'uploaded', 'toggle', 'scale', 'clear'],
  methods: {
    ...mapActions(useUiStore, ['toast']),
    pickBackground() {
      // 打开系统文件选择框时保持贴图浮层可见（浏览器文件对话框不会触发页面事件）
      if (this.$refs.bgFile) this.$refs.bgFile.click();
    },
    onBgFile(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const rd = new FileReader();
      rd.onload = async () => {
        this.toast('贴图上传中…');
        try {
          const r = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name, data: rd.result }),
          });
          const j = await r.json();
          if (!r.ok || !j.url) throw new Error(j.error || ('HTTP ' + r.status));
          this.$emit('uploaded', { url: j.url, name: file.name });
          this.toast('参考底图已上传（全项目共用，重复上传自动覆盖）');
        } catch (err) {
          this.toast('上传失败: ' + err.message);
        }
      };
      rd.readAsDataURL(file);
    },
  },
};
</script>
