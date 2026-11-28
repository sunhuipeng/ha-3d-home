<template>
  <!-- 右侧属性栏：左侧「设备」工具激活时的设备排序面板（2026-11-14 新增）。
       与 RoomsPanel 同模式 —— tool==='device' 时右侧稳定停在本面板，
       不会被「选中设备属性」分支顶掉；× / Esc 收起浮层才回到选择工具。

       语义：**顺序即权重**。这里的 ↑↓ 直接改 fl.devices 数组顺序，
       卡片渲染端（useCards → CardEngine.buildListCard）把设备分成
       「单元素卡片（solo 聚合成一组）」与「多控件卡片（各自一张子卡）」两类，
       两类内部都按这个数组顺序排 —— 所以卡片是跟着设备走的，不另存 order 字段
       （devOut 是白名单序列化，新字段会被静默丢弃）。

       分层口径：零 props，数据 mapState 直读 store；组件只产出「新的 id 顺序」
       emit 回根组件，数组写入 / 撤销栈 / 自动保存在根组件 reorderDevices() 编排。

       不参与排序（列表里不出现）：
         · type==='furniture' 的插件家具实例（无 HA 实体，不出卡）
         · 未绑定 HA 实体的设备（不出卡，排了也没处体现）

       隐藏标记（2026-11-15 新增）：每行的「隐藏 / 显示」只是给设备写一个布尔
       hideCard（存 project.json，devOut 白名单已放行），**不隐藏场景里的设备**——
       2D/3D 模型、标签、点击全都不变，只有建卡层（useCards 的全屋 / 房间分支）
       把带标记的设备过滤掉，卡片里不再出它的插片。已隐藏的行仍留在列表里
       （否则没法取消隐藏），排序照常参与；单设备选中态仍出卡，统计数字也仍算它。 -->
  <div class="sp-title">设备排序</div>

  <div class="sp-sec">
    <h4>
      设备顺序 · {{ list.length }} 台
      <span v-if="hiddenN" class="do-cnt">已隐藏 {{ hiddenN }}</span>
    </h4>
    <div class="sp-tip">点 ↑↓ 调整顺序，顺序即卡片展示顺序：单元素卡片聚成一组排在前面，多控件卡片跟在后面，同类内部按这里的顺序。<b>家具不参与</b>（家具插件下的造型不出卡）。</div>
    <div class="sp-tip">
      点「隐藏」只是给这台设备打一个标记、卡片里不再出插片（场景里的模型、标签、点击照旧）；再点「显示」恢复。
      <button v-if="hiddenN" class="do-allshow" @click="showAll">全部显示</button>
    </div>

    <div class="do-list" v-if="list.length">
      <div v-for="(d, i) in list" :key="d.id" class="do-item"
           :class="{ on: selectedId === d.id, off: d.hidden }">
        <div class="do-hd">
          <span class="do-idx">{{ i + 1 }}</span>
          <span class="do-ico">{{ d.icon }}</span>
          <button class="do-name" :title="d.eid" @click="pick(d.id)">{{ d.name }}</button>
          <button class="do-move" :disabled="i === 0" title="上移" @click="move(i, i - 1)">↑</button>
          <button class="do-move" :disabled="i === list.length - 1" title="下移" @click="move(i, i + 1)">↓</button>
          <button class="do-eye" :class="{ off: d.hidden }"
                  :title="d.hidden ? '显示：卡片里重新出现这台设备' : '隐藏：卡片里不再出现这台设备的插片（场景不受影响）'"
                  @click="toggleHide(d.id)">{{ d.hidden ? '显示' : '隐藏' }}</button>
        </div>
        <div class="do-meta">
          {{ d.room }} · {{ d.eid }}<span v-if="d.hidden" class="do-off-tag">已隐藏</span>
        </div>
      </div>
    </div>
    <div class="sp-tip" v-else>当前楼层还没有可排序的设备。点左侧「设备」把实体放到户型里，回这里调顺序。</div>

    <div class="sp-tip" v-if="unboundCount">
      另有 {{ unboundCount }} 台设备未绑定 HA 实体，不出卡，不在此列。
    </div>
  </div>
</template>

<script>
import { mapState } from 'pinia';
import { useEditorStore } from '../../../stores/editor';
import { DEVICE_TYPES } from '../../../model/catalog.js';
import { devNameOf } from '../../../services/devName.js';

