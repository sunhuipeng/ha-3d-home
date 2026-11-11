<template>
  <div id="devPanel" class="flyout wide" v-show="open">
    <div class="flyout-head">设备 <button class="close" @click="$emit('close')">×</button></div>
    <input class="search" placeholder="搜索实体、类型或状态" v-model="devSearch">
    <div class="dev-filters" :class="{'fade-l': tabsFadeL, 'fade-r': tabsFadeR}">
      <!-- 分类页签由 catalog.js 的 DEVICE_TYPES 派生；单行横向滚动，零计数分类自动隐藏 -->
      <div class="dev-tabs" ref="devTabsBox" @scroll="onTabsScroll" @wheel.prevent="onTabsWheel">
        <button v-for="t in devTabs" :key="t.key"
                :class="{active: devFilter === t.key, zero: !devData.counts[t.key]}"
                @click="devFilter = t.key">{{ t.icon }} {{ t.label }} <b>{{ devData.counts[t.key] || 0 }}</b></button>
      </div>
    </div>
    <div class="dev-list" ref="devListBox">
      <div v-if="devData.placed.length" style="padding:2px 4px 6px;color:#8a93a5;font-size:11px">已放置 {{ devData.placed.length }} 个设备点位</div>
      <div class="dev-item" v-for="p in devData.placed" :key="'p' + p.d.id">
        <div class="ic">{{ typeIcon(p.d.type) }}</div>
        <div class="m"><div class="n">{{ p.name }}</div><div class="s"><code>{{ p.d.entityId }}</code> · {{ p.fl }}</div></div>
        <div class="act"><button class="tb-btn" style="padding:3px 9px" @click="$emit('locate', p)">定位</button></div>
      </div>
      <div class="dev-item" v-for="e in devData.list" :key="e.eid" style="cursor:pointer" @click="$emit('pick', e)">
        <div class="ic">{{ typeIcon(e.type) }}</div>
        <div class="m"><div class="n">{{ e.name }}</div><div class="s"><code>{{ e.eid }}</code></div></div>
        <div class="st" :class="e.on ? 'st-on' : 'st-off'">{{ e.stateText }}</div>
        <div class="act">＋</div>
      </div>
      <div class="sp-empty" v-if="!devData.list.length && !devData.placed.length">
        <template v-if="haStatus.status === 'connected'">该分类下暂无实体</template>
        <template v-else>暂无实体<br>请先在「连接」中配置 Home Assistant</template>
      </div>
    </div>
  </div>
</template>

<script>
/*
 * DevPanel — 设备实体浮层，批次 1 从 App.vue 拆出（本批最大的一块）。
 *
 * 整组搬入：搜索词、分类、页签横向滚动 / 渐隐、列表滚动复位、devTabs / devData 两个
 * computed 以及对应的 4 个 watch —— 它们只服务这一块 UI，过去却常驻根组件。
 * 仍留在父级：pickEntity / locateDevice（要改 Editor.ghost、切楼层、重取景、压视图栈）。
 *
 * 注意：HA / catalog / 插件目录都是非响应式全局对象，靠 version（store 的 entVersion）触发重算；
 *       project / haStatus / open 同样从全局 store 直读（零 props），组件只读不改。
 *
 * emits: close / pick(实体 e) / locate(已放置点位 p)
 */
import { mapState } from 'pinia';
import { useUiStore } from '../../../stores/ui';
import { useEditorStore } from '../../../stores/editor';

