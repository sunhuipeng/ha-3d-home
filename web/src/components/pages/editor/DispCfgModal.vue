<template>
  <div id="dispCfgModal" class="modal" v-show="open">
    <div class="modal-box disp-cfg">
      <div class="modal-head"><h2>展示大屏 · 快捷操作</h2><button class="close" @click="$emit('close')">×</button></div>
      <div class="sp-tip" style="margin-bottom:10px">勾选的场景 / 脚本、添加的实体都会出现在展示页的展示项条里（单行横滚，可点击）；按楼层独立配置</div>

      <div class="dcm-cols">
      <section class="dcm-col">
      <h4 class="dcm-h">🎬 场景（{{ sceneOptions.length }}）</h4>
      <div class="dev-list dcm-list">
        <label class="dev-item chk" v-for="s in sceneOptions" :key="s.eid">
          <input type="checkbox" :checked="has(s.eid)" :disabled="full && !has(s.eid)" @change="toggle('scene', s.eid)">
          <div class="m"><div class="n">{{ s.name }}</div><div class="s"><code>{{ s.eid }}</code></div></div>
        </label>
        <div class="sp-empty" v-if="!sceneOptions.length">HA 中暂无场景（scene 实体）<br>可在 Home Assistant 中创建后再来配置</div>
      </div>

      </section>
      <section class="dcm-col">
      <h4 class="dcm-h">📜 脚本（{{ scriptOptions.length }}）</h4>
      <div class="dev-list dcm-list">
        <label class="dev-item chk" v-for="s in scriptOptions" :key="s.eid">
          <input type="checkbox" :checked="has(s.eid)" :disabled="full && !has(s.eid)" @change="toggle('script', s.eid)">
          <div class="m"><div class="n">{{ s.name }}</div><div class="s"><code>{{ s.eid }}</code></div></div>
        </label>
        <div class="sp-empty" v-if="!scriptOptions.length">HA 中暂无脚本（script 实体）</div>
      </div>

      </section>
      <section class="dcm-col">
      <h4 class="dcm-h">⚙️ 居控中枢 · 动作与场景（{{ automationOptions.length }}）</h4>
      <div class="dev-list dcm-list">
        <label class="dev-item chk" v-for="a in automationOptions" :key="'auto-' + a.id">
          <input type="checkbox" :checked="has(a.id)" :disabled="full && !has(a.id)" @change="toggleAutomation(a)">
          <div class="m">
            <div class="n">{{ a.name }} <span v-if="!a.triggerable" class="dcm-warn" title="尚无正式版本，触发会被拒绝（先在居控中枢发布）">未发布</span></div>
            <div class="s"><code>{{ a.id }}</code> · {{ kindText(a.kind) }}<template v-if="a.description"> · {{ a.description }}</template></div>
          </div>
        </label>
        <div class="sp-empty" v-if="automationErr">
          居控中枢候选拉取失败：{{ automationErr }}<br><button class="tb-btn tiny" @click="loadAutomation">重试</button>
        </div>
        <div class="sp-empty" v-else-if="automationLoaded && !automationOptions.length">居控中枢暂无动作与场景（longRunning:false 的脚本/场景）</div>
        <div class="sp-empty" v-else-if="!automationLoaded">正在读取居控中枢候选…</div>
      </div>

      </section>
      <section class="dcm-col">
      <h4 class="dcm-h">💡 已添加的实体（{{ entityItems.length }}）</h4>
      <div class="dev-list dcm-list dcm-entities">
        <div class="dev-item" v-for="it in entityItems" :key="it.eid">
          <div class="m"><div class="n">{{ displayName(it) }}</div><div class="s"><code>{{ it.eid }}</code></div></div>
          <button class="tb-btn tiny" title="移除" @click="remove(it.eid)">移除</button>
        </div>
        <div class="sp-empty" v-if="!entityItems.length">还没有添加实体，用下方搜索框回车添加</div>
      </div>
      <div class="dcm-add">
        <entity-input v-model="newEid" :domains="allowedDomains"
          placeholder="搜索后，回车添加" @enter="addEntity"></entity-input>
      </div>
      <div class="sp-tip dcm-add-tip">
        仅支持 <b>light / switch / input_boolean</b>（点击切换，不等回执）。最多 {{ maxItems }} 项{{ full ? '（已满）' : '' }}。
      </div>
      </section>
      </div>

      <div class="form-row">
        <button class="tb-btn" @click="sortOpen = true">↕ 排序&改名（{{ items.length }}）</button>
        <button class="tb-btn" @click="clearAll">清空全部</button>
        <button class="tb-btn primary" @click="$emit('close')">完成</button>
      </div>
    </div>
  </div>

  <!-- 排序弹窗：列表顺序即展示页从左到右的顺序，↑↓ 调整，即时保存 -->
  <div class="modal sort-modal" v-show="sortOpen">
    <div class="modal-box sort-box">
      <div class="modal-head"><h2>快捷操作 · 调整顺序&名称</h2><button class="close" @click="sortOpen = false">×</button></div>
      <div class="sp-tip" style="margin-bottom:10px">列表顺序即展示页从左到右的排列；用 ↑ ↓ 调整，✎ 可自定义显示名（清空即恢复默认），改动即时保存。</div>
      <div class="sort-list">
        <div class="sort-row" v-for="(it, i) in items" :key="it.eid">
          <span class="sort-no">{{ i + 1 }}</span>
          <div class="m">
            <input v-if="renameEid === it.eid" ref="renameInput" v-model="renameText"
                   class="rename-input" spellcheck="false" :placeholder="originalName(it)"
                   @keyup.enter="confirmRename(it)" @keyup.esc="cancelRename" @blur="confirmRename(it)">
            <div v-else class="n">{{ displayName(it) }} <span class="sort-kind">{{ kindText(it.kind) }}</span></div>
            <div class="s"><code>{{ it.eid }}</code>
              <span v-if="isCustom(it)" class="rename-ok">原名：{{ originalName(it) }}</span>
            </div>
          </div>
          <div class="sort-ops">
            <button class="tb-btn tiny" @click="startRename(it)" title="自定义显示名">✎</button>
            <button class="tb-btn tiny" :disabled="i === 0" @click="move(i, -1)" title="上移">↑</button>
            <button class="tb-btn tiny" :disabled="i === items.length - 1" @click="move(i, 1)" title="下移">↓</button>
          </div>
        </div>
        <div class="sp-empty" v-if="!items.length">还没有添加快捷操作，先在配置里勾选或添加</div>
      </div>
      <div class="form-row">
        <button class="tb-btn primary" @click="sortOpen = false">完成排序</button>
      </div>
    </div>
  </div>
