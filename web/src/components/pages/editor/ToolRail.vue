<template>
  <!-- 编辑页左侧工具栏：统一状态机，tool 从全局 store 直读（不再用 prop）驱动高亮。
       点击只 emit 工具值，切换逻辑（可重复点击取消、2D/3D 联动、面板开合）仍在父级 setTool()。
       根节点仍是 #toolbar（全局 CSS 按 id 命中），data-key 保留给快捷键提示展示用。 -->
  <aside id="toolbar">
    <div class="tb-group">基础</div>
    <button class="tool" :class="{active: tool === 'select'}" data-key="V" @click="$emit('set-tool', 'select')"><svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L16 19l-3 1.5-3-6.5L5 17z" fill="currentColor"/></svg><span>选择</span><i>V</i></button>
    <button class="tool" :class="{active: tool === 'pan'}" data-key="H" @click="$emit('set-tool', 'pan')"><svg viewBox="0 0 24 24"><path d="M12 2l3 3h-2v5h5V8l3 3-3 3v-2h-5v5h2l-3 3-3-3h2v-5H6v2l-3-3 3-3v2h5V5H9z" fill="currentColor"/></svg><span>平移</span><i>H</i></button>
    <div class="tb-group">绘制</div>
    <button class="tool" :class="{active: tool === 'wall'}" data-key="W" @click="$emit('set-tool', 'wall')"><svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="3" fill="currentColor"/><rect x="3" y="14" width="4" height="4" fill="currentColor" opacity=".5"/><rect x="10" y="14" width="4" height="4" fill="currentColor" opacity=".5"/><rect x="17" y="14" width="4" height="4" fill="currentColor" opacity=".5"/></svg><span>墙体</span><i>W</i></button>
    <button class="tool" :class="{active: tool === 'door'}" data-key="D" @click="$emit('set-tool', 'door')"><svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="20" stroke="currentColor" stroke-width="2"/><line x1="6" y1="20" x2="6" y2="5" stroke="currentColor" stroke-width="2"/><path d="M6 5a15 15 0 0 1 15 15" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"/></svg><span>门</span><i>D</i></button>
    <button class="tool" :class="{active: tool === 'window'}" data-key="N" @click="$emit('set-tool', 'window')"><svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="9" x2="12" y2="15" stroke="currentColor" stroke-width="2"/></svg><span>窗</span><i>N</i></button>
    <div class="tb-group">放置</div>
    <button class="tool" :class="{active: tool === 'furniture'}" data-key="F" @click="$emit('set-tool', 'furniture')"><svg viewBox="0 0 24 24"><path d="M4 11V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="11" width="18" height="6" rx="1" fill="currentColor" opacity=".6"/></svg><span>家具</span><i>F</i></button>
    <button class="tool" :class="{active: tool === 'device'}" data-key="E" @click="$emit('set-tool', 'device')"><svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v3M9 3h6" stroke="currentColor" stroke-width="2" fill="none"/></svg><span>设备</span><i>E</i></button>
    <div class="tb-group">参考</div>
    <button class="tool" :class="{active: tool === 'bg'}" @click="$emit('set-tool', 'bg')"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="M4 18l5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>贴图</span><i>B</i></button>
    <button class="tool" :class="{active: tool === 'backdrop'}" data-key="G" @click="$emit('set-tool', 'backdrop')"><svg viewBox="0 0 24 24"><path d="M2 17h20" stroke="currentColor" stroke-width="2" fill="none"/><path d="M4 17l3-4 3 4M12 17l4-6 4 6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="6" r="2" fill="currentColor"/></svg><span>背景</span><i>G</i></button>
    <button class="tool danger sep" @click="$emit('reset-floor')"><svg viewBox="0 0 24 24"><path d="M12 4V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-8z" fill="currentColor"/></svg><span>重置本层</span></button>
  </aside>
</template>

<script>
import { mapState } from 'pinia';
import { useEditorStore } from '../../../stores/editor';

/* tool 从全局 store 直读（原来是一个 props），模板里的高亮表达式不变。
 * 点击仍只 emit 工具值：setTool() 要同时改 Editor.tool、清 ghost、开合 4 个浮层、
 * 联动 2D/3D，属于根组件的编排，不能收进 store。 */
export default {
  name: 'ToolRail',
  computed: {
    ...mapState(useEditorStore, ['tool']),
  },
  emits: ['set-tool', 'reset-floor'],
};
</script>
