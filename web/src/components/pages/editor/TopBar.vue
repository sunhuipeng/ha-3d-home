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
        <button :class="{active: mode === '2d'}" title="2D 编辑 (2)" @click="$emit('set-mode', '2d')">2D 编辑<i class="tb-kbd">2</i></button>
        <button :class="{active: mode === '3d'}" title="3D 展示 (3)" @click="$emit('set-mode', '3d')">3D 展示<i class="tb-kbd">3</i></button>
      </div>
      <button class="tb-btn" :class="{primary: showLabels}"
              title="显示标签：点标签执行动作、点设备查看卡片；隐藏标签：点设备执行动作 (L)"
              @click="$emit('toggle-labels')">🏷 标签<i class="tb-kbd">L</i></button>
      <button class="tb-btn" :class="{primary: showCards}" title="在画布右上角预览当前选中设备 / 门窗 / 房间的控制卡片 (K)" @click="$emit('toggle-cards')">🃏 卡片<i class="tb-kbd">K</i></button>
      <button class="tb-btn" title="长按 3D 画面可自定义旋转锚点；点此重置回房屋中心 (M)" @click="$emit('reset-anchor')">◎ 重置锚点<i class="tb-kbd">M</i></button>
      <button class="tb-btn" title="连接 Home Assistant：地址与长期令牌 (C)" @click="$emit('open-conn')">⛓ 连接<i class="tb-kbd">C</i></button>
      <button class="tb-btn primary" title="上传 zip 包：插件包（device/background）或家具包（catalog），同 id 覆盖升级 (I)" @click="$emit('open-import')">导入插件/包<i class="tb-kbd">I</i></button>
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

/* 夜间模式开关只在展示页（PanelHeader）保留：编辑页恒浅色，不需要这个入口。 */
export default {
  name: 'TopBar',
  computed: {
    ...mapState(useEditorStore, [
      'project', 'cur', 'floorIdx', 'mode', 'showLabels', 'showCards',
      'connClass', 'connText', 'canUndo', 'canRedo',
    ]),
  },
  emits: [
    'open-display', 'select-floor', 'add-floor',
    'undo', 'redo', 'set-mode', 'toggle-labels', 'toggle-cards',
    'reset-anchor', 'open-conn', 'open-import',
  ],
};
</script>
