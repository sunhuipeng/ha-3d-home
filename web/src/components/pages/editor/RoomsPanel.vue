<template>
  <!-- 右侧属性栏：左侧「房间」绘制工具激活时的专用面板（2026-11-13 新增）。
       沿用 BackdropPanel 的分支模式 —— tool==='room' 时右侧稳定停在本面板，
       画房间 / 选中房间都不会被「单间属性」分支顶掉。

       用途：给「移动端房间 tab」「PC 端底部房间条」「全屋/房间卡片」定顺序。
       这三处直接 v-for cur.rooms，所以本面板只调整 rooms 数组顺序，
       不新增 order 字段（roomOut 是白名单序列化，新字段会被静默丢弃）。
       设备只读展示（2026-11-14 定稿）：房间下的设备列表仅供查看归属，
       不再提供排序 —— 设备顺序统一到 DevOrderPanel（左侧「设备」tab）里调。

       排序交互只用 ↑↓ 按钮，不做拖动：编辑页在 window 上挂了 mouseup / 手势分发，
       HTML5 DnD 和 pointer 自绘拖动都容易与它打架；箭头点击是一次性离散动作，
       桌面 / 触摸 / 键盘都能用，也不会出现「拖一半被手势掐断」的半态。

       分层口径（见 EditApp.vue 顶部注释）：零 props，数据用 mapState 直读 store，
       组件只产出「新的 id 顺序」emit 回根组件；真正的数组写入、撤销栈、2D 重绘、
       3D 重建、自动保存全部由根组件 reorderRooms() 编排。

       区块次序由「有没有选中房间」决定（2026-11-14）：选中后从上到下是
       选中房间 → 房间（名称/面积/颜色/删除）→ 房间顺序；未选中时房间顺序留在最上，
       下面跟一条「点房间名即可选中」的提示。这样点列表里的房间名后不必再往下滚一屏
       才能看到单间属性。 -->
  <div class="sp-title">房间属性</div>

  <!-- 选中房间：置顶。单间属性直接复用 RoomPanel（内含「房间」属性表单与删除按钮）。
       只有 hasRoomSelected 为真才挂载 —— RoomPanel 模板直接读 selItem.name，
       未选中 / 选中对象不在本层房间列表里时挂载会抛错。 -->
  <div class="sp-sec" v-if="hasRoomSelected">
    <h4>选中房间</h4>
    <room-panel @set-room-prop="forwardRoomProp" @del-selected="$emit('del-selected')" />
  </div>

  <div class="sp-sec">
    <h4>房间顺序 · {{ roomGroups.length }} 间</h4>
    <div class="sp-tip">点 ↑↓ 调整房间顺序。顺序同步到移动端房间 tab、PC 端底部房间条，以及「全屋」卡片的分组次序。<span v-if="hasRoomSelected">选中房间的属性已移到面板顶部。</span></div>

    <div class="rp-list" v-if="roomGroups.length">
      <div v-for="(r, i) in roomGroups" :key="r.id" class="rp-room" :class="{ on: selectedRoomId === r.id }">
        <div class="rp-room-hd">
          <span class="rp-idx">{{ i + 1 }}</span>
          <button class="rp-name" :title="r.name" @click="pickRoom(r.id)">{{ r.name }}</button>
          <span class="rp-badge" :title="r.devices.length + ' 台设备'">{{ r.devices.length }}</span>
          <button class="rp-move" :disabled="i === 0" title="上移" @click="moveRoom(i, i - 1)">↑</button>
          <button class="rp-move" :disabled="i === roomGroups.length - 1" title="下移" @click="moveRoom(i, i + 1)">↓</button>
          <button class="rp-toggle" :title="isOpen(r.id) ? '收起设备' : '展开设备'" @click="toggle(r.id)">{{ isOpen(r.id) ? '▾' : '▸' }}</button>
        </div>
        <div class="rp-meta">{{ r.area }} m² · {{ r.devices.length }} 台设备</div>

        <!-- 房间内设备：只读展示（归属参考），不参与排序 -->
        <div class="rp-devs" v-if="isOpen(r.id)">
          <div class="rp-dev-empty" v-if="!r.devices.length">本房间暂无已绑定实体的设备</div>
          <div v-for="(d, j) in r.devices" :key="d.id" class="rp-dev">
            <span class="rp-idx">{{ j + 1 }}</span>
            <span class="rp-dev-name" :title="d.eid">{{ d.name }}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="sp-tip" v-else>当前楼层还没有房间。在画布上连续点击画多边形，三点起自动闭合。</div>

    <!-- 未归属设备：只读展示。这些设备在大屏「全屋」里追加在末尾；
         排序功能已移除（2026-11-14），设备顺序统一在「设备排序」面板里调 -->
    <div class="rp-room rp-free" v-if="freeDevices.length">
      <div class="rp-room-hd">
        <span class="rp-idx">—</span>
        <span class="rp-name static">未归属设备</span>
        <span class="rp-badge" :title="freeDevices.length + ' 台设备'">{{ freeDevices.length }}</span>
        <button class="rp-toggle" :title="isOpen(null) ? '收起设备' : '展开设备'" @click="toggle(null)">{{ isOpen(null) ? '▾' : '▸' }}</button>
      </div>
      <div class="rp-devs" v-if="isOpen(null)">
        <div v-for="(d, j) in freeDevices" :key="d.id" class="rp-dev">
          <span class="rp-idx">{{ j + 1 }}</span>
          <span class="rp-dev-name" :title="d.eid">{{ d.name }}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 未选中时列表在最上，提示跟在列表后面；选中后这块收起，属性已经置顶 -->
  <div class="sp-sec" v-if="!hasRoomSelected">
    <h4>选中房间</h4>
    <div class="sp-tip">点上面的房间名即可选中，这里会显示名称、面积、地面颜色和删除。</div>
  </div>

  <div class="sp-sec">
    <div class="sp-tip">设备列表只含<b>已绑定 HA 实体</b>的设备（与大屏卡片口径一致），仅供查看归属，不在此排序；门窗、家具不出卡。设备顺序到左侧「设备」面板的「设备排序」里调，跨房间调整请到对象属性里改归属。</div>
  </div>
