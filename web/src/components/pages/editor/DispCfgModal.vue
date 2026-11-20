<template>
  <div id="dispCfgModal" class="modal" v-show="open">
    <div class="modal-box small">
      <div class="modal-head"><h2>展示大屏 · 展示项配置</h2><button class="close" @click="$emit('close')">×</button></div>
      <div class="sp-tip" style="margin-bottom:10px">勾选的场景 / 脚本、添加的实体都会出现在展示页的展示项条里（单行横滚，可点击）；按楼层独立配置</div>

      <h4 class="dcm-h">🎬 场景（{{ sceneOptions.length }}）</h4>
      <div class="dev-list dcm-list">
        <label class="dev-item chk" v-for="s in sceneOptions" :key="s.eid">
          <input type="checkbox" :checked="has(s.eid)" :disabled="full && !has(s.eid)" @change="toggle('scene', s.eid)">
          <div class="m"><div class="n">{{ s.name }}</div><div class="s"><code>{{ s.eid }}</code></div></div>
        </label>
        <div class="sp-empty" v-if="!sceneOptions.length">HA 中暂无场景（scene 实体）<br>可在 Home Assistant 中创建后再来配置</div>
      </div>

      <h4 class="dcm-h">📜 脚本（{{ scriptOptions.length }}）</h4>
      <div class="dev-list dcm-list">
        <label class="dev-item chk" v-for="s in scriptOptions" :key="s.eid">
          <input type="checkbox" :checked="has(s.eid)" :disabled="full && !has(s.eid)" @change="toggle('script', s.eid)">
          <div class="m"><div class="n">{{ s.name }}</div><div class="s"><code>{{ s.eid }}</code></div></div>
        </label>
        <div class="sp-empty" v-if="!scriptOptions.length">HA 中暂无脚本（script 实体）</div>
      </div>

      <h4 class="dcm-h">💡 已添加的实体（{{ entityItems.length }}）</h4>
      <div class="dev-list dcm-list dcm-entities">
        <div class="dev-item" v-for="it in entityItems" :key="it.eid">
          <div class="m"><div class="n">{{ displayName(it) }}</div><div class="s"><code>{{ it.eid }}</code></div></div>
          <button class="tb-btn tiny" title="移除" @click="remove(it.eid)">移除</button>
        </div>
        <div class="sp-empty" v-if="!entityItems.length">还没有添加实体，用下方搜索框添加</div>
      </div>

      <div class="dcm-add">
        <entity-input v-model="newEid" :domains="allowedDomains"
          placeholder="搜索 light / switch / input_boolean 实体"></entity-input>
        <button class="tb-btn" :disabled="!canAdd" @click="addEntity">＋ 添加</button>
      </div>
      <div class="sp-tip" style="margin-top:6px">
        实体只支持 <b>light / switch / input_boolean</b>（点击即切换开/关，不等待回执）；场景与脚本请在上面勾选。最多 {{ maxItems }} 项{{ full ? '（已满）' : '' }}。
      </div>

      <div class="form-row">
        <button class="tb-btn primary" @click="$emit('close')">完成</button>
        <button class="tb-btn" @click="clearAll">清空全部</button>
      </div>
    </div>
  </div>
</template>

<script>
/*
 * DispCfgModal — 展示大屏「展示项」配置弹窗（2026-11-15 方案 B）。
 *
 * 数据结构：floor.display.displayItems = [{ eid, kind, name?, icon?, action? }]
 *   · kind = 'scene' | 'script'：HA 自动列举全部 scene.* / script.*，勾选即启用；
 *   · kind = 'entity'：EntityInput 搜索添加，**只允许 light / switch / input_boolean**
 *     （2026-11-16 用户指定；域白名单直接复用 displayAction 的 TOGGLE_DOMAINS）。
 * 旧的 displayScenes / quickDevices 已废止，用户明确要求不做兼容迁移。
 * automation 不列举（刻意），其它域由 model/displayAction.js 按域分派服务。
 *
 * 改的是当前楼层 floor.display（store.cur 的响应式对象，按楼层独立配置），
 * 每次变更 emit('dirty') 让父级压撤销栈 / 自动保存。
 *
 * open / floor / version 从 store 直读；version(entVersion) 让 HA 状态推送时
 * 列表里的友好名即时刷新。emits: close / dirty
 */
