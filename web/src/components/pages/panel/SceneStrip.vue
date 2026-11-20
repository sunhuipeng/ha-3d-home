<template>
  <!-- 展示项：图标磁贴。窄屏 / 宽屏都保持单行横滚（项变多不换行、不挤压 3D 取景）。
       类名 .p-scenes 是历史类名，被 _stageEnsure 取景锚点与窄屏横滚手势白名单引用，别改。
       点按走 v-tap：横滑展示项条时浏览器补发的 click 不会误执行 automation / script。 -->
  <div class="p-scenes" id="tv-zone-scenes">
    <button v-for="s in items" :key="s.eid" class="p-scene"
      :class="{ busy: sceneBusy[s.eid], ok: sceneDone[s.eid], lit: s.toggle && s.on }"
      :disabled="!!sceneBusy[s.eid]" :title="titleOf(s)" v-tap="() => run(s)">
      <span v-if="sceneBusy[s.eid]" class="spin"></span>
      <!-- 执行结束：场景 / 脚本把图标换成 ✓ 短暂停留（开关类不换：点完状态灯即反映） -->
      <span v-else-if="sceneDone[s.eid] && !s.toggle" class="ps-ok">✓</span>
      <span v-else class="ps-ico">
        <!-- 图标：HA 实体 attributes.icon / 项目自定义 / domain 默认 mdi 优先，
             都没有才用按名称猜的 emoji（脚本固定 📜） -->
        <i v-if="s.mdi" class="mdi" :class="'mdi-' + s.mdi"></i>
        <template v-else>{{ s.icon }}</template>
      </span>
      <span class="ps-name">{{ s.name }}</span>
      <!-- 开关类（light / switch / input_boolean）：右上角状态灯，HA 推送后实时跟随 -->
      <span v-if="s.toggle" class="ps-dot" :class="{ on: s.on }"></span>
    </button>
  </div>
</template>

<script>
/* 无状态：展示项列表与「执行中 / 已确认」标记由父页给，点击只 emit 描述符。 */
import { vTap } from '../../../composables/useTap.js';

export default {
  name: 'SceneStrip',
  directives: { tap: vTap },
  props: {
    items: { type: Array, default: () => [] },
    sceneBusy: { type: Object, default: () => ({}) },
    sceneDone: { type: Object, default: () => ({}) },
  },
  emits: ['run'],
  methods: {
    run(s) { this.$emit('run', s); },
    titleOf(s) {
      if (s.toggle) return s.name + ' · 点击切换（当前' + (s.on ? '开启' : '关闭') + '）';
      return s.name + ' · 点击执行';
    },
  },
};
</script>

<style scoped>
.p-scenes {
  grid-area: scenes; position: relative; z-index: 1;
  display: flex; align-items: center; flex-wrap: nowrap; gap: 8px; min-width: 0; padding: 2px;
  overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}
.p-scenes::-webkit-scrollbar { display: none; }
.p-scene {
  position: relative;
  flex: 0 0 auto; width: 66px; height: 62px; padding: 0 4px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px;
  border-radius: 15px; color: var(--ink);
  background: var(--glass-soft); border: 1px solid var(--glass-soft);
  backdrop-filter: blur(12px) saturate(1.1); -webkit-backdrop-filter: blur(12px) saturate(1.1);
  box-shadow: 0 1px 3px rgba(20, 30, 50, .05);
  transition: background .15s, box-shadow .15s, transform .12s;
}
.p-scene:hover { background: var(--glass-hover); box-shadow: 0 3px 10px rgba(20, 30, 50, .09); }
.p-scene:active { transform: scale(.96); }
.p-scene.busy { opacity: .7; }
/* 执行中：图标位换成转圈（.spin 为全局动画类），文字保持可读 */
.p-scene.busy .ps-name { opacity: .75; }
/* 执行结束：✓ 顶替图标位，带一个轻微弹出，颜色跟随 .ok 的皮肤变量 */
.ps-ok {
  font-size: 18px; font-weight: 700; line-height: 1;
  animation: ps-ok-pop .18s ease-out;
}
@keyframes ps-ok-pop {
  from { transform: scale(.55); opacity: .3; }
  to { transform: scale(1); opacity: 1; }
}
/* 开关类「开」/ 执行成功：底色、描边、文字全走皮肤变量。
   「开」不用橘/黄底（用户 2026-11-15）：中性灰底 + 描边 + 字重，与关闭态拉开层次即可；
   夜间尤其不能留浅黄底 —— 白字压浅底根本看不清。.ok 放在后面，执行反馈优先。 */
.p-scene.lit { background: var(--scene-lit-bg); border-color: var(--scene-lit-line); color: var(--scene-lit-ink); }
/* 只靠底色对比还不够醒目：开态文字加一档字重，关态保持常规 */
.p-scene.lit .ps-name { font-weight: 600; }
.p-scene.ok { background: var(--scene-ok-bg); border-color: var(--scene-ok-line); color: var(--scene-ok-ink); }
.ps-ico { font-size: 19px; line-height: 1; }
.ps-name {
  max-width: 100%; font-size: 11.5px; line-height: 1.1; letter-spacing: .2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ps-dot {
  position: absolute; top: 7px; right: 7px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--scene-dot); box-shadow: 0 0 0 2px var(--glass);
}
.ps-dot.on {
  background: var(--scene-dot-on);
  box-shadow: 0 0 0 2px var(--glass), 0 0 6px var(--scene-dot-glow);
}

@media (min-width: 1024px) {
  /* 宽屏同样单行横滚：项目多时不再换行撑高右栏、挤掉 3D 取景高度 */
  .p-scenes { padding: 14px 14px 0 0; gap: 8px; }
  .p-scene { width: 92px; height: 60px; }
}
</style>
