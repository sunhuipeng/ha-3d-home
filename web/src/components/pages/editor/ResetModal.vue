<template>
  <div id="resetModal" class="modal" v-show="open">
    <div class="modal-box small">
      <div class="modal-head"><h2>重置当前楼层</h2><button class="close" @click="$emit('close')">×</button></div>
      <div class="sp-tip" style="margin-bottom:10px">
        将清空「{{ floorName }}」的全部内容：墙体、门窗、家具、设备。<br>
        重置后自动保存且不可撤销。如需保留，请先取消并自行备份 data/project.json。
      </div>
      <input class="search" style="margin:0 0 12px; width:100%" placeholder="请输入：确认" v-model="text" @keydown.enter="confirm">
      <div class="form-row">
        <button class="tb-btn primary" :class="{disabled: !ok}" :disabled="!ok" @click="confirm">确认重置</button>
        <button class="tb-btn" @click="$emit('close')">取消</button>
      </div>
    </div>
  </div>
</template>

<script>
/*
 * ResetModal — 重置当前楼层确认弹窗，批次 1 从 App.vue 拆出。
 *
 * 「输入『确认』」这道校验连同输入框一起收进组件（按钮 disabled + Enter 都走 confirm），
 * 父级 confirmResetFloor() 只负责真正清空楼层数据、清选中、压栈与提示。
 * open 从 ui store 的 resetOpen 直读，floorName 从 editor store 的 cur getter 派生，
 * 因此不再需要父级下发 2 个 props（模板变量名由 mapState 重命名保持不变）。
 *
 * emits: close / confirm（仅在输入为「确认」时发出）
 */
import { mapState } from 'pinia';
import { useUiStore } from '../../../stores/ui';
import { useEditorStore } from '../../../stores/editor';

export default {
  name: 'ResetModal',
  emits: ['close', 'confirm'],
  data() {
    return { text: '' };
  },
  computed: {
    ...mapState(useUiStore, { open: 'resetOpen' }),
    ...mapState(useEditorStore, { floorName: (s) => (s.cur ? s.cur.name : '') }),
    ok() { return this.text.trim() === '确认'; },
  },
  watch: {
    open(v) { if (v) this.text = ''; },   // 每次打开都是干净的输入框（原 openResetFloor 的职责）
  },
  methods: {
    confirm() { if (this.ok) this.$emit('confirm'); },
  },
};
</script>