import { mapState } from 'pinia';
import { useUiStore } from '../../../stores/ui';
import { useEditorStore } from '../../../stores/editor';
import EntityInput from '../../common/EntityInput.vue';
import { MAX_DISPLAY_ITEMS, TOGGLE_DOMAINS } from '../../../model/displayAction.js';

export default {
  name: 'DispCfgModal',
  components: { EntityInput },
  emits: ['close', 'dirty'],
  data() { return { newEid: '' }; },
  computed: {
    ...mapState(useUiStore, { open: 'dispOpen' }),
    ...mapState(useEditorStore, { floor: 'cur', version: 'entVersion' }),
    /* 可添加的实体域：只有点亮即切换的三个开关域（用户 2026-11-16 指定）。
       与 model/displayAction.js 的 TOGGLE_DOMAINS 同一口径 —— 这里放开别的域，
       展示页就会按 turn_on 去调用（多数实体根本没有这个服务）。 */
    allowedDomains() { return TOGGLE_DOMAINS; },
    items() {
      const d = this.floor && this.floor.display;
      return d && Array.isArray(d.displayItems) ? d.displayItems : [];
    },
    maxItems() { return MAX_DISPLAY_ITEMS; },
    full() { return this.items.length >= MAX_DISPLAY_ITEMS; },
    sceneOptions() { return this.haList(/^scene\./); },
    scriptOptions() { return this.haList(/^script\./); },
    entityItems() { return this.items.filter((it) => it.kind === 'entity'); },
    /* 手输也要过域校验：EntityInput 的 domains 只过滤下拉候选，直接粘贴
       一个 sensor.xxx 仍能提交，所以这里再挡一道（提示文案里已写明只支持三类）。 */
    canAdd() {
      const v = (this.newEid || '').trim();
      if (!v || v.indexOf('.') <= 0 || this.has(v) || this.full) return false;
      return TOGGLE_DOMAINS.includes(v.split('.')[0].toLowerCase());
    },
  },
  methods: {
    /* 以 HA 实体列表为「候选」，勾选结果存进配置主表；
     * HA.friendly 必须是成员调用（内部用 this.getState），不能提成裸函数。 */
    haList(re) {
      void this.version;
      const A = typeof window !== 'undefined' ? window.HA : null;
      const all = A && typeof A.all === 'function' ? A.all() : [];
      return (all || []).filter((s) => s && re.test(s.entity_id))
        .map((s) => ({ eid: s.entity_id, name: A.friendly(s.entity_id) }));
    },
    displayName(it) {
      if (it.name) return it.name;
      const A = typeof window !== 'undefined' ? window.HA : null;
      return A && A.friendly ? A.friendly(it.eid) : it.eid;
    },
    has(eid) { return this.items.some((it) => it.eid === eid); },
    ensure() {
      if (!this.floor) return null;
      const d = this.floor.display || (this.floor.display = {});
      if (!Array.isArray(d.displayItems)) d.displayItems = [];
      return d.displayItems;
    },
    toggle(kind, eid) {
      const arr = this.ensure();
      if (!arr) return;
      const i = arr.findIndex((it) => it.eid === eid);
      if (i >= 0) arr.splice(i, 1);
      else if (!this.full) arr.push({ eid, kind });
      else return;
      this.$emit('dirty');
    },
    addEntity() {
      if (!this.canAdd) return;
      const arr = this.ensure();
      if (!arr) return;
      arr.push({ eid: this.newEid.trim(), kind: 'entity' });
      this.newEid = '';
      this.$emit('dirty');
    },
    remove(eid) {
      const arr = this.ensure();
      if (!arr) return;
      const i = arr.findIndex((it) => it.eid === eid);
      if (i >= 0) { arr.splice(i, 1); this.$emit('dirty'); }
    },
    clearAll() {
      const arr = this.ensure();
      if (!arr) return;
      arr.splice(0, arr.length);
      this.$emit('dirty');
    },
  },
};
</script>

<style scoped>
.dcm-h { font-size: 13px; margin: 10px 0 6px; }
.dcm-list { max-height: 132px; padding: 0 2px; overflow-y: auto; }
.dcm-entities { max-height: 100px; }
.dcm-add { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.dcm-add .ent-input { flex: 1; min-width: 0; }
.dcm-add .tb-btn { flex: none; }
</style>
