/*
 * composables/useRefImage.js — 参考底图（原 EditApp.vue 的「参考底图」方法组）
 *
 * 2D 户型图参考底图：全项目共用一张 —— 服务器端只存 data/refimg.* 一张图，
 * 画完户型图基本就弃用，没必要按楼层各存一份；经 /api/refimg 读取，
 * src 带 ?t= 时间戳防缓存，重复上传不用刷新页面即可看到新图。
 *
 * 文件选择框与 /api/upload 上传请求 → components/pages/editor/BgPanel.vue；
 * 上传成功后 emit('uploaded', {url,name}) 回到 applyBgImage。
 *
 * 同 useNumEditing 的口径：导出方法组对象，根组件摊进 methods，`this` 指向
 * 组件实例（this.project / this.bgW / this.bgInfo / this.dirty / this.toast），
 * 纯搬运零行为变化。
 */
export const refImageMethods = {
  /* 加载贴图并写入项目（bgImage 挂在 project 上：全楼层共用一张）。
   * src 追加 ?t= 时间戳：同一会话里重复上传时 URL 变化，浏览器不命中旧缓存 */
  applyBgImage(src, name) {
    if (src.startsWith('/api/refimg')) {
      src = src + (src.includes('?') ? '&' : '?') + 't=' + Date.now();
    }
    const img = new Image();
    img.onload = () => {
      const meta = { src, name: name || '贴图', x: 0, y: 0, w: 10, opacity: 0.35, hidden: false };
      Editor.backgroundImage = Object.assign({ img }, meta);
      this.bgW = 10;
      this.bgInfo = { has: true, hidden: false };
      if (this.project) this.project.bgImage = meta;
      Editor.render();
      this.dirty();
    };
    img.onerror = () => this.toast('图片加载失败');
    img.src = src;
  },
  /* 把编辑器中的贴图状态写回项目并标记保存 */
  writeBg() {
    const bg = Editor.backgroundImage;
    if (!this.project || !bg || !bg.src) return;
    this.project.bgImage = {
      src: bg.src, name: bg.name || '贴图',
      x: bg.x, y: bg.y, w: bg.w,
      opacity: bg.opacity == null ? 0.35 : bg.opacity,
      hidden: !!bg.hidden,
    };
    this.dirty();
  },
  /* 楼层切换/载入时恢复贴图（项目级共用，切层不换图） */
  syncBg() {
    const b = this.project && this.project.bgImage;
    const cur = Editor.backgroundImage;
    if (!b || !b.src) {
      if (cur && cur.src) { Editor.backgroundImage = null; this.bgInfo = { has: false, hidden: false }; Editor.render(); }
      return;
    }
    if (cur && cur.src === b.src) {
      Object.assign(cur, { x: b.x, y: b.y, w: b.w, opacity: b.opacity, hidden: !!b.hidden });
      this.bgW = b.w || 10;
      this.bgInfo = { has: true, hidden: !!b.hidden };
      Editor.render();
      return;
    }
    const img = new Image();
    img.onload = () => {
      // 载入期间项目可能已被撤销/重做替换
      if (!this.project || !this.project.bgImage || this.project.bgImage.src !== b.src) return;
      Editor.backgroundImage = Object.assign({}, this.project.bgImage, { img });
      this.bgW = this.project.bgImage.w || 10;
      this.bgInfo = { has: true, hidden: !!this.project.bgImage.hidden };
      Editor.render();
    };
    img.src = b.src;
  },
  toggleBg() {
    const bg = Editor.backgroundImage;
    if (!bg || !bg.img) return;
    bg.hidden = !bg.hidden;
    this.bgInfo = { has: true, hidden: !!bg.hidden };
    this.writeBg();
    Editor.render();
  },
  onBgScale(e) {
    const bg = Editor.backgroundImage;
    if (!bg || !bg.img) return;
    const nw = parseFloat(e.target.value) || 10;
    // 缩放锚点 = 图片中心：调整左上角位置使中心保持不动
    const ratio = bg.img.height / bg.img.width;
    bg.x += (bg.w - nw) / 2;
    bg.y += (bg.w - nw) * ratio / 2;
    bg.w = nw;
    this.bgW = nw;
    this.writeBg();
    Editor.render();
  },
  clearBg() {
    Editor.backgroundImage = null;
    this.bgInfo = { has: false, hidden: false };
    // 保持贴图浮层打开，方便紧接着重新上传
    if (this.project && this.project.bgImage) { this.project.bgImage = null; this.dirty(); }
    Editor.render();
  },
};
