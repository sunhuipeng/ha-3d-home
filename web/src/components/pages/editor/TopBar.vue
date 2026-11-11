<template>
  <!-- 编辑页顶栏：状态全部由全局 store 直读（零 props），动作 emit 回根组件编排，
       组件内部不持有任何业务状态。根节点仍是 #topbar（全局 CSS 按 id 命中）。 -->
  <header id="topbar">
    <div class="tb-left">
      <div class="logo" style="cursor:pointer" title="点击打开展示大屏" @click="$emit('open-display')">🏠 <b>{{ project ? project.name : '…' }}</b></div>
      <div class="tb-sep"></div>
      <div class="floor-switch">
        <button v-for="(f, i) in project.floors" :key="f.id" :class="{active: i === floorIdx}" @click="$emit('select-floor', i)">{{ f.name }}</button>
        <button title="新增楼层" @click="$emit('add-floor')">＋</button>
      </div>
      <div class="tb-chip" v-if="cur">{{ cur.walls.length }} 面墙 · {{ cur.devices.length }} 台设备</div>
    </div>
    <div class="tb-center">
      <div class="conn-chip" :class="connClass"><span class="dot"></span><span>{{ connText }}</span></div>
    </div>
    <div class="tb-right">
      <button class="tb-btn" title="撤销 (Ctrl+Z)" :disabled="!canUndo" @click="$emit('undo')">↶ 撤销</button>
      <button class="tb-btn" title="重做 (Ctrl+Shift+Z / Ctrl+Y)" :disabled="!canRedo" @click="$emit('redo')">↷ 重做</button>
      <div class="view-switch">
        <button :class="{active: mode === '2d'}" @click="$emit('set-mode', '2d')">2D 编辑</button>
        <button :class="{active: mode === '3d'}" @click="$emit('set-mode', '3d')">3D 展示</button>
      </div>
      <button class="tb-btn" :class="{primary: showLabels}" title="显示/隐藏 3D 设备标签" @click="$emit('toggle-labels')">🏷 标签</button>
      <button class="tb-btn" title="长按 3D 画面可自定义旋转锚点；点此重置回房屋中心" @click="$emit('reset-anchor')">◎ 重置锚点</button>
      <button class="tb-btn" @click="$emit('open-conn')">⛓ 连接</button>
      <button class="tb-btn primary" title="上传 zip 包：插件包（device/background）或家具包（catalog），同 id 覆盖升级" @click="$emit('open-import')">导入插件/包</button>
    </div>
  </header>
</template>

<script>
/**
 * 状态全部从全局 store 直读（全局状态化后不再收任何 props）：
 *  - project / floorIdx / mode / showLabels：editor store 的原始 state
 *  - cur / connClass / connText / canUndo / canRedo：editor store 的共享 getters
 *    （前三个原是根组件 computed，后两个原是依赖 histVer 重算的根组件 methods）
 * 模板变量名保持不变（mapState 同名映射），所以一行模板都不用改。
 * 动作仍 emit 回根组件：它们要压撤销栈、$nextTick 后 resize 3D 容器、开弹窗，
 * 还被键盘快捷键与其它组件 emits 共用，属于根组件的编排职责。
 */
import { mapState } from 'pinia';
import { useEditorStore } from '../../../stores/editor';

export default {
  name: 'TopBar',
  computed: {
    ...mapState(useEditorStore, [
      'project', 'cur', 'floorIdx', 'mode', 'showLabels',
      'connClass', 'connText', 'canUndo', 'canRedo',
    ]),
  },
  emits: [
    'open-display', 'select-floor', 'add-floor',
    'undo', 'redo', 'set-mode', 'toggle-labels',
    'reset-anchor', 'open-conn', 'open-import',
  ],
};
</script>
