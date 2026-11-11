<template>
  <!-- 右侧属性栏分支二：未选中（或选中墙体，墙没有可编辑属性）时的楼层/项目设置。
       fragment 根节点，DOM 结构与原 App.vue 逐字一致。 -->
  <div class="sp-title">楼层设置</div>
  <div class="sp-sec"><h4>项目</h4>
    <div class="sp-row"><label>名称</label><input :value="project.name" @change="setProjectName($event.target.value)"></div>
  </div>
  <!-- 3D 墙面与背景插件的参数/实体绑定已迁到「背景设置」面板（左侧选中「背景」工具时出现） -->
  <div class="sp-sec"><h4>楼层</h4>
    <div class="sp-row"><label>名称</label><input :value="cur.name" @change="cur.name = $event.target.value"></div>
    <div class="sp-row"><label>层高</label><input type="number" step="0.1" min="2" max="6" :value="cur.height" @input="setFloorHeight($event.target.value, 'input')" @change="setFloorHeight($event.target.value, 'change')"></div>
    <div class="sp-btns">
      <button class="sp-btn" @click="addFloor">＋ 新楼层</button>
      <button class="sp-btn warn" :disabled="project.floors.length <= 1" @click="delFloor">删除本层</button>
    </div>
  </div>
  <div class="sp-sec"><h4>大屏左侧·数据卡片</h4>
    <div class="sp-row"><label>天气实体</label>
      <entity-input placeholder="weather.xxx（全局，所有楼层共用）" :model-value="project.settings.weatherEntity || ''" @update:model-value="setWeather($event)"></entity-input>
    </div>
    <div class="sp-tip" style="margin-bottom:4px">数据卡按楼层独立配置，大屏切换楼层时跟随显示</div>
    <div class="sp-row" v-for="(c, i) in dataCardRows" :key="'c' + i"><label>数据卡{{ i + 1 }}</label>
      <entity-input :model-value="c" @update:model-value="setCard(i, $event)"></entity-input>
      <button class="row-x" title="删除此卡" @click="removeCard(i)">×</button>
    </div>
    <div class="sp-btns" style="margin-top:4px"><button class="sp-btn" @click="addCard">＋ 添加数据卡</button></div>
  </div>
  <div class="sp-sec"><h4>大屏右侧·快捷卡片</h4>
    <div class="sp-tip">勾选的场景与设备将在展示大屏右侧显示，可点击执行/控制；按楼层独立配置</div>
    <div class="sp-btns">
      <button class="sp-btn" @click="openDispCfg">⚙ 配置大屏展示项</button>
    </div>
    <div class="sp-row" style="margin-top:8px"><label>已选</label><input disabled :value="dispCountText"></div>
  </div>
  <div class="sp-sec"><h4>选择对象查看详情</h4>
    <div class="sp-steps">
      <div class="sp-step"><b>1</b>绘制墙体，摆放家具</div>
      <div class="sp-step"><b>2</b>放置设备并绑定 HA 实体</div>
      <div class="sp-step"><b>3</b>切到 3D 展示，实时查看与控制</div>
    </div>
  </div>
</template>

<script>
/*
 * FloorSettings — 右侧「楼层设置」分支，批次 3 从 App.vue 拆出。
 *
 * 共享状态全部来自 useEditorStore，零 props：project 是原始 state，cur 是共享 getter
 * （原先本组件、App.vue、BackdropPanel、SelectionInspector 各算一份，现收敛到 store）。
 * dataCardRows / dispCountText 是本分支独有的派生数据，仍留在组件内。
 * `cur.name = ...` 保持原样直写 store 里的响应式项目对象（原模板就是这么写的，
 * 未走 dirty/commit —— 本轮只搬 UI，不改变行为）。
 *
 * 需要压撤销栈 / 重建 3D / 开弹窗的动作 emit 回根组件；这里的同名 method 仅薄转发，
 * 所以模板与拆分前逐字一致。
 */
import { mapState } from 'pinia';
import { useEditorStore } from '../../../stores/editor';
import EntityInput from '../../common/EntityInput.vue';

export default {
  name: 'FloorSettings',
  components: { EntityInput },
  emits: [
    'set-project-name', 'set-floor-height', 'add-floor', 'del-floor',
    'set-weather', 'set-card', 'add-card', 'remove-card', 'open-disp-cfg',
  ],
  computed: {
    ...mapState(useEditorStore, ['project', 'cur']),
    /* 数据卡列表（按楼层独立；动态数量，至少显示一行空行便于添加） */
    dataCardRows() {
      const c = (this.cur && this.cur.display && this.cur.display.dataCards) || [];
      return c.length ? c : [''];
    },
    /* 场景 / 快捷设备清单在 DispCfgModal，这里只留「已选」摘要 */
    dispCountText() {
      const d = (this.cur && this.cur.display) || {};
      return ((d.displayScenes || []).length) + ' 个场景 · ' + ((d.quickDevices || []).length) + ' 个设备';
    },
  },
  methods: {
    setProjectName(v) { this.$emit('set-project-name', v); },
    setFloorHeight(v, phase) { this.$emit('set-floor-height', v, phase); },
    addFloor() { this.$emit('add-floor'); },
    delFloor() { this.$emit('del-floor'); },
    setWeather(v) { this.$emit('set-weather', v); },
    setCard(i, v) { this.$emit('set-card', i, v); },
    addCard() { this.$emit('add-card'); },
    removeCard(i) { this.$emit('remove-card', i); },
    openDispCfg() { this.$emit('open-disp-cfg'); },
  },
};
</script>