export default {
  name: 'DevOrderPanel',
  emits: ['reorder', 'select-device', 'toggle-hide', 'show-all'],
  computed: {
    ...mapState(useEditorStore, ['cur', 'selection', 'entVersion']),
    devices() {
      void this.entVersion;
      const fl = this.cur;
      return (fl && Array.isArray(fl.devices)) ? fl.devices : [];
    },
    /* 可排序集合：有实体、非家具。顺序就是 fl.devices 的现有顺序（= 当前权重）。
     * 已隐藏的设备**仍然留在列表里**（否则没法取消隐藏），只是行上有「已隐藏」标记 */
    list() {
      void this.entVersion;
      const rooms = (this.cur && this.cur.rooms) || [];
      const roomName = (id) => {
        const r = id ? rooms.find((x) => x.id === id) : null;
        return (r && r.name) || '未归属';
      };
      return this.devices
        .filter((d) => d && d.entityId && d.type !== 'furniture')
        .map((d) => ({
          id: d.id,
          eid: d.entityId,
          icon: (DEVICE_TYPES[d.type] && DEVICE_TYPES[d.type].icon) || '⚙️',
          name: devNameOf(d),
          room: roomName(d.roomId),
          hidden: d.hideCard === true,
        }));
    },
    /* 卡片被隐藏的台数（打 hideCard 标记） */
    hiddenN() {
      void this.entVersion;
      return this.list.filter((d) => d.hidden).length;
    },
    /* 未绑定 HA 实体、压根出不了卡的设备（与 hideCard 无关） */
    unboundCount() {
      return this.devices.filter((d) => d && d.type !== 'furniture' && !d.entityId).length;
    },
    selectedId() {
      return this.selection && this.selection.kind === 'device' ? this.selection.id : '';
    },
  },
  methods: {
    /* 设备显示名统一走 services/devName.js 的 devNameOf（审计 2.16） */
    /* 点名字只做选中高亮，不切工具：排序时常要连续挪几次，切走会关掉浮层与面板 */
    pick(id) { this.$emit('select-device', id); },
    /* 每次 ↑↓ 只交换相邻两项：算出新的 id 顺序交给根组件一次写入 + 一条撤销 */
    move(from, to) {
      const list = this.list;
      if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) return;
      const ids = list.map((d) => d.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      this.$emit('reorder', { ids });
    },
    /* 隐藏 / 显示：只 emit，设备对象的写入 + 撤销栈 + 自动保存在根组件编排 */
    toggleHide(id) { this.$emit('toggle-hide', id); },
    showAll() { this.$emit('show-all'); },
  },
};
</script>

<style scoped>
.do-list { display: flex; flex-direction: column; gap: 5px; }
.do-item {
  border: 1px solid var(--line); border-radius: 9px; background: var(--card-tile); padding: 5px 7px;
  transition: border-color .12s, background .12s;
}
.do-item.on { border-color: var(--blue); background: var(--blue-soft); }
/* 已隐藏：虚线边 + 降饱和；行仍留在列表里（否则没法取消隐藏），↑↓ 照常可用 */
.do-item.off { border-style: dashed; background: transparent; }
.do-item.off .do-name { color: var(--ink2); }
.do-hd { display: flex; align-items: center; gap: 4px; min-width: 0; }
.do-idx {
  flex: none; width: 17px; text-align: center; font-size: 10px; color: var(--ink2);
  font-variant-numeric: tabular-nums;
}
.do-ico { flex: none; width: 16px; text-align: center; font-size: 12px; }
.do-name {
  flex: 1; min-width: 0; text-align: left; font-size: 12px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 2px;
}
.do-name:hover { color: var(--blue); }
.do-move {
  flex: none; width: 22px; height: 22px; border-radius: 6px; font-size: 12px; line-height: 1;
  color: var(--ink2); background: #f4f6f9;
}
.do-move:hover:not(:disabled) { background: var(--blue-soft); color: var(--blue); }
.do-move:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
.do-move:disabled { opacity: .3; cursor: default; }
/* 隐藏 / 显示：两字小按钮，跟 ↑↓ 同排（22 高、10px 字号） */
.do-eye {
  flex: none; height: 22px; padding: 0 5px; border-radius: 6px; font-size: 10px; line-height: 1;
  color: var(--ink2); background: #f4f6f9; white-space: nowrap;
}
.do-eye:hover { background: var(--blue-soft); color: var(--blue); }
.do-eye.off { color: var(--blue); background: var(--blue-soft); }
.do-eye:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
/* 段落标题里的「已隐藏 N」与「全部显示」 */
.do-cnt { margin-left: 6px; font-size: 10px; font-weight: 400; color: var(--ink2); }
.do-allshow {
  margin-left: 6px; padding: 1px 6px; border-radius: 6px; font-size: 10px;
  color: var(--blue); background: var(--blue-soft);
}
.do-allshow:hover { background: #dce9ff; }
/* 行尾「已隐藏」小标签 */
.do-off-tag {
  margin-left: 6px; padding: 0 4px; border-radius: 4px; font-size: 10px;
  color: var(--ink2); background: #eef1f5;
}
.do-meta {
  margin: 2px 0 0 21px; font-size: 10px; color: var(--ink2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
</style>
