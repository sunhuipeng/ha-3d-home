<template>
  <!-- 清扫地图（只读图片卡）：type: 'image' 专用，读 image 实体的 attributes.entity_picture。
       entity_picture（相对或 HA 绝对路径，含鉴权参数）统一走同源 /api/ha-media 代理显示；
       state 是 ISO 更新时间戳，用它当缓存参数让地图刷新后自动换图。
       只读、不响应点击、不发服务（要按钮请写 type: 'button'）。 -->
  <div class="dc-img" :class="{ dis: node._disabled }">
    <div class="dc-img-head" v-if="node.label">{{ node.label }}</div>
    <div class="dc-img-box">
      <img v-if="src" :src="src" :alt="node.label || '清扫地图'" @error="onError" />
      <div v-else class="dc-img-ph">{{ node._disabled ? '地图不可用' : '暂无地图' }}</div>
    </div>
  </div>
</template>

<script>
import { mapState } from 'pinia';
import { useHaStore } from '../../../stores/ha';

export default {
  name: 'CardImage',
  props: { node: { type: Object, required: true } },
  data() { return { failed: false }; },
  computed: {
    ...mapState(useHaStore, ['haUrl']),
    /* entity_picture → 可显示的图片 URL。
     * 1) 没有值 / 实体不可用 → 空（走占位）
     * 2) 已是 http(s) / data: 绝对地址 → 原样用
     * 3) HA 相对路径（/api/...，含 token）→ 拼 HA base（去尾斜杠）
     * 追加 &_t=<state 时间戳> 破浏览器缓存；state 不是时间戳时不加。 */
    src() {
      if (this.failed || this.node._disabled) return '';
      let pic = this.node._value;
      if (!pic || typeof pic !== 'string') return '';
      /* HA 绝对地址（entity_picture 有时是完整 URL）剥掉 haUrl 前缀变相对路径，
         统一走同源 /api/ha-media 代理——外网下内网地址不可达，不能直拼 */
      const base = (this.haUrl || '').replace(/\/+$/, '');
      if (base && pic.indexOf(base) === 0) pic = pic.slice(base.length);
      if (/^(data:|blob:|https?:\/\/)/i.test(pic)) {
        // 非 HA origin 的绝对地址：data/blob 无法加参数；http(s) 原样用
        return /^https?:\/\//i.test(pic) ? this.withTick(pic) : '';
      }
      return this.withTick('/api/ha-media' + (pic[0] === '/' ? '' : '/') + pic);
    },
  },
  watch: {
    'node._value'() { this.failed = false; },
  },
  methods: {
    withTick(url) {
      const t = this.node._state;
      if (typeof t !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(t)) return url;
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_t=' + encodeURIComponent(t);
    },
    onError() { this.failed = true; },
  },
};
</script>

<style scoped>
.dc-img { min-width: 0; }
.dc-img.dis { opacity: .6; }
.dc-img-head { font-size: 13px; color: var(--ink2); margin-bottom: 6px; }
.dc-img-box {
  position: relative; width: 100%; aspect-ratio: 4 / 3; max-height: 320px;
  border-radius: 8px; overflow: hidden; background: #eef1f5;
  border: 1px solid rgba(30, 40, 60, .08);
}
.dc-img-box img { display: block; width: 100%; height: 100%; object-fit: contain; }
.dc-img-ph {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: var(--ink2);
}
</style>
