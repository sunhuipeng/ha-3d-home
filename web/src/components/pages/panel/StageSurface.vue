<template>
  <!-- 3D 舞台：脱离网格、铺满整页当归一背景（画布尺寸恒定，内容浮在上面） -->
  <div class="p-stage">
    <div id="pstage" class="p-canvas"></div>

    <!-- 慢设备首屏占位：3D 首帧上屏前的 CSS 动画。放在 #pstage 外（兄弟节点），
         既不被 View3D.init 追加的 canvas 盖住，也不被无 WebGL 时的 innerHTML 清掉。
         快设备（slow=false）不挂载，保持秒开的干净画面。 -->
    <div class="p-stage-loading" v-if="slow && !stageReady">
      <div class="psl-swap"><i class="psl-box a"></i><i class="psl-box b"></i></div>
      <div class="psl-text">3D 场景加载中…</div>
    </div>

    <floor-switch v-if="floors.length > 1" :floors="floors" :active-index="floorIdx"
      @select="(i) => $emit('select-floor', i)" />

    <!-- 切层加载动画：仅窄屏（手机重建慢，给个「在动了」的反馈），宽屏流程不设此标志 -->
    <transition name="pfl">
      <div class="p-floor-load" v-if="floorBusy">
        <span class="spin"></span>
      </div>
    </transition>
  </div>
</template>

<script>
import FloorSwitch from './FloorSwitch.vue';

/* 无状态：画布容器、楼层按钮与加载遮罩只按 props 渲染；楼层切换事件透传给父页。
   #pstage 是 View3D.init(stageId) 用的挂载点，id 不能改。 */
export default {
  name: 'StageSurface',
  components: { FloorSwitch },
  props: {
    floors: { type: Array, default: () => [] },
    floorIdx: { type: Number, default: 0 },
    floorBusy: { type: Boolean, default: false },
    slow: { type: Boolean, default: false },       // 慢设备（App 壳 / 触屏）才挂占位动画
    stageReady: { type: Boolean, default: false },  // 3D 首帧上屏后撤掉占位
  },
  emits: ['select-floor'],
};
</script>

<style scoped>
/* 3D 舞台（脱离网格、铺满整页：画布尺寸始终不变） */
.p-stage {
  position: absolute; inset: 0; z-index: 0;
  min-height: 0; min-width: 0; pointer-events: auto;
}
/* 画布不做任何整体滤镜/白纱：3D 要是它本来的颜色，盖一层白只会发灰显脏。 */
.p-canvas { position: absolute; inset: 0; }
.p-canvas :deep(canvas) { display: block; }

/* 切层加载遮罩（仅窄屏出现）：淡纱 + 转圈，挡住重建期间的点击（防连点）。
   淡纱走 --stage-veil：夜间换成深色纱，否则会盖一层刺眼的白。
   **enter 不做淡入**：切层在遮罩上屏后马上进入同步重建（主线程卡死、期间一帧
   都渲染不出来），如果还从 opacity:0 渐入，上屏那一帧只有 ~9% 不透明度 ——
   用户看到的就是「连遮罩都没出现」。出现即全显，只保留淡出。 */
.p-floor-load {
  position: absolute; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  background: var(--stage-veil);
  backdrop-filter: blur(1.5px);
  pointer-events: all;
}
.pfl-leave-active { transition: opacity .18s ease; }
.pfl-leave-to { opacity: 0; }

/* 慢设备首屏 3D 占位：居中三圈扩散波纹 + 文案。用主题变量，日/夜间都协调；
   pointer-events:none 不挡住底下楼层按钮 / 卡片的手势。z-index 低于 floor-switch
   与切层遮罩，3D 就绪（stageReady）整块撤掉。
   默认对齐整个 stage（宽屏 stage 就是左栏）；窄屏必须落到顶部 3D 可视带
   —— .p-stage 是全屏 absolute，若按 flex 居中会落到屏幕 50% 高度的白纸/卡片区，
   被 .p-shell::after 的羽化白底盖住，根本看不见。 */
.p-stage-loading {
  position: absolute; left: 0; right: 0; top: 0; bottom: 0; z-index: 80;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 16px; pointer-events: none;
}
@media (max-width: 1023px) {
  .p-stage-loading {
    bottom: auto;
    height: calc(var(--p-band, .38) * 100dvh);   /* 只占顶部 3D 带 */
    transform: translateY(40px);                /* 带内整体下移一点，更贴近房子中心 */
  }
}
/* 两个长方体来回交换前后：靠 CSS 3D 的 translateZ 拉开景深，两块各自
   translateX 对向滑动并交换 z 序，看起来像前后叠放的两块轮流到前面。
   全程 transform + opacity（合成属性），不占主线程、rebuild 卡住也照常动。 */
.psl-swap {
  position: relative;
  width: 132px; height: 84px;
  perspective: 320px;             /* 给 translateZ 景深，近者显大、远者显小 */
  transform-style: preserve-3d;
}
.psl-box {
  position: absolute; top: 50%; left: 50%;
  width: 64px; height: 40px;
  margin: -20px 0 0 -32px;
  border-radius: 6px;
  background: var(--blue, #6b8cff);
  box-shadow: 0 6px 14px rgba(59, 130, 246, .28);
  opacity: .9;
}
.psl-box.a { animation: psl-swap-a 2.4s ease-in-out infinite; }
.psl-box.b { animation: psl-swap-b 2.4s ease-in-out infinite; }
.psl-text { font-size: 13px; color: var(--ink2, #5a6678); letter-spacing: .05em; }
/* A：起点在左前（z 正、x 负、亮），中点退到右后（z 负、x 正、暗），再回。 */
@keyframes psl-swap-a {
  0%, 100% { transform: translate3d(-34px, 0, 40px) ; opacity: .95; }
  50%      { transform: translate3d(34px, 0, -40px); opacity: .5; }
}
/* B：与 A 完全反相，始终占住对面那格 —— 两块轮流到前面，就是「前后交换」。 */
@keyframes psl-swap-b {
  0%, 100% { transform: translate3d(34px, 0, -40px); opacity: .5; }
  50%      { transform: translate3d(-34px, 0, 40px) ; opacity: .95; }
}
@media (prefers-reduced-motion: reduce) {
  .psl-box.a, .psl-box.b { animation-duration: 4s; }
}
</style>
