<template>
  <div class="ent-input">
    <input :value="text" :placeholder="placeholder" spellcheck="false"
           @input="onInput($event)" @focus="onFocus" @blur="onBlur" @keydown.esc="open = false">
    <div class="ent-drop" v-if="open && items.length" :style="dropStyle">
      <button type="button" class="ent-opt" v-for="s in items" :key="s.entity_id" @mousedown.prevent="pick(s)">
        <span class="col">
          <span class="l1">
            <span class="n">{{ (s.attributes && s.attributes.friendly_name) || s.entity_id }}</span>
            <span class="st" :class="{on: stOn(s)}">{{ stText(s) }}</span>
          </span>
          <span class="l2">
            <code>{{ s.entity_id }}</code>
          </span>
        </span>
      </button>
    </div>
  </div>
</template>

<script>
/*
 * entity-input — 可复用的实体搜索输入组件
 * 边输入边搜索 HA 实体（实体 ID / 友好名），下拉点选后回填完整实体 ID；
 * 也可直接手输。用于天气实体、数据卡、插件实体字段等所有"绑定实体"的输入框。
 *
 * 由原 public/js/app.js 内联的 EntityInput 组件迁移为独立 SFC（逻辑/模板 1:1）。
 * HA 等共享全局直接沿用，不重复引入。
 */
export default {
  name: 'EntityInput',
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: 'sensor.xxx' },
    domains: { type: Array, default: null },   // 可选: 只搜这些域（如 ['binary_sensor']）
  },
  emits: ['update:modelValue'],
  data() {
    return { text: this.modelValue || '', open: false, items: [], dropStyle: null };
  },
  watch: {
    modelValue(v) { if (v !== this.text) this.text = v || ''; },
  },
  mounted() {
    // 下拉打开期间容器滚动/窗口缩放时实时重定位（capture 捕获内部面板滚动）
    this._re = () => { if (this.open) this.place(); };
    window.addEventListener('scroll', this._re, true);
    window.addEventListener('resize', this._re);
  },
  unmounted() {
    window.removeEventListener('scroll', this._re, true);
    window.removeEventListener('resize', this._re);
  },
  methods: {
    search() {
      const q = (this.text || '').toLowerCase();
      const all = (window.HA ? HA.all() : []);
      this.items = all
        .filter((s) => {
          if (!s || !s.entity_id) return false;
          if (this.domains && this.domains.length && !this.domains.includes(s.entity_id.split('.')[0])) return false;
          if (!q) return true;
          const name = (s.attributes && s.attributes.friendly_name) || '';
          return s.entity_id.toLowerCase().includes(q) || String(name).toLowerCase().includes(q);
        })
        .slice(0, 8);
    },
    /* 下拉定位：JS 计算 + position:fixed，视口内钳制，永不超出屏幕或被容器裁剪 */
    place() {
      this.$nextTick(() => {
        const box = this.$el;
        if (!box || !box.querySelector) return;
        const el = box.querySelector('.ent-drop');
        if (!el) return;
        const r = box.getBoundingClientRect();
        const dw = el.offsetWidth, dh = el.offsetHeight;
        const pad = 8;
        // 水平：先贴输入框左缘，超右则整体左移钳制在视口内
        let left = r.left;
        if (left + dw > window.innerWidth - pad) left = window.innerWidth - pad - dw;
        if (left < pad) left = pad;
        // 垂直：默认向下弹；下方放不下且上方空间更大则向上弹
        let top = r.bottom + 4;
        if (top + dh > window.innerHeight - pad && r.top - dh - 4 > pad) top = r.top - dh - 4;
        this.dropStyle = {
          position: 'fixed',
          top: Math.round(top) + 'px',
          left: Math.round(left) + 'px',
          minWidth: Math.min(r.width, 360) + 'px',
        };
      });
    },
    onInput(e) {
      this.text = e.target.value;
      this.$emit('update:modelValue', this.text.trim());
      this.search();
      this.open = true;
      this.place();
    },
    onFocus() { this.search(); this.open = true; this.place(); },
    onBlur() {
      setTimeout(() => { this.open = false; }, 150);
      const v = this.text.trim();
      if (v !== this.modelValue) this.$emit('update:modelValue', v);
    },
    pick(s) {
      this.text = s.entity_id;
      this.open = false;
      this.$emit('update:modelValue', s.entity_id);
    },
    stText(s) {
      const unit = HA.unitOf(s);
      if (s.state === 'on') return '开启';
      if (s.state === 'off') return '关闭';
      if (s.state === 'unavailable') return '不可用';
      return s.state + unit;
    },
    stOn(s) { return s.state === 'on'; },
  },
};
</script>