</template>

<script>
/*
 * DispCfgModal — 展示大屏「展示项」配置弹窗（2026-11-15 方案 B）。
 *
 * 数据结构：floor.display.displayItems = [{ eid, kind, name?, icon?, svg?, action? }]
 *   · kind = 'scene' | 'script'：HA 自动列举全部 scene.* / script.*，勾选即启用；
 *   · kind = 'automation'：从 home 服务端代理 /api/automation/actions 拉取居控中枢的
 *     动作与场景（longRunning:false），勾选写入短码 id + name + svg（2026-11-25）；
 *   · kind = 'entity'：EntityInput 搜索添加，**只允许 light / switch / input_boolean**
 *     （2026-11-16 用户指定；域白名单直接复用 displayAction 的 TOGGLE_DOMAINS）。
 * 旧的 displayScenes / quickDevices 已废止，用户明确要求不做兼容迁移。
 * 其它域由 model/displayAction.js 按域分派服务。
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
import { fetchAutomationActions } from '../../../services/automation.js';

export default {
  name: 'DispCfgModal',
  components: { EntityInput },
  emits: ['close', 'dirty'],
  data() {
    return {
      newEid: '',
      automationOptions: [],
      automationLoaded: false,
      automationErr: '',
      sortOpen: false,
      renameEid: null,
      renameText: '',
    };
  },
  watch: {
    open(v) { if (v) this.loadAutomation(); else { this.sortOpen = false; this.cancelRename(); } },
  },
  mounted() { if (this.open) this.loadAutomation(); },
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
    /* 候选由 home 服务端代理拉取；失败只影响这一组，HA 场景/脚本照常可配。 */
    async loadAutomation() {
      this.automationLoaded = false;
      this.automationErr = '';
      try {
        const items = await fetchAutomationActions();
        this.automationOptions = Array.isArray(items) ? items : [];
        this.automationLoaded = true;
      } catch (e) {
        this.automationOptions = [];
        this.automationLoaded = true;
        this.automationErr = (e && e.message) || '未知错误';
      }
    },
    kindText(kind) {
      if (kind === 'scene') return '场景';
      if (kind === 'script') return '脚本';
      if (kind === 'entity') return '实体';
      return '动作';
    },
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
    toggle(kind, eid, extra) {
      const arr = this.ensure();
      if (!arr) return;
      const i = arr.findIndex((it) => it.eid === eid);
      if (i >= 0) arr.splice(i, 1);
      else if (!this.full) arr.push(Object.assign({ eid, kind }, extra || {}));
      else return;
      this.$emit('dirty');
    },
    /* automation 项把 name / srcName / svg 一并写进配置：name 是显示名（可被
     * ✎ 改名覆盖），srcName 保留来源原名供对照；展示页脱离 automation 也能显示。 */
    toggleAutomation(a) {
      const svg = a.svg || a.icon;
      this.toggle('automation', a.id, {
        name: a.name || a.id,
        srcName: a.name || a.id,
        ...(typeof svg === 'string' && svg ? { svg } : {}),
      });
    },
    /* 原名：automation 项优先用候选列表实时值，其次配置里的 srcName；
     * HA 场景/脚本/实体用友好名。isCustom = 显示名与原名不同才算改名过。 */
    originalName(it) {
      if (it.kind === 'automation') {
        const a = this.automationOptions.find((x) => x.id === it.eid);
        if (a && a.name) return a.name;
        if (it.srcName) return it.srcName;
      }
      const A = typeof window !== 'undefined' ? window.HA : null;
      return A && A.friendly ? A.friendly(it.eid) : it.eid;
    },
    isCustom(it) {
      const v = it.name || '';
      return !!v && v !== this.originalName(it);
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
    /* 排序：交换 items 数组中相邻两项的位置（展示页按数组顺序横滚）。 */
    move(i, delta) {
      const arr = this.ensure();
      if (!arr) return;
      const j = i + delta;
      if (j < 0 || j >= arr.length) return;
      const tmp = arr[i];
      arr.splice(i, 1, arr[j]);
      arr.splice(j, 1, tmp);
      this.$emit('dirty');
    },
    /* 自定义显示名：写进配置项的 name 字段（展示页 it.name 优先，四类来源通用）。
     * 清空提交 = 恢复默认名（删除 name 字段）。blur 与 enter 都会触发，
     * 靠 renameEid 已清空来防止二次提交。 */
    startRename(it) {
      this.renameEid = it.eid;
      this.renameText = it.name || '';
      this.$nextTick(() => {
        const r = this.$refs.renameInput;
        const el = Array.isArray(r) ? r[0] : r;
        if (el) { el.focus(); el.select(); }
      });
    },
    confirmRename(it) {
      if (this.renameEid !== it.eid) return;
      const arr = this.ensure();
      const row = arr && arr.find((x) => x.eid === it.eid);
      if (row) {
        const v = (this.renameText || '').trim();
        if (v) row.name = v;
        else delete row.name;
        this.$emit('dirty');
      }
      this.cancelRename();
    },
    cancelRename() { this.renameEid = null; this.renameText = ''; },
  },
};
</script>

