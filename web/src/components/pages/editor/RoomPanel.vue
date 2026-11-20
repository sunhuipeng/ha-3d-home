<template>
  <!-- 右侧属性栏：选中房间（selection.kind === 'room'）时的专用面板。
       零 props：房间数据从 store 的 selItem 直读；写入一律 emit 回根组件 ——
       改名字要压撤销栈、改颜色要重建 3D 地面，属于「数据 + 引擎」的编排动作，
       按本项目口径留在根组件（见 stores/editor.js 的分层说明）。 -->
  <div class="prop-name">{{ kindName }}{{ selItem.name ? ' · ' + selItem.name : '' }}</div>
  <div class="prop-kind">{{ vertexCount }} 个顶点 · {{ areaText }}</div>
  <div class="prop-kind">门 {{ counts.doors }} · 窗 {{ counts.windows }} · 设备 {{ counts.devices }} 台 · 家具 {{ counts.furniture }} 件</div>

  <div class="sp-sec"><h4>房间</h4>
    <div class="sp-row"><label>名称</label>
      <!-- 输入框走本地草稿 nameDraft，不走 :value="selItem.name"：
           那样一删空就会被数据层的兜底「房间」顶回来，光标被甩到末尾，
           没法「全选删掉再敲新名字」。空串只存在于草稿里，失焦才决定落库还是回退。 -->
      <input :value="nameDraft" maxlength="20" placeholder="房间"
             @input="onNameInput" @blur="onNameBlur" @keyup.enter="$event.target.blur()">
    </div>
    <div class="sp-row"><label>面积</label><b class="room-area">{{ areaText }}</b></div>
    <div class="sp-row"><label>地面颜色</label>
      <div class="room-colors">
        <button v-for="c in colors" :key="c" class="room-color" :class="{active: isActive(c)}"
                :style="{background: c}" :title="c" @click="$emit('set-room-prop', 'color', c)"></button>
      </div>
    </div>
    <!-- 预设之外任意色：单独一行（Element Plus 取色器，全局注册见 main-edit.js）+ 当前色值。
         只取 hex（不开 alpha）：room.color 会直接进 Canvas fillStyle 与 THREE.Color，
         rgba 字符串在 THREE 里不可靠。change 在面板「确定」时触发，中途拖动不落库。 -->
    <div class="sp-row"><label>自定义</label>
      <div class="room-custom">
        <el-color-picker
          class="room-color-custom"
          :model-value="currentColor"
          :predefine="colors"
          title="自定义颜色"
          @change="onCustomColor" />
        <code class="room-custom-hex">{{ currentColor }}</code>
      </div>
    </div>
    <div class="sp-tip">面积按顶点实时计算（鞋带公式）；颜色同时作用于 2D 分区与 3D 地面</div>
  </div>

  <div class="sp-btns"><button class="sp-btn warn" @click="$emit('del-selected')">删除房间</button></div>
</template>

<script>
import { mapState } from 'pinia';
import { useEditorStore } from '../../../stores/editor';
import { roomArea, roomColor, roomCounts, ROOM_COLORS } from '../../../model/catalog.js';

export default {
  name: 'RoomPanel',
  emits: ['set-room-prop', 'del-selected'],
  data() {
    return {
      colors: ROOM_COLORS,
      /* 名称输入框的本地草稿：允许中途为空（整段删掉再重打），失焦时才落库/回退。
       * 直接把 selItem.name 绑到输入框是行不通的 —— 数据层有「空名兜底成房间」的
       * 不变量，删空瞬间就被顶回来，光标还会被甩到末尾。 */
      nameDraft: '',
      nameEditing: false,
    };
  },
  computed: {
    /* 房间与其它选中对象同源：kindName / selItem 都在 editor store（map 里已加 room → rooms），
     * 所以这里不需要再判断选中是谁，App.vue 的 v-else-if 已经保证只在选中房间时挂载 */
    ...mapState(useEditorStore, ['selItem', 'kindName', 'cur']),
    roomName() { return (this.selItem && this.selItem.name) || ''; },
    vertexCount() { return (this.selItem && Array.isArray(this.selItem.pts)) ? this.selItem.pts.length : 0; },
    /* 面积与 2D 标签、悬停提示共用 roomArea，全项目只有一份口径 */
    areaText() { return Math.abs(roomArea(this.selItem && this.selItem.pts)).toFixed(2) + ' m²'; },
    /* 归属统计：只看实例上的 roomId（手动改过就以手动值为准，不重算几何） */
    counts() { return roomCounts(this.cur, this.selItem && this.selItem.id); },
    /* 取色器当前值：与色块同源（老数据回退第 0 色），改色后色块与取色器同步刷新 */
    currentColor() { return this.selItem.color || roomColor(0); },
  },
  watch: {
    /* 外部改名（撤销 / 切到另一间房）同步到草稿；正在打字时不覆盖，避免抢输入 */
    roomName: {
      immediate: true,
      handler(v) { if (!this.nameEditing) this.nameDraft = v; },
    },
  },
  methods: {
    onNameInput(e) {
      this.nameEditing = true;
      const v = e.target.value;
      this.nameDraft = v;
      /* 空串（或全空格）不落库：输入框里可以空着继续打，但房间数据始终有名字，
       * 否则 2D 标签、悬停提示、归属下拉都会出现一项空白 */
      if (v.trim()) this.$emit('set-room-prop', 'name', v);
    },
    onNameBlur() {
      this.nameEditing = false;
      const v = (this.nameDraft || '').trim();
      if (!v) { this.nameDraft = this.roomName; return; }   // 整段删空又没填新的 → 回退原名
      if (v !== this.roomName) this.$emit('set-room-prop', 'name', v);
      this.nameDraft = v;                                    // 顺手去掉首尾空格
    },
    /* 没有 color 的老数据按「第 0 色」显示（与 drawRoom 的兜底一致），避免一个都不高亮 */
    isActive(c) { return (this.selItem.color || roomColor(0)) === c; },
    onCustomColor(v) {
      /* 清空按钮会传 null；hex 大小写统一，避免 '#ABC123' 与预设判等失败 */
      if (!v) return;
      const c = String(v).toLowerCase();
      if (c === this.currentColor.toLowerCase()) return;
      this.$emit('set-room-prop', 'color', c);
    },
  },
};
</script>
