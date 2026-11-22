/*
 * neededPlugins.js — 从项目数据派生「展示页真正用到的插件 id 集合」（纯函数，可单测）
 *
 * 用途: 展示页 fetchProject() 之后、loadAll() 之前调用，得到一份插件 id 集合传给
 *       loadAll(needed)，只挂必要的 <script>；编辑页不用（样式面板要列全部造型）。
 *
 * 为什么能从项目算出来:
 *   每个可插件化实例的 style 都是 '<插件id>:<造型id>'（引擎 prefixItem 统一加前缀）——
 *   设备 floors[].devices[]（含 type:'furniture' 的家具插件）、门 floors[].doors[]、
 *   窗 floors[].windows[] 全都带 style；背景是 settings.background（同样是
 *   '<插件id>:<样式id>'）。取冒号前的插件 id 即得显式使用集合。
 *
 * 两个必须兜底的边界（漏了会渲染成占位/背景丢失）:
 *   1. 缺省 style: deviceStyleDef() 在实例没写 style 时取「该 type 第一个插件」，
 *      所以对每个出现过的 type 都要保证至少加载一个该 type 的插件。
 *      选取规则与引擎 defOf() 对齐: 清单里 id 与 type 同名者优先，否则该 type 第一个。
 *      —— 这里只能靠清单算: 此时插件还没加载，PluginEngine.defOf 尚不可用。
 *   2. 背景旧 id: settings.background 可能是历史 alias backdrop_ground:xxx，
 *      按 BG_ID_ALIAS 迁移后再取插件 id（与引擎 migrateBgId 同口径）。
 *
 * 返回值是 **id 集合**（不是 dir）: 插件清单同时有 id 与 dir/entry，id 才是项目里
 * 存的引用口径；loadAll 侧按 id 匹配清单项、取其 entry 加载（并兼容 id≠dir 的自定义包）。
 */

/* 与 engine/plugins.js 的 BG_ID_ALIAS 保持一致（背景旧 id 迁移）。
 * 不能 import 引擎（它依赖 three/DOM），这里只放同样的一行映射；改 alias 时两处同步。 */
export const BG_ID_ALIAS = { backdrop_ground: 'background' };

/* 取 '<插件id>:<造型id>' 里的插件 id；无冒号时整串即 id；空值返回 ''。
 * 顺带迁移背景旧 id（对非背景插件无副作用: alias 表里只有背景那一条）。 */
export function pluginIdOf(style) {
  if (typeof style !== 'string' || !style) return '';
  const i = style.indexOf(':');
  const id = i < 0 ? style : style.slice(0, i);
  return BG_ID_ALIAS[id] || id;
}

/* 从插件清单里取某 type 的默认插件 id —— 与引擎 defOf 同规则:
 *   id 与 type 同名者优先；否则该 type 第一个（顺序 = 清单顺序 = 内置先扫、custom 后扫覆盖）。
 * 背景插件(kind:'background')不参与设备 type 兜底。找不到返回 ''。 */
export function defaultIdForType(type, list) {
  if (!type || !Array.isArray(list)) return '';
  const pool = list.filter((p) => p && p.kind !== 'background' && p.type === type && p.id);
  if (!pool.length) return '';
  const same = pool.find((p) => p.id === type);
  return (same || pool[0]).id;
}

/*
 * 派生展示页必要插件 id 集合。
 * @param project  /api/project 返回的项目对象
 * @param list     /api/plugins 返回的插件清单数组（[{id,dir,entry,type,kind,...}]）
 * @returns Set<string> 必要插件 id；project/list 异常时返回空集（调用方应回退全量）
 */
export function neededPluginIds(project, list) {
  const out = new Set();
  if (!project || !Array.isArray(list) || !list.length) return out;

  const valid = new Set(list.map((p) => p && p.id).filter(Boolean));
  const types = new Set();

  const collect = (item, type) => {
    if (!item || typeof item !== 'object') return;
    if (type) types.add(type);
    const pid = pluginIdOf(item.style);
    if (pid && valid.has(pid)) out.add(pid);
  };

  /* 设备 + 家具插件（type:'furniture' 也在 devices 里）+ 门窗 */
  const floors = Array.isArray(project.floors) ? project.floors : [];
  for (const fl of floors) {
    if (!fl || typeof fl !== 'object') continue;
    for (const d of (Array.isArray(fl.devices) ? fl.devices : [])) {
      const type = (d && d.type) || '';
      collect(d, type);
    }
    for (const o of (Array.isArray(fl.doors) ? fl.doors : [])) collect(o, 'door');
    for (const o of (Array.isArray(fl.windows) ? fl.windows : [])) collect(o, 'window');
  }

  /* 背景：settings.background 自带插件 id，且 alias 迁移 */
  const bg = pluginIdOf(project.settings && project.settings.background);
  if (bg && valid.has(bg)) out.add(bg);

  /* 缺省 style 兜底: 每个出现过的 type 至少加载一个该 type 的默认插件。
   * 这样 d.style 为空时 deviceStyleDef 回退 list[0] 仍能命中已加载插件。 */
  for (const type of types) {
    const def = defaultIdForType(type, list);
    if (def) out.add(def);
  }

  return out;
}