<style scoped>
/* 四列并排：场景 / 脚本 / 居控中枢 / 已添加实体。弹窗整体加宽，窄屏回退单列。 */
.modal-box.disp-cfg { width: min(1080px, 95vw); }
.dcm-cols { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: start; }
.dcm-col { min-width: 0; }
.dcm-col .dcm-h { margin-top: 0; }
.dcm-col code { word-break: break-all; }
.dcm-h { font-size: 13px; margin: 10px 0 6px; }
.dcm-list { max-height: 132px; padding: 0 2px; overflow-y: auto; }
.dcm-cols .dcm-list { max-height: 300px; }
.dcm-cols .dcm-entities { max-height: 232px; }
.dcm-add { display: flex; align-items: center; margin-top: 10px; }
.dcm-col .dcm-add { align-items: stretch; }
.dcm-col .dcm-add .ent-input { width: 100%; }
.dcm-add-tip { margin-top: 6px; font-size: 11px; color: var(--ink2); line-height: 1.5; }
.dcm-warn { color: var(--warn, #c77700); font-size: 11px; margin-left: 4px; }
/* 排序弹窗：盖在配置弹窗之上（z-index 高于 .modal 的 50） */
.sort-modal { z-index: 60; }
.modal-box.sort-box { width: min(520px, 94vw); }
.sort-list { max-height: 56vh; overflow-y: auto; padding: 0 2px; }
.sort-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; margin-bottom: 6px; border: 1px solid var(--line); border-radius: 10px; background: var(--card-tile); }
.sort-no { flex: none; width: 22px; height: 22px; border-radius: 50%; background: var(--blue-soft, #e8f0fe); color: var(--ink2); font-size: 11px; display: flex; align-items: center; justify-content: center; }
.sort-row .m { flex: 1; min-width: 0; }
.sort-row .n { font-size: 13px; font-weight: 600; }
.sort-row .s { font-size: 11px; color: var(--ink2); margin-top: 2px; }
.sort-row code { word-break: break-all; }
.sort-kind { font-size: 10px; color: var(--ink2); font-weight: 400; border: 1px solid var(--line); border-radius: 8px; padding: 0 5px; margin-left: 4px; }
.sort-ops { flex: none; display: flex; gap: 4px; }
.sort-ops .tb-btn { padding: 4px 9px; }
/* 自定义显示名：行内编辑输入框 + 「已自定义」小标 */
.rename-input { width: 100%; max-width: 240px; font-size: 13px; font-weight: 600; padding: 4px 8px; border: 1px solid var(--blue, #4a90d9); border-radius: 8px; background: var(--card-tile); color: var(--ink); outline: none; }
.rename-ok { font-size: 10px; color: var(--blue, #4a90d9); margin-left: 6px; }
@media (max-width: 900px) {
  .dcm-cols { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dcm-cols .dcm-list { max-height: 200px; }
}
@media (max-width: 600px) {
  .modal-box.disp-cfg { width: min(420px, 94vw); }
  .dcm-cols { grid-template-columns: 1fr; }
  .dcm-cols .dcm-list { max-height: 150px; }
}
</style>
