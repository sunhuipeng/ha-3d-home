<template>
  <div id="backdropPanel" class="flyout" v-show="open">
    <div class="flyout-head">背景 <button class="close" @click="$emit('close')">×</button></div>
    <div class="bg-groups">
      <div class="bg-group" v-for="g in bgGroups" :key="g.plugin">
        <div class="bg-group-hd"><span class="hd-name">{{ g.name }}</span><i class="bz cus" v-if="g.custom">自定义</i></div>
        <div class="bg-grid">
          <button v-for="b in g.items" :key="b.id" :class="{active: styleId === b.id}" :title="b.name + (b.hz ? ' · 动态 ' + b.hz + 'Hz' : ' · 静态')" @click="$emit('select', b)">
            <span class="ic">{{ b.icon }}</span><span class="nm">{{ b.name }}</span><i class="bz" v-if="b.hz">动</i>
          </button>
        </div>
      </div>
      <div class="bg-group">
        <div class="bg-group-hd"><span class="hd-name">默认</span></div>
        <div class="bg-grid">
          <button :class="{active: !styleId}" title="无背景插件时使用纯色 + 网格" @click="$emit('select', null)">
            <span class="ic">▦</span><span class="nm">纯色 + 网格</span>
          </button>
        </div>
      </div>
      <div class="sp-tip" v-if="!bgGroups.length">未发现背景插件 · 把插件放到 assets/plugins/&lt;id&gt;/（kind: background）后重启即可出现在这里</div>
      <template v-else>
        <div class="sp-tip">「动」= 动态背景，由插件声明刷新率驱动；其余为静态，只在切换/尺寸变化时绘制一次。选中后到右侧「背景设置」面板调样式参数与实体绑定</div>
        <div class="sp-tip bg-live-tip">背景在 3D 演示模型中预览，选择即生效</div>
      </template>
    </div>
  </div>
</template>

<script>
/*
 * BackdropPicker — 背景插件选择浮层，批次 1 从 App.vue 拆出。
 *
 * 只做「列出插件分组 + 高亮当前样式 + 把选择抛出去」。
 * 切换背景要改 project.settings.background、重放插件场景、压撤销栈，仍由父级 setBackground 负责。
 * 关闭按钮原本是 setTool('select', true)（不只是收浮层，还要回到选择工具），由父级处理。
 *
 * open / version / styleId 分别从 ui store 与 editor store 直读（styleId 用共享 getter
 * bgStyle，原先是父级 computed），mapState 重命名后模板变量名不变，3 个 props 全部去掉。
 *
 * emits: close / select(背景条目 b，传 null 表示恢复默认纯色+网格)
 */
import { mapState } from 'pinia';
import { useUiStore } from '../../../stores/ui';
import { useEditorStore } from '../../../stores/editor';

export default {
  name: 'BackdropPicker',
  emits: ['close', 'select'],
  computed: {
    ...mapState(useUiStore, { open: 'backdropOpen' }),
    ...mapState(useEditorStore, { version: 'entVersion', styleId: 'bgStyle' }),
    bgGroups() {
      void this.version;
      return (window.PluginEngine && window.PluginEngine.ready)
        ? window.PluginEngine.backgroundGroups() : [];
    },
  },
};
</script>
