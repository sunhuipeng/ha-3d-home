/*
 * composables/useBackground.js — 背景插件（原 EditApp.vue 的「背景」方法组）
 *
 * 背景（背景插件：统一返回 3D group，扁平或立体；静态或动态）。
 * 同 useNumEditing 的口径：导出方法组对象，根组件摊进 methods，`this` 指向
 * 组件实例（this.bgStyle / this.bgTick / this.dirty / this.toast / store Action）。
 *
 * 注入策略与 useStageBoot 的差异（审计 2.10 已知项，本轮只搬运不改行为）：
 * 编辑页是 bgOptions 的写入方，走 toRaw 直接引用；展示页走深拷贝隔离。
 */
import { toRaw } from 'vue';
import { newSettings } from '../model/catalog.js';

export const backgroundMethods = {
  applyBg() {
    if (!window.PluginEngine || !View3D.scene) return;
    this.bindBgSettings();
    /* 显式重放的三个前置动作（缺一个都会让背景与房屋错位）：
     * 1) init 时 View3D 还没 build 过，houseBounds() 返回 null，插件会按默认
     *    8×8 原点构图 —— 这里先把 project / house 对准当前楼层；
     * 2) 取消同层拖墙挂起的 160ms 重放，避免和本次显式重放并发双重建销 group；
     * 3) 成功后提交构图指纹，下一次 build 才不会误判「构图变了」再画一遍；
     *    失败不提交，留旧 key 让 build 自动重试。 */
    View3D.cancelBgReplay();
    View3D.ensureHouse(this.project, this.floorIdx);
    if (PluginEngine.applyBackground(this.bgStyle, View3D) === true) View3D.syncBgKey();
  },
  /* 把项目里的背景参数 / 实体绑定对象直接交给引擎（同一引用：面板改值 → 项目数据同步变 → 自动保存） */
  bindBgSettings() {
    if (!window.PluginEngine || !this.project) return;
    const s = this.project.settings || (this.project.settings = {});
    /* 老存档的实体绑定按样式存，这里就地合并成插件级一份（幂等），
     * 保证后续自动保存写进 data/project.json 的也是同一把 key。 */
    if (PluginEngine.migrateProjectBg) PluginEngine.migrateProjectBg(s);
    if (!s.backgroundOptions) s.backgroundOptions = {};
    if (!s.backgroundFields) s.backgroundFields = {};
    /* toRaw 剥掉响应式代理再交给引擎（「reactive 不进引擎」的家规）：
     * 编辑页是 bgOptions 的**写入方**，引擎改的是同一个 raw 目标 —— 自动保存
     * 序列化走 proxy 读同一份值，UI 重算由 bgTick 驱动，行为不变；
     * 但引擎拿到的不再是深层 Proxy，不会把 Vue 依赖收集拖进引擎热路径。 */
    PluginEngine.bgOptions = toRaw(s.backgroundOptions);
    PluginEngine.bgFields = toRaw(s.backgroundFields);
    /* bgOptions / bgFields 是挂在引擎上的普通对象（非 Vue 响应式）。首次初始化时
     * 面板可能已经先算过一次空值并缓存，这里用 bgTick 让依赖它们的计算属性
     * （位于 components/pages/editor/BackdropPanel.vue，通过 mapState 读
     * 全局 store 的 bgTick）在引用接好之后重算一次，避免刷新后显示旧值。 */
    this.bumpBg();
  },
  /* 改背景参数: 只重绘地面（不重建户型），即时生效并自动保存。
   * 重绘做 90ms 防抖——自绘类背景（1024 贴图 + 撒点）不能让滑块的每个 input 都跑一遍 */
  setBgOpt(key, val) {
    if (!this.bgStyle || !window.PluginEngine) return;
    this.bindBgSettings();
    const store = PluginEngine.bgOptions;
    const cur = store[this.bgStyle] || (store[this.bgStyle] = {});
    cur[key] = val;
    this.bumpBg();
    clearTimeout(this._bgOptTimer);
    this._bgOptTimer = setTimeout(() => this.applyBg(), 90);
    this.dirty();
  },
  /* 改背景的实体绑定：绑定只影响数据，不重建几何，所以只推一次 onData。
   * 值存 settings.backgroundFields['<插件id>'][key] —— 该插件所有样式共用，
   * 切样式不会丢；换回未绑定时删掉该键。 */
  setBgField(key, val) {
    if (!this.bgStyle || !window.PluginEngine || !key) return;
    this.bindBgSettings();
    const store = PluginEngine.bgFields;
    const pk = PluginEngine.bgFieldKey(this.bgStyle);
    const cur = store[pk] || (store[pk] = {});
    const eid = String(val || '').trim();
    if (eid) cur[key] = eid; else delete cur[key];
    this.bumpBg();
    this.dirty();
    PluginEngine.notifyBackgroundData(true);
  },
  setBackground(b) {
    if (!this.project) return;
    if (!this.project.settings) this.project.settings = newSettings();
    this.project.settings.background = b ? b.id : '';
    this.applyBg();
    this.dirty();   // 自动保存到 data/project.json
    this.toast(b ? ('背景已切换: ' + b.name) : '已恢复默认背景（纯色 + 网格）');
  },
};
