<template>
  <!-- 顶栏：房子名 + 亮灯统计 + 天气 + 视图工具 -->
  <header class="p-head">
    <div class="ph-id" id="tv-zone-home">
      <!-- 左上角房子图标：空壳 App 的 WebView 里点它唤起「服务器地址设置」
           （原生桥 AppShell 只在 App 内注入）；普通浏览器里无桥，纯装饰、点了没反应。
           宽屏原先的视图开关随 PC 展示板下线一并删除。 -->
      <button class="ph-ico" :class="{ act: inApp }" :title="inApp ? '服务器地址设置' : ''"
        v-tap="openSettings">🏠</button>
      <div class="ph-txt">
        <div class="ph-line">
          <b class="ph-name">{{ name }}<a class="ph-edit" v-if="wide && !inApp" href="/edit.html" title="打开编辑器修改户型">编辑 ↗</a></b>
        </div>
        <!-- 天气：独立一行（2026-11-16 改版）。原先窄屏与「家」挤同一行，屏宽不够时
             「多云 / 湿度」会在 span 内部竖着折行，非常难看；独立成行后放不下也只会在
             条目边界换行。有数据才渲染。 -->
        <span class="p-wx" v-if="hudSubs.length || hudTemp !== '--°' || (wide && hudBrief)">
          <span class="pw-ico" v-if="hudIcon">{{ hudIcon }}</span>
          <span class="pw-temp">{{ hudTemp }}</span>
          <span class="pw-sub" v-for="s in hudSubs" :key="s">{{ s }}</span>
          <!-- 降水简报（minutely_summary）只在宽屏追加：太长，窄屏手机显示不全 -->
          <span class="pw-sub pw-brief" v-if="wide && hudBrief">{{ hudBrief }}</span>
        </span>
        <span class="ph-sub" :class="netClass" :title="statusText">
          <i class="dot"></i>{{ onCount }} / {{ deviceTotal }} 运行中
        </span>
      </div>
    </div>
    <div class="ph-tools" id="tv-zone-tools">
      <!-- 图标用 MDI 字体（@mdi/font）：⟳ / 🏷 / ⛶ 这类 Unicode 字符在空壳
           WebView 的默认字体里缺字形会显示成空白（手机浏览器字体全才正常） -->
      <button :class="{ on: autoRotate }" title="自动旋转" v-tap="toggleRotate"><i class="mdi mdi-refresh"></i></button>
      <button class="ph-labels" :class="{ on: showLabels }" title="设备标签" v-tap="toggleLabels"><i class="mdi mdi-tag-text-outline"></i></button>
      <!-- 夜间模式：自读 lighting.js 单例并订阅广播，无需本组件透传 props / emits -->
      <night-toggle />
      <button title="全屏" v-if="!inApp" v-tap="fullscreen"><i class="mdi mdi-fullscreen"></i></button>
    </div>

    <!-- 实时数据卡：仅宽屏，挂在顶栏正下方（top:100% 跟随顶栏实际高度，不写死坐标） -->
    <div class="p-hud" id="tv-zone-hud" v-if="wide && hudCards.length">
      <div class="p-dcard" v-for="c in hudCards" :key="c.eid">
        <div class="k">{{ c.name }}</div>
        <div class="v">{{ c.value }}<small> {{ c.unit }}</small></div>
      </div>
    </div>
  </header>
</template>

<script>
/* 无状态：顶栏只按 props 显示 HUD / 视图开关，所有动作 emit 回 PanelApp。
   整块在 .p-shell(touch-action:none) 内，按钮统一走 v-tap，避免顶栏横滑误触。 */
import { vTap } from '../../../composables/useTap.js';
import NightToggle from '../../common/NightToggle.vue';

export default {
  name: 'PanelHeader',
  components: { NightToggle },
  directives: { tap: vTap },
  props: {
    name: { type: String, default: '家' },
    wide: { type: Boolean, default: false },
    inApp: { type: Boolean, default: false },
    hudTemp: { type: String, default: '--°' },
    hudIcon: { type: String, default: '' },
    hudSubs: { type: Array, default: () => [] },
    hudBrief: { type: String, default: '' },
    hudCards: { type: Array, default: () => [] },
    netClass: { type: Object, default: () => ({}) },
    statusText: { type: String, default: '' },
    onCount: { type: Number, default: 0 },
    deviceTotal: { type: Number, default: 0 },
    autoRotate: { type: Boolean, default: false },
    showLabels: { type: Boolean, default: true },
  },
  emits: ['open-settings', 'toggle-rotate', 'toggle-labels', 'fullscreen'],
  methods: {
    openSettings() { this.$emit('open-settings'); },
    toggleRotate() { this.$emit('toggle-rotate'); },
    toggleLabels() { this.$emit('toggle-labels'); },
    fullscreen() { this.$emit('fullscreen'); },
  },
};
</script>

