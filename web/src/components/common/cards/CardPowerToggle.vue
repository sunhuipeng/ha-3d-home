<template>
  <!-- 设备标题右侧的电源开关（全屋/房间的设备子卡标题、单设备的总标题都用它）。
       完全复用插件自身的 isOn 与 click：开/关状态走 HA.deviceIsOn（= 插件顶层 isOn），
       点击走 HA.toggle（= PluginEngine.clickSpec 取的插件 click → callService）。
       文字直接取插件 click.label 的「开词/关词」两段（开=蓝字、关=中性），不再写死「开/关」：
       · light/switch…  '开 / 关'   → 开=开、关=关
       · vacuum         '开始清扫 / 回充' → 开着显示「开始清扫」、关着显示「回充」
       · lock           '开锁 / 上锁' → 开着显示「开锁」、关着显示「上锁」
       · speaker        '播放 / 暂停' → 开着显示「播放」、关着显示「暂停」
       右侧配一个小圆点状态灯：开=蓝点、关=灰点；插件没声明 click（不可点）则不渲染。 -->
  <button v-if="clickable" class="dc-power" :class="{ on: on }" type="button"
    :title="powerTitle" v-tap="fire">
    <span class="dc-power-txt">{{ powerLabel }}</span>
    <span class="dc-power-dot"></span>
  </button>
</template>

<script>
import { useHaStore } from '../../../stores/ha.js';
import { vTap } from '../../../composables/useTap.js';
export default {
  name: 'CardPowerToggle',
  directives: { tap: vTap },
  props: {
    /* 主实体的判定/点击所需信息，直接来自卡片节点的 _eid / _type / _style（引擎在 buildCard 时写入） */
    eid: { type: String, required: true },
    type: { type: String, default: '' },
    style: { type: [String, null], default: null },
    /* 实例级点击覆盖（卡片节点的 _click / _clickSvc）：只有带上它，电源开关的显隐
     * 才能和 3D 标签 / 属性面板勾选框同一口径（click:false、defaultOn:false 都不渲染） */
    clickFlag: { type: Boolean, default: null },
    clickSvc: { type: String, default: '' },
    /* 完整实例对象（卡片节点的 _dev，来自 useCards.cardOf）：复合 isOn（如
     * 「主实体开 且 功率 > 0」）要读实例上的 fields 绑定（powerEntity 等），
     * 只用 eid/type/style 重建的 inst 拿不到 —— 判定恒 false、点击方向也错。
     * 没有就回退 inst（兜底卡等没有 _dev 的场景，其 isOn 不依赖 fields）。 */
    dev: { type: Object, default: null },
  },
  emits: ['act'],
  computed: {
    /* 判定 / 点击用的实例：优先完整 dev，回退重建的 inst */
    target() {
      return (this.dev && this.dev.entityId) ? this.dev : this.inst;
    },
    /* 实例级「能不能点」的唯一口径（PluginEngine.instanceClickSpec）：
     * 插件没声明 click / 实例 click:false / defaultOn:false 且未显式开启 → 不渲染开关。
     * 顺带拿到整份 clickSpec（label 给开/关词用），只算一次。 */
    spec() {
      const pe = window.PluginEngine;
      if (!pe || typeof pe.instanceClickSpec !== 'function') return null;
      return pe.instanceClickSpec(this.inst, this.type || String(this.eid).split('.')[0]) || null;
    },
    inst() {
      return {
        entityId: this.eid, type: this.type, style: this.style,
        click: this.clickFlag == null ? undefined : this.clickFlag,
        clickSvc: this.clickSvc || '',
      };
    },
    clickable() { return !!this.spec; },
    /* 当前开着？统一判定链 HA.deviceIsOn → 插件顶层 isOn → 默认规则。
     * HA.entities 是普通 Map（非响应式），靠读一次每次推送都会 ++ 的 ha.entityVersion
     * 建立依赖来触发重算（与 useCards.view / useHud 同一套口径）。
     * 比手动订阅 HA.on('change') 更简单：无需生命周期管理、无监听泄漏/内部结构耦合；
     * 真实 HA 的增量是 {batch:true}（无 entity_id），订阅版在这种主路径下也得全量 sync，
     * 性能等价。 */
    on() {
      void useHaStore().entityVersion;
      const HA = window.HA;
      if (!HA || !HA.deviceIsOn) return false;
      return !!HA.deviceIsOn(this.target);
    },
    /* 把插件 click.label（"开 / 关" 或 "开始清扫 / 回充" 这类）按 "/" 拆成「开词 / 关词」。
     * 没有分隔符（"切换" / "停止" 这类 feedback 动作）则开/关都用同一个词。
     * 取不到 label 时回退到「开 / 关」。 */
    _words() {
      const label = (this.spec && this.spec.label) || '开 / 关';
      const parts = label.split('/').map((s) => s.trim());
      return parts.length > 1 ? [parts[0], parts[1]] : [parts[0], parts[0]];
    },
    /* 右侧胶囊的文字：开着显示开词、关着显示关词（不再写死「开 / 关」） */
    powerLabel() { return this.on ? this._words[0] : this._words[1]; },
    /* 悬停提示：开着时点一下会执行关词动作、关着时点一下会执行开词动作 */
    powerTitle() { return this.on ? ('点击' + this._words[1]) : ('点击' + this._words[0]); },
  },
  methods: {
    fire() {
      const HA = window.HA;
      if (!HA || !HA.toggle) return;
      /* 方向判定（HA.toggle 内部 deviceIsOn）与状态显示同一份实例：
       * 用残缺 inst 的话，「运行中点关」会因复合判定 false 反发 turn_on */
      HA.toggle(this.target, this.type);
    },
  },
};
</script>

<style scoped>
/* 标题电源开关：胶囊 + 左侧开/关文字 + 右侧小圆点状态灯。
   开态强调底 + 强调字/点（夜间由 --on 系列变量自动降饱和）；关态中性灰、灰点。
   统一尺度（2026-11-14）：高 26→32px、字 12.5px、状态点 9px，与主胶囊同一套
   描边 + 轻投影语言。仍是 999px 胶囊（宽度随文字自适应，不会拉成细长条）。
   ⚠ studio 只读版 CardPowerToggle 用同一组几何值。 */
.dc-power {
  display: inline-flex; align-items: center; gap: 7px;
  height: 32px; padding: 0 13px; flex: none;
  border: 1px solid var(--card-border); border-radius: 999px; background: var(--card-chip);
  box-shadow: 0 1px 3px rgba(31, 45, 71, .08);
  cursor: pointer; transition: background .16s, border-color .16s;
}
.dc-power:hover { border-color: var(--card-border); background: var(--card-chip-hover); }
.dc-power:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.dc-power-txt { font-size: 12.5px; color: var(--ink2); transition: color .16s; }
/* 小圆点状态灯：关=灰、开=蓝 */
.dc-power-dot {
  width: 9px; height: 9px; border-radius: 50%; background: var(--dot-idle); flex: none;
  transition: background .16s, box-shadow .16s;
}
.dc-power.on { background: var(--on-bg); border-color: var(--on-line); box-shadow: 0 2px 7px var(--on-glow); }
.dc-power.on .dc-power-txt { color: var(--on-ink); font-weight: 600; }
.dc-power.on .dc-power-dot { background: var(--on-ink); box-shadow: 0 0 0 3px var(--on-glow); }
</style>
