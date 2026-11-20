<template>
  <!-- 右侧属性栏分支一：左侧「背景」工具激活时的专用面板（背景样式参数 + 实体绑定）。
       根节点为 fragment，#sidePanel 的 id 与全局 CSS 仍由父级持有，DOM 结构 1:1。 -->
  <div class="sp-title">背景设置</div>
  <!-- 3D 墙面（按楼层记忆）：从「楼层设置」迁入，和背景一起调最顺手 -->
  <div class="sp-sec"><h4>3D 墙面</h4>
    <div class="sp-row"><label>不透明度</label>
      <input type="range" min="0" max="100" step="5" :value="cur.wallOpacity != null ? cur.wallOpacity : 45" @input="setWallOpacity(parseFloat($event.target.value))">
      <input class="num-s" type="number" min="0" max="100" step="5" :value="cur.wallOpacity != null ? cur.wallOpacity : 45" @change="setWallOpacity(parseFloat($event.target.value))">
    </div>
    <div class="sp-tip">拖动实时预览；0 全透明，45 半透明可看见室内，100 不透明</div>
  </div>
  <div class="sp-sec" v-if="bgMeta">
    <h4>背景 · {{ bgMeta.icon }} {{ bgMeta.name }}</h4>
    <div class="bind-meta">
      <span class="bm" :title="bgMeta.plugin">{{ bgMeta.plugin }}</span>
      <span class="bm st" v-if="bgMeta.hz">动态 {{ bgMeta.hz }}Hz</span>
      <span class="bm" v-else>静态</span>
    </div>
    <div class="sp-row" v-for="o in bgOptionList" :key="o.key">
      <label>{{ o.label }}</label>
      <option-row :o="o" @set="setBgOpt"></option-row>
    </div>
    <div class="sp-tip">{{ bgMeta.hz ? '动态背景：引擎按 ' + bgMeta.hz + 'Hz 节流刷新，改参数即时重绘' : '静态背景：只在切换或房屋尺寸变化时绘制一次（零每帧开销）' }}</div>
    <div class="sp-tip">在左侧「背景」面板切换样式，选择即生效；离地高度可设为负值（低洼）</div>
  </div>
  <div class="sp-sec" v-else>
    <div class="sp-tip">当前是「纯色 + 网格」，没有背景插件参数。在左侧「背景」面板选一个样式后，样式参数与实体绑定会出现在这里。</div>
  </div>
  <div class="sp-sec" v-if="bgFieldList.length"><h4>背景 · 实体绑定</h4>
    <div class="sp-field" v-for="f in bgFieldList" :key="'bf-' + f.key">
      <div class="sp-field-hd">
        <label>{{ f.label || f.key }}</label>
        <span class="sp-val" :class="{bound: f.value}">{{ f.value || '未绑定' }}</span>
        <button v-if="f.value" type="button" class="sp-clear" title="解除绑定" @click="setBgField(f.key, '')">✕</button>
      </div>
      <entity-input :placeholder="f.placeholder || 'entity.xxx'" :domains="f.domains || null" :model-value="f.value" @update:model-value="setBgField(f.key, $event)"></entity-input>
      <div class="sp-tip" v-if="f.tip">{{ f.tip }}</div>
    </div>
    <div class="sp-tip">绑定的实体状态变化时自动回调插件顶层 onData(fields, api)；静态背景也能响应。未绑定或暂无数据时由插件自己回退</div>
  </div>
</template>

<script>
/*
 * BackdropPanel — 右侧「背景设置」分支，批次 3 从 App.vue 拆出。
 *
 * 状态全部来自全局 store（useEditorStore），零 props：
 *  - entVersion / bgTick：原始 state，作为非响应式服务层目录的重算信号
 *  - cur / bgStyle：共享 getters（原先本组件与 App.vue 各算一份，现收敛到 store）
 *  - bgMeta / bgOptionList / bgFieldList：本分支独有的派生数据，仍在组件内从
 *    window.PluginEngine 服务层算，靠 void entVersion / void bgTick 触发重算
 *
 * 动作一律 emit 回根组件：setWallOpacity 要 commit()，setBgOpt 要防抖重绘背景，
 * setBgField 要 notifyBackgroundData() —— 这些编排职责仍归根组件。
 * 组件内的同名 method 只是薄转发，因此模板与原 App.vue 逐字一致。
 */
import { mapState } from 'pinia';
import { useEditorStore } from '../../../stores/editor';
import OptionRow from '../../common/OptionRow.vue';
import EntityInput from '../../common/EntityInput.vue';

export default {
  name: 'BackdropPanel',
  components: { OptionRow, EntityInput },
  emits: ['set-wall-opacity', 'set-bg-opt', 'set-bg-field'],
  computed: {
    ...mapState(useEditorStore, ['entVersion', 'bgTick', 'cur', 'bgStyle']),
    bgMeta() {
      void this.entVersion;
      void this.bgTick;
      if (!this.bgStyle || !window.PluginEngine || !PluginEngine.ready) return null;
      const b = PluginEngine.backgroundOf(this.bgStyle);
      if (!b) return null;
      return { name: b.name, icon: b.icon, plugin: b.group, hz: b.hz || 0 };
    },
    /* 当前背景可配置参数（插件声明 options schema，值 = 默认值 ∪ 已保存值） */
    bgOptionList() {
      void this.entVersion;
      void this.bgTick;
      if (!this.bgStyle || !window.PluginEngine || !PluginEngine.ready) return [];
      const schema = PluginEngine.normalizeOptions(PluginEngine.optionsSchema(this.bgStyle));
      if (!schema.length) return [];
      const saved = (PluginEngine.bgOptions && PluginEngine.bgOptions[this.bgStyle]) || {};
      return schema.map((o) => Object.assign({}, o, {
        value: saved[o.key] != null && saved[o.key] !== '' ? saved[o.key] : o.def,
      }));
    },
    /* 动态实体字段绑定区（def.fields 声明；值存 settings.backgroundFields）。
     * 绑定按插件共用一份：同一插件下切换具体样式不会丢失已绑实体。 */
    bgFieldList() {
      void this.entVersion;
      void this.bgTick;
      if (!this.bgStyle || !window.PluginEngine || !PluginEngine.ready) return [];
      const bd = PluginEngine.backgroundOf(this.bgStyle);
      if (!bd || !Array.isArray(bd.fields) || !bd.fields.length) return [];
      const saved = PluginEngine.bgBindings(this.bgStyle);
      return bd.fields.filter((f) => f && f.key).map((f) => Object.assign({}, f, {
        value: saved[f.key] || '',
      }));
    },
  },
  methods: {
    setWallOpacity(v) { this.$emit('set-wall-opacity', v); },
    setBgOpt(key, val) { this.$emit('set-bg-opt', key, val); },
    setBgField(key, val) { this.$emit('set-bg-field', key, val); },
  },
};
</script>
