/*
 * pluginCleanup.js — 编辑页「清理未使用插件」弹窗的数据派生（纯函数，可单测）
 *
 * 输入三份接口返回值 + 运行时插件样式定义，输出「自定义项 + 逐样式引用标记」：
 *   computeCleanupList(project, catalogItems, pluginList, styleDefs)
 *     project        /api/project
 *     catalogItems   /api/catalog 的 items 数组
 *     pluginList     /api/plugins 的 plugins 数组
 *     styleDefs      { [pluginId]: [{id, name?}] } —— 来自 PluginEngine.byId[id].styles
 *                    （样式是插件脚本 register() 时声明的，plugin.json 里没有）
 *
 * 只输出「自定义」项：插件走清单项 custom:true；家具包走 catalog 条目 custom:true
 * 并按 pack 聚合。内置资产不出现在清理列表里 —— 它们随镜像发布，删了下次升级又回来。
 *
 * 引用口径（用户拍板：缺省 style 的插件算被引用）:
 *   插件级 used 直接复用 neededPluginIds() —— 它已经覆盖
 *     ① 显式 style（devices / doors / windows / 背景，含 alias）
 *     ② 缺省 style 兜底：出现过的 type 把该 type 默认插件算作被引用
 *    所以这里不重写判定，避免与展示页按需加载的口径分叉。
 *   样式级 used 再细分：显式出现过的 '<插件id>:<样式id>' 逐个标记；
 *     缺省兜底命中的插件没有显式样式，则把它的第一个样式标记为 used
 *     （deviceStyleDef() 在缺 style 时正是取该 type 第一个样式），保证
 *     「整体禁用删除」与「至少有一个 used 样式」在 UI 上自洽。
 *   家具包级 used：furniture[].mid 命中条目 id，或实例手改的 model 反查命中条目 model。
 *
 * 删除用的目录名：插件取清单项 dir（id 可能与 dir 不同），家具包取 pack。
 * 服务端按这个目录名删 custom/ 下的对应目录。
 */

import { neededPluginIds, pluginIdOf } from './neededPlugins.js';

/* 收集项目里所有「显式写出来的」style 值（背景 alias 也归一到插件 id 口径）。
 * 与 neededPluginIds 的差别：这里不去兜底、不补默认，只统计真正存在字符串。 */
function explicitStyles(project) {
  const set = new Set();
  const add = (s) => {
    const v = typeof s === 'string' ? s.trim() : '';
    if (v) set.add(v);
  };
  const floors = Array.isArray(project && project.floors) ? project.floors : [];
  for (const fl of floors) {
    if (!fl || typeof fl !== 'object') continue;
    for (const d of (Array.isArray(fl.devices) ? fl.devices : [])) add(d && d.style);
    for (const o of (Array.isArray(fl.doors) ? fl.doors : [])) add(o && o.style);
    for (const o of (Array.isArray(fl.windows) ? fl.windows : [])) add(o && o.style);
  }
  add(project && project.settings && project.settings.background);
  return set;
}

/* 某插件「缺省兜底」用的第一个样式 id:该 type 里 list 顺序第一个 style。
 * 只用于给缺省命中的插件挑一个标 used 的行，规则与 deviceStyleDef 取 list[0] 一致。 */
function firstStyleId(def) {
  const styles = def && Array.isArray(def.styles) ? def.styles : [];
  for (const s of styles) if (s && s.id) return String(s.id);
  return '';
}

/* 把清单项 + 运行时样式定义拼成「逐样式 used」行。 */
function styleRows(plugin, def, usedExplicit, fallback) {
  const pid = plugin.id;
  const defStyles = def && Array.isArray(def.styles) ? def.styles : [];
  const rows = [];
  const seen = new Set();
  for (const s of defStyles) {
    if (!s || !s.id) continue;
    const sid = String(s.id);
    const full = pid + ':' + sid;
    if (seen.has(full)) continue;
    seen.add(full);
    rows.push({
      id: full,
      label: String(s.name || sid),
      used: usedExplicit.has(full),
    });
  }
  /* 样式定义没加载出来（插件脚本还没 ready）时，也要把项目里引用到的样式列出来，
   * 否则用户看不到「这个插件其实在用」而误删。 */
  for (const full of usedExplicit) {
    if (pluginIdOf(full) !== pid || seen.has(full)) continue;
    seen.add(full);
    rows.push({ id: full, label: full.slice(pid.length + 1), used: true });
  }
  if (fallback && rows.length) {
    /* 缺省兜底命中：确保至少第一行标 used（若有显式行已 used 则不重复改） */
    if (!rows.some((r) => r.used)) rows[0].used = true;
  } else if (fallback && !rows.length) {
    rows.push({ id: pid + ':', label: '默认样式', used: true });
  }
  return rows;
}

/**
 * 计算清理弹窗的自定义项列表。
 * @returns Array<{
 *   kind:'plugin'|'catalog', id:string, dir:string, name:string,
 *   used:boolean, styles:Array<{id,label,used}>
 * }>
 */
export function computeCleanupList(project, catalogItems, pluginList, styleDefs) {
  const plugins = Array.isArray(pluginList) ? pluginList : [];
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  const defs = styleDefs && typeof styleDefs === 'object' ? styleDefs : {};
  const usedPluginIds = neededPluginIds(project, plugins);
  const usedExplicit = explicitStyles(project);
  const out = [];

  /* ---- 自定义插件 ---- */
  for (const p of plugins) {
    if (!p || !p.id || p.custom !== true) continue;
    const pid = String(p.id);
    const used = usedPluginIds.has(pid);
    const def = defs[pid];
    /* 缺省兜底命中 = 整体 used 但没有任何显式样式命中这个插件 */
    const fallback = used && !Array.from(usedExplicit).some((s) => pluginIdOf(s) === pid);
    out.push({
      kind: 'plugin',
      id: pid,
      dir: String(p.dir || pid),   // 删除按 dir（id 可能与目录名不同）
      name: String(p.name || pid),
      type: String(p.type || p.kind || ''),
      used,
      styles: styleRows({ id: pid }, def, usedExplicit, fallback),
    });
  }

  /* ---- 自定义家具包：按 pack 聚合 ---- */
  const groups = new Map();
  for (const it of items) {
    if (!it || !it.custom || !it.pack) continue;
    const pack = String(it.pack);
    if (!groups.has(pack)) groups.set(pack, []);
    groups.get(pack).push(it);
  }
  const usedMids = new Set();
  const usedModels = new Set();
  const floors = Array.isArray(project && project.floors) ? project.floors : [];
  for (const fl of floors) {
    if (!fl || typeof fl !== 'object') continue;
    for (const f of (Array.isArray(fl.furniture) ? fl.furniture : [])) {
      if (!f) continue;
      if (typeof f.mid === 'string' && f.mid) usedMids.add(f.mid);
      if (typeof f.model === 'string' && f.model) usedModels.add(f.model);
    }
  }
  for (const [pack, packItems] of groups) {
    const rows = packItems.map((it) => {
      const model = typeof it.model === 'string' ? it.model : '';
      const used = usedMids.has(String(it.id)) || (!!model && usedModels.has(model));
      return { id: String(it.id), label: String(it.name || it.sid || it.id), used };
    });
    out.push({
      kind: 'catalog',
      id: pack,
      dir: pack,
      name: pack,
      type: 'catalog',
      used: rows.some((r) => r.used),
      styles: rows,
    });
  }

  return out;
}