</template>

<script>
import { mapState } from 'pinia';
import { useEditorStore } from '../../../stores/editor';
import { roomArea } from '../../../model/catalog.js';
import { devNameOf } from '../../../services/devName.js';
import RoomPanel from './RoomPanel.vue';

export default {
  name: 'RoomsPanel',
  components: { RoomPanel },
  emits: ['reorder', 'select-room', 'set-room-prop', 'del-selected'],
  data() {
    return {
      /* 展开态按房间 id 记，不用对象引用 —— 撤销恢复会整份替换 project 并清空 selection */
      open: {},
    };
  },
  computed: {
    ...mapState(useEditorStore, ['cur', 'selection', 'entVersion']),
    /* 房间 + 房间内设备（保序）。entVersion 作为 HA 名称刷新的信号：
       HA 连上后 friendly_name 才可读，computed 要跟着重算一次。 */
    roomGroups() {
      void this.entVersion;
      const fl = this.cur;
      if (!fl) return [];
      const devs = fl.devices || [];
      return (fl.rooms || []).map((r) => ({
        id: r.id,
        name: r.name || '未命名房间',
        area: Math.abs(roomArea(r.pts)).toFixed(1),
        /* 与 model/catalog.js 的 roomDevices() 同口径：只认 roomId + entityId，
           不做几何回算，也不把门窗家具算进来 —— 大屏卡片就是这样取的 */
        devices: devs.filter((d) => d.roomId === r.id && d.entityId)
          .map((d) => ({ id: d.id, name: devNameOf(d), eid: d.entityId })),
      }));
    },
    /* roomId 为空的设备：全屋卡片把它们追加在末尾，单独成组便于排序 */
    freeDevices() {
      void this.entVersion;
      const fl = this.cur;
      if (!fl) return [];
      return (fl.devices || []).filter((d) => !d.roomId && d.entityId)
        .map((d) => ({ id: d.id, name: devNameOf(d), eid: d.entityId }));
    },
    selectedRoomId() {
      return this.selection && this.selection.kind === 'room' ? this.selection.id : '';
    },
    hasRoomSelected() {
      return !!this.selectedRoomId && this.roomGroups.some((g) => g.id === this.selectedRoomId);
    },
  },
  watch: {
    /* 在画布上选中房间（房间工具点已有房间会 select）时自动展开，列表跟着走。
       选中后单间属性被移到面板最顶：若用户是从下方列表里点进来的，滚动位置还停在
       列表中间，新内容会被浏览器的滚动锚定顶到视野外 —— 切到别的房间时把右侧面板
       滚回顶部，保证「选中房间 → 房间 → 房间顺序」立刻可见。 */
    selectedRoomId: {
      immediate: true,
      handler(id, old) {
        if (!id) return;
        this.open[id] = true;
        if (id !== old) this.$nextTick(() => {
          const p = document.getElementById('sidePanel');
          if (p) p.scrollTop = 0;
        });
      },
    },
  },
  mounted() {
    if (!Object.keys(this.open).length && this.roomGroups.length) this.open[this.roomGroups[0].id] = true;
  },
  methods: {
    /* 设备显示名统一走 services/devName.js 的 devNameOf（审计 2.16） */
    isOpen(id) { return !!this.open[id === null ? '__free__' : id]; },
    toggle(id) {
      const k = id === null ? '__free__' : id;
      this.open[k] = !this.open[k];
    },
    pickRoom(id) {
      this.open[id] = true;
      this.$emit('select-room', id);
    },
    forwardRoomProp(k, v) { this.$emit('set-room-prop', k, v); },

    /* 每次 ↑↓ 只交换相邻两项：算出新的 id 顺序交给根组件一次写入 + 一条撤销。
       组件不改数组，避免「改了数据但没进撤销栈 / 没落盘」。只排房间，设备不参与。 */
    moveRoom(from, to) {
      const list = this.roomGroups;
      if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return;
      const ids = list.map((r) => r.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      this.$emit('reorder', { kind: 'rooms', ids });
    },
  },
};
</script>

<style scoped>
.rp-list { display: flex; flex-direction: column; gap: 6px; }
.rp-room {
  border: 1px solid var(--line); border-radius: 9px; background: var(--card-tile);
  padding: 6px 7px; transition: border-color .12s, background .12s;
}
.rp-room.on { border-color: var(--blue); background: var(--blue-soft); }
.rp-room-hd { display: flex; align-items: center; gap: 4px; min-width: 0; }
.rp-idx {
  flex: none; width: 17px; text-align: center; font-size: 10px; color: var(--ink2);
  font-variant-numeric: tabular-nums;
}
.rp-name {
  flex: 1; min-width: 0; text-align: left; font-size: 12px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 2px;
}
.rp-name.static { cursor: default; }
.rp-name:hover { color: var(--blue); }
.rp-badge {
  flex: none; min-width: 17px; height: 17px; padding: 0 4px; border-radius: 9px;
  background: #eef1f5; color: var(--ink2); font-size: 10px; line-height: 17px; text-align: center;
}
.rp-move, .rp-toggle {
  flex: none; width: 22px; height: 22px; border-radius: 6px; font-size: 12px; line-height: 1;
  color: var(--ink2); background: #f4f6f9;
}
.rp-move:hover:not(:disabled), .rp-toggle:hover { background: var(--blue-soft); color: var(--blue); }
.rp-move:focus-visible, .rp-toggle:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
.rp-move:disabled { opacity: .3; cursor: default; }
.rp-meta { margin: 2px 0 0 21px; font-size: 10px; color: var(--ink2); }
.rp-devs { display: flex; flex-direction: column; gap: 3px; margin: 6px 0 1px 4px; padding-left: 7px; border-left: 2px solid var(--line); }
.rp-dev {
  display: flex; align-items: center; gap: 4px; padding: 3px 2px; border-radius: 6px;
  background: #fafbfd;
}
.rp-dev-name {
  flex: 1; min-width: 0; font-size: 11px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.rp-dev-empty { font-size: 11px; color: var(--ink2); padding: 3px 0 4px; }
.rp-free { margin-top: 8px; background: #fbfcfe; }
</style>