<style scoped>
.p-head {
  /* 顶部安全区（状态栏/刘海）：壳 App 注入 --safe-top（px）；普通浏览器回退 env()，
     两个来源都没有时为 0 —— PC / 无刘海设备不受影响。3D 画布铺满整页不动，只有顶栏下移。 */
  position: absolute; left: 10px; right: 10px;
  top: calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 8px);
  z-index: 2;
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  min-width: 0;
}
.ph-id { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ph-ico {
  width: 40px; height: 40px; flex: none; border-radius: 13px; display: grid; place-items: center; font-size: 18px;
  background: var(--glass-soft); backdrop-filter: blur(12px) saturate(1.1);
  box-shadow: 0 1px 4px rgba(20, 30, 50, .08);
}
/* 图标统一是 button：默认无手型（浏览器里纯装饰）；App 内（.act）可点、有按压反馈 */
button.ph-ico {
  border: 0; padding: 0; color: inherit; font: inherit; background: var(--glass-soft);
  cursor: default; pointer-events: auto; -webkit-tap-highlight-color: transparent;
}
button.ph-ico.act { cursor: pointer; transition: background .15s, box-shadow .15s, transform .1s; }
button.ph-ico.act:hover { background: var(--card-tile); box-shadow: 0 2px 8px rgba(20, 30, 50, .14); }
button.ph-ico.act:active { transform: scale(.94); background: var(--card-tile); }
button.ph-ico.act:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.ph-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ph-name {
  font-size: 17px; font-weight: 700; color: var(--ink); line-height: 1.15;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ph-sub { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--ink2); white-space: nowrap; }
.ph-sub .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dot-idle); }
.ph-sub.on .dot { background: #34a853; }
.ph-sub.demo .dot { background: #f0a500; }
.ph-tools { display: flex; gap: 6px; flex: none; }
.ph-tools button {
  width: 34px; height: 34px; border-radius: 12px; font-size: 14px; line-height: 1;
  display: flex; align-items: center; justify-content: center; color: var(--ink2);
  background: var(--glass-soft); backdrop-filter: blur(12px) saturate(1.1);
  box-shadow: 0 1px 4px rgba(20, 30, 50, .07); transition: background .15s, color .15s;
}
.ph-tools button:hover { background: var(--card-tile); color: var(--ink); }
.ph-tools button.on { background: var(--card-tile); color: var(--on-ink); }
/* MDI 字体图标比 emoji 字形小，放大一号与原 glyph 视觉等重 */
.ph-tools .mdi { font-size: 17px; line-height: 1; }
/* 名字后面的「编辑 ↗」小链接（与大屏同款，回编辑器改户型） */
.ph-edit {
  margin-left: 8px; font-size: 11.5px; font-weight: 500; color: var(--on-ink);
  text-decoration: none; padding: 2px 6px; border-radius: 7px; vertical-align: 2px;
  transition: background .15s;
}
.ph-edit:hover { background: rgba(36, 86, 196, .09); }

/* ---------- 天气（独立一行，宽窄屏同构；窄屏不再与「家」挤同一行） ---------- */
.ph-line { display: block; }
.p-wx {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 3px 8px;
  margin-top: 2px; min-width: 0;
}
.pw-ico { font-size: 15px; line-height: 1; align-self: center; }
.pw-temp { font-size: 16px; font-weight: 700; color: #e8842c; line-height: 1; }
.pw-sub { font-size: 12px; color: var(--ink2); white-space: nowrap; }

/* ---------- 实时数据卡（仅宽屏，挂在顶栏下方） ---------- */
.p-hud {
  position: absolute; left: 14px; top: 100%; margin-top: 10px; z-index: 1;
  display: flex; flex-direction: column; gap: 8px;
  max-width: 220px; pointer-events: none;
}
.p-dcard {
  padding: 9px 14px; border-radius: 14px; min-width: 130px;
  background: var(--glass);
  backdrop-filter: blur(16px) saturate(1.05); -webkit-backdrop-filter: blur(16px) saturate(1.05);
  box-shadow: 0 8px 22px rgba(20, 30, 50, .10);
}
.p-dcard .k { font-size: 12px; color: var(--ink2); }
.p-dcard .v { font-size: 20px; font-weight: 700; color: var(--ink); line-height: 1.25; }
.p-dcard .v small { font-size: 12px; font-weight: 400; opacity: .6; }
/* 宽屏下天气大一号（顶栏有 14px 内边距，放得下） */
@media (min-width: 1024px), (min-width: 768px) and (min-height: 450px) and (min-aspect-ratio: 13/10) {
  .pw-temp { font-size: 22px; }
  .p-wx { gap: 8px; }
}

@media (max-width: 767px), (max-width: 1023px) and (max-height: 449px), (max-width: 1023px) and (max-aspect-ratio: 1299/1000) {
  /* 窄屏不显示设备标签，也就没有标签开关：按统一口径，点设备模型直接执行动作 */
  .ph-tools .ph-labels { display: none; }
}
@media (min-width: 1024px), (min-width: 768px) and (min-height: 450px) and (min-aspect-ratio: 13/10) {
  /* 宽屏顶栏回到网格左上角（不再浮在 3D 上） */
  .p-head { grid-area: head; position: relative; left: auto; right: auto; top: auto;
    padding: calc(var(--safe-top, env(safe-area-inset-top, 0px)) + 14px) 0 0 14px; }
}
</style>