export default {
  name: 'DevPanel',
  emits: ['close', 'pick', 'locate'],
  data() {
    return {
      devSearch: '',
      devFilter: 'all',
      tabsFadeL: false,
      tabsFadeR: false,
    };
  },
  computed: {
    /* open / version / project / haStatus 四个 props 全部改为 store 直读；
     * mapState 重命名保持模板与 computed 里的变量名不变。 */
    ...mapState(useUiStore, { open: 'devOpen' }),
    ...mapState(useEditorStore, { version: 'entVersion' }),
    ...mapState(useEditorStore, ['project', 'haStatus']),
    /* 零计数的分类默认隐藏（全部/其他/已添加常驻），当前选中项始终保留 */
    devTabs() {
      const c = this.devData.counts || {};
      const keep = { all: 1, other: 1, placed: 1 };
      return window.deviceTabs().filter((t) => keep[t.key] || (c[t.key] || 0) > 0 || this.devFilter === t.key);
    },
    devData() {
      void this.version;
      const HA = window.HA;
      const counts = { all: HA.all().length };
      Object.keys(window.DEVICE_TYPES).forEach((k) => { counts[k] = 0; });
      const q = this.devSearch.toLowerCase();
      const f = this.devFilter;
      const list = [];
      HA.all().forEach((s) => {
        const eid = s.entity_id;
        const type = window.deviceTypeOf(eid);
        counts[type] = (counts[type] || 0) + 1;
        // 分类过滤: all 显示全部；placed 只显示已放置点位；其余按 type 精确匹配
        if (f !== 'all') {
          if (f === 'placed') return;
          if (type !== f) return;
        }
        const name = HA.friendly(eid);
        if (q && !(eid.toLowerCase().includes(q) || name.toLowerCase().includes(q) || (s.state || '').toLowerCase().includes(q))) return;
        const unit = HA.unitOf(s);
        /* 状态文案与"已开启"判定都问插件（与 3D 标签同一套规则），不在 UI 里按 type 写分支 */
        const txt = window.PluginEngine ? window.PluginEngine.labelOf(type, s) : '';
        list.push({
          eid, name, type,
          on: HA.entityIsOn(eid, type),
          stateText: txt || (s.state === 'on' ? '已开启' : s.state === 'off' ? '已关闭' : s.state + unit),
        });
      });
      const placed = [];
      if (this.project) {
        this.project.floors.forEach((fl, fi) => fl.devices.forEach((d) => {
          // "已添加"分类: 支持按名称/实体/楼层过滤（设备名实时由 HA 解析，实例不存 name）
          const hay = (HA.friendly(d.entityId) + ' ' + (d.name || '') + ' ' + (d.entityId || '') + ' ' + fl.name).toLowerCase();
          if (q && !hay.includes(q)) return;
          placed.push({ fl: fl.name, fi, d, name: window.itemDisplayName('device', d) });
        }));
        counts.placed = placed.length;
      }
      // 已放置点位只在"已添加"分类显示，其余 tab 只看实体列表
      if (this.devFilter === 'placed') return { counts, list: [], placed };
      return { counts, list: list.slice(0, 120), placed: [] };
    },
  },
  watch: {
    /* 分类切换 / 数据变化 → 选中项滚进可视区、渐隐提示同步、列表回顶部 */
    devFilter() {
      this.$nextTick(() => { this.scrollTabsToActive(); this.resetDevListScroll(); });
    },
    devTabs() { this.$nextTick(() => { this.scrollTabsToActive(); this.updateTabsEdge(); }); },
    open(v) { if (v) this.$nextTick(() => { this.scrollTabsToActive(); this.updateTabsEdge(); }); },
    devSearch() { this.$nextTick(() => this.resetDevListScroll()); },
  },
  methods: {
    onTabsScroll() { this.updateTabsEdge(); },
    onTabsWheel(e) {
      const box = this.$refs.devTabsBox;
      if (!box) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      box.scrollLeft += delta;
      this.updateTabsEdge();
    },
    updateTabsEdge() {
      const box = this.$refs.devTabsBox;
      if (!box || !box.clientWidth) return;
      const max = box.scrollWidth - box.clientWidth;
      this.tabsFadeL = box.scrollLeft > 2;
      this.tabsFadeR = max > 2 && box.scrollLeft < max - 2;
    },
    scrollTabsToActive() {
      const box = this.$refs.devTabsBox;
      if (!box || !box.clientWidth) return;
      const el = box.querySelector('button.active');
      if (el) {
        const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
        const target = r.left - b.left + box.scrollLeft - (box.clientWidth - r.width) / 2;
        box.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
      }
      this.updateTabsEdge();
    },
    resetDevListScroll() {
      const list = this.$refs.devListBox;
      if (list) list.scrollTop = 0;
    },
    typeIcon(type) {
      const t = window.DEVICE_TYPES[type];
      return t ? t.icon : '⚙️';
    },
  },
};
</script>
