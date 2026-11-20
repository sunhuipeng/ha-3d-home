<template>
  <!-- 编辑页卡片预览层：固定在画布右上角的一块 HTML 覆盖层（2D / 3D 展示页共用一份）。
       卡片是真实 Vue 组件，不画进 canvas（canvas 只画户型几何）。
       位置固定 → 不跟随缩放/平移，因此引擎零改动（不需要 onRender 钩子）。
       2D：y = 72px 让开上边缘刻度尺(22) + 户型徽标 #houseBadge(top:34, 高约 30)；
       3D：这两样都 v-show 隐藏，顶到 16px 即可。 -->
  <div id="cardPreview" :class="{ 'is-3d': mode === '3d' }">
    <!-- 唯一的卡片组件：全屋 / 房间 / 单设备都是它，只是塞进去的设备不同。
         :key 用选中标识，切换设备/房间时整卡重建，避免索引复用导致 body 内容不刷新。 -->
    <CardView v-if="view" :key="cardKey" :node="view" preview @act="onAct" />

    <!-- 选中墙 / 普通家具等没有卡片的对象 -->
    <div v-else class="cp-empty">
      <div class="cp-empty-ico">🗂</div>
      <p>在{{ mode === '3d' ? '场景里点一下' : '画布上选中' }} <b>设备、房间或门窗</b>，这里就显示对应的卡片</p>
      <p class="cp-empty-sub">设备 / 门窗需先在「设备绑定」里选主实体，未绑定不显示卡片</p>
    </div>
  </div>
</template>

<script>
import { mapState, mapActions } from 'pinia';
import { useEditorStore } from '../../../stores/editor';
import { useUiStore } from '../../../stores/ui';
import { useCards } from '../../../composables/useCards';
import CardView from '../../common/cards/CardView.vue';

export default {
  name: 'CardPreviewLayer',
  components: { CardView },
  setup() {
    const editor = useEditorStore();
    /* 结构树只依赖选中项与当前楼层；值树依赖 ha.entityVersion。
     * 没选中任何东西（含选中墙/家具）时回退成「全屋」：卡片层默认就是把当前楼层
     * 所有设备列出来，用户再点房间/设备收敛。 */
    const { view, run } = useCards({
      selection: () => editor.selection || { kind: 'all' },
      floor: () => editor.cur,
    });
    return { view, run };
  },
  computed: {
    ...mapState(useEditorStore, ['mode', 'selection']),
    /* 卡片按选中标识做 key：切换设备/房间/全屋时整卡重建，杜绝复用旧 DOM 内容 */
    cardKey() {
      const sel = this.selection || { kind: 'all' };
      return 'card:' + (sel.kind + ':' + (sel.id || ''));
    },
  },
  methods: {
    ...mapActions(useUiStore, ['toast']),
    async onAct(node, value) {
      try {
        const r = await this.run(node, value);
        if (!r && node.action) this.toast('该动作没有可用的服务配置');
      } catch (e) {
        this.toast('操作失败：' + (e && e.message ? e.message : e));
      }
    },
  },
};
</script>

<style scoped>
#cardPreview {
  position: absolute; right: 14px; top: 72px; width: 320px;
  max-height: calc(100% - 100px); z-index: 24; pointer-events: auto;
  display: flex; flex-direction: column; min-height: 0;
}
/* 3D 展示页：刻度尺与户型徽标都隐藏（v-show mode==='2d'），顶到 16px 更贴边 */
#cardPreview.is-3d { top: 16px; max-height: calc(100% - 32px); }
#cardPreview > * { min-height: 0; }
.cp-empty {
  background: var(--glass); border: 1px dashed var(--card-border); border-radius: 14px;
  box-shadow: 0 8px 22px rgba(20, 30, 50, .12);
  padding: 18px 16px; text-align: center; color: var(--ink2); font-size: 12px; line-height: 1.7;
}
.cp-empty-ico { font-size: 22px; margin-bottom: 6px; }
.cp-empty b { color: var(--ink); }
.cp-empty-sub { font-size: 11px; color: var(--ink2); margin-top: 4px; }
</style>
