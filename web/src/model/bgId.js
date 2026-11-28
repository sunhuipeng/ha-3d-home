/*
 * model/bgId.js — 背景插件旧 id 迁移（唯一出处，审计 2.9）
 *
 * 此前 BG_ID_ALIAS 在 engine/plugins.js 与 model/neededPlugins.js 各抄一份
 * （引擎依赖 three/DOM，neededPlugins 不愿 import 引擎，只能手抄——漏同步会让
 * 旧项目背景解析失败）。本模块零依赖，两侧都 import 这里。
 *
 * 两个函数语义刻意不同（调用方各取所需）：
 *   pluginIdOfStyle(style)  取 '<插件id>:<造型id>' 的插件段并迁移旧 id ——
 *                           neededPlugins 的清单匹配口径（无冒号也迁移）；
 *   migrateBgStyleId(id)    迁移聚合样式 id 的插件段 —— 引擎 migrateBgId 的
 *                           存储迁移口径（无冒号 = 非聚合样式，原样返回）。
 */
export const BG_ID_ALIAS = { backdrop_ground: 'background' };

/* 取 '<插件id>:<造型id>' 里的插件 id；无冒号时整串即 id（同样过 alias）；空值返回 ''。 */
export function pluginIdOfStyle(style) {
  if (typeof style !== 'string' || !style) return '';
  const i = style.indexOf(':');
  const id = i < 0 ? style : style.slice(0, i);
  return BG_ID_ALIAS[id] || id;
}

/* 聚合样式 id '<插件id>:<造型id>' 的插件段迁移旧 id；无冒号原样返回。 */
export function migrateBgStyleId(id) {
  if (typeof id !== 'string' || !id) return '';
  const i = id.indexOf(':');
  if (i < 0) return id;
  const pid = BG_ID_ALIAS[id.slice(0, i)];
  return pid ? pid + id.slice(i) : id;
}
