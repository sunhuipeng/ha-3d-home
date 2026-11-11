<template>
  <div id="dispCfgModal" class="modal" v-show="open">
    <div class="modal-box small">
      <div class="modal-head"><h2>展示大屏 · 展示项配置</h2><button class="close" @click="$emit('close')">×</button></div>
      <div class="sp-tip" style="margin-bottom:10px">勾选场景出现在展示大屏右侧（可点击执行）；快捷设备用搜索添加任意实体，显示为快捷开关</div>

      <h4 style="font-size:13px;margin-bottom:6px">🎬 场景（{{ dispScenes.length }}）</h4>
      <div class="dev-list" style="max-height:200px">
        <label class="dev-item chk" v-for="s in dispScenes" :key="s.eid">
          <input type="checkbox" :checked="inList(floor.display.displayScenes, s.eid)" @change="toggleList('displayScenes', s.eid)">
          <div class="m"><div class="n">{{ s.name }}</div><div class="s"><code>{{ s.eid }}</code></div></div>
        </label>
        <div class="sp-empty" v-if="!dispScenes.length">HA 中暂无场景（scene 实体）<br>可在 Home Assistant 中创建场景后再来配置</div>
      </div>

      <h4 style="font-size:13px;margin:14px 0 6px">⚡ 快捷设备（{{ quickList.length }}）</h4>
      <div class="dev-list" style="max-height:200px">
        <div class="dev-item chk" v-for="q in quickList" :key="q.eid">
          <div class="ic">{{ quickIcon(q.eid) }}</div>
          <div class="m"><div class="n">{{ q.name }}</div><div class="s"><code>{{ q.eid }}</code></div></div>
          <button type="button" class="sp-clear" title="移除" @click="removeQuickDevice(q.eid)">✕</button>
        </div>
        <div class="sp-empty" v-if="!quickList.length">还没有快捷设备<br>用下方搜索添加任意 HA 实体（不需要先在户型中放置）</div>
      </div>
      <div class="quick-add">
        <entity-input placeholder="搜索实体添加为快捷设备，如 light.xxx（回车添加）" :model-value="quickInput" @update:model-value="quickInput = $event" @keydown.enter="addQuickDevice"></entity-input>
        <button type="button" class="tb-btn" :disabled="!quickInput" @click="addQuickDevice">＋ 添加</button>
      </div>

      <div class="form-row">
        <button class="tb-btn primary" @click="$emit('close')">完成</button>
        <button class="tb-btn" @click="clearDispCfg">清空全部</button>
      </div>
    </div>
  </div>
</template>

<script>
/*
 * DispCfgModal — 展示大屏展示项配置弹窗，批次 1 从 App.vue 拆出。
 *
 * 场景/快捷设备清单、勾选、增删、搜索输入整组搬入。改动的是当前楼层 floor.display
 * （与根组件同一个响应式对象，按楼层独立配置），改完统一 emit('dirty') 让父级压栈 /
 * 自动保存；原先的 emit('refresh')（entVersion++）改成直接调 store Action bumpEntities()。
 *
 * open / floor / version 三个 props 改为 store 直读：floor ← 共享 getter cur，
 * version ← entVersion，mapState 重命名后模板变量名不变。
 * toast 也从 emit 改成直接调 ui store 的 Action，少一层事件透传。
 *
 * emits: close / dirty（dirty 要压撤销栈，仍是根组件编排）
 */
import { mapState, mapActions } from 'pinia';
import { useUiStore } from '../../../stores/ui';
import { useEditorStore } from '../../../stores/editor';
import EntityInput from '../../common/EntityInput.vue';

export default {
  name: 'DispCfgModal',
  components: { EntityInput },
  emits: ['close', 'dirty'],
  data() {
    return { quickInput: '' };
  },
  computed: {
    ...mapState(useUiStore, { open: 'dispOpen' }),
    ...mapState(useEditorStore, { floor: 'cur', version: 'entVersion' }),
    dispScenes() {
      void this.version;
      return window.HA.all()
        .filter((s) => /^scene\./.test(s.entity_id))
        .map((s) => ({ eid: s.entity_id, name: window.HA.friendly(s.entity_id) }));
    },
    quickList() {
      void this.version;
      return ((this.floor && this.floor.display && this.floor.display.quickDevices) || [])
        .map((eid) => ({ eid, name: window.HA.friendly(eid) || eid }));
    },
  },
  methods: {
    ...mapActions(useUiStore, ['toast']),
    ...mapActions(useEditorStore, ['bumpEntities']),
    inList(arr, eid) { return Array.isArray(arr) && arr.includes(eid); },
    toggleList(key, eid) {
      if (!this.floor) return;
      const st = this.floor.display;
      const arr = st[key] = st[key] || [];
      const i = arr.indexOf(eid);
      if (i >= 0) arr.splice(i, 1); else arr.push(eid);
      this.$emit('dirty');
    },
    clearDispCfg() {
      if (!this.floor) return;
      this.floor.display.displayScenes = [];
      this.floor.display.quickDevices = [];
      this.$emit('dirty');
    },
    quickIcon(eid) {
      const dom = String(eid || '').split('.')[0];
      return { light: '💡', switch: '🔌', fan: '🌀', cover: '🪟', climate: '❄️', media_player: '🎵', water_heater: '♨️', vacuum: '🤖', camera: '📯' }[dom] || '⚙️';
    },
    addQuickDevice() {
      const eid = String(this.quickInput || '').trim();
      if (!eid || !/^[a-z_]+\.[a-z0-9_]+$/i.test(eid)) { this.toast('请先在搜索框选择或输入完整实体 ID'); return; }
      if (!this.floor) return;
      const st = this.floor.display;
      const arr = st.quickDevices = st.quickDevices || [];
      if (arr.includes(eid)) { this.toast('该实体已在快捷设备中'); return; }
      arr.push(eid);
      this.quickInput = '';
      this.bumpEntities();
      this.$emit('dirty');
      this.toast('已添加快捷设备 · ' + eid);
    },
    removeQuickDevice(eid) {
      if (!this.floor) return;
      const st = this.floor.display;
      const arr = st.quickDevices = st.quickDevices || [];
      const i = arr.indexOf(eid);
      if (i >= 0) arr.splice(i, 1);
      this.bumpEntities();
      this.$emit('dirty');
    },
  },
};
</script>
