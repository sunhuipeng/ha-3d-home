/*
 * model/displayAction.js — 展示项的「域 → 服务动作 / 默认图标」单一真相
 *
 * 2026-11-15：展示项从「只能勾场景」扩到「场景 / 脚本 / 实体」。
 * 2026-11-16：实体项收紧为只允许 TOGGLE_DOMAINS（light / switch / input_boolean），
 *             配置弹窗按此白名单过滤输入与下拉候选。
 * 配置落盘(catalog)、派生(displayDerived)、执行(sceneRunner)、配置弹窗(DispCfgModal)
 * 四处都要知道「这个 eid 点了发什么服务」，集中在这里，避免四份口径漂移。
 * 纯常量 + 纯函数，零依赖，可直接 Node 单测。
 */

/* 展示项上限：条子改成单行横滚后仍能承载较多项，但要有防御上限，
 * 避免配置里误粘贴几百条把 DOM 撑爆。配置弹窗也按这个数禁用新增。 */
export const MAX_DISPLAY_ITEMS = 60;

/* 点击即切换的域（用户 2026-11-15 指定）：这三个域在 HA 里都有 <domain>.toggle，
 * 服务发出即视为完成、不进入 4s 回执等待；磁贴上显示当前开/关状态灯。 */
export const TOGGLE_DOMAINS = ['light', 'switch', 'input_boolean'];

/* 展示项来源分组：scene / script 由 HA 自动列举后勾选，entity 由 EntityInput 手动添加 */
export const ITEM_KINDS = ['scene', 'script', 'entity'];

/* 域级默认 mdi（模仿 HA 前端的 domain 兜底图标）。attributes.icon 只有用户在 HA 里
 * 显式设置过才有值，没配的实体由前端按 domain 补一个与 HA 视觉一致的图标。
 * 从 useCards.js 抽出来共用：卡片头与展示项磁贴读同一份表。
 * scene / script 故意不进表 —— 它们保持「按名称猜 emoji」的原显示口径。 */
export const DOMAIN_MDI = {
  light: 'lightbulb', switch: 'toggle-switch-variant', input_boolean: 'toggle-switch-variant',
  cover: 'window-open', climate: 'thermostat', fan: 'fan', humidifier: 'air-humidifier',
  media_player: 'cast', camera: 'video', lock: 'lock', vacuum: 'robot-vacuum',
  water_heater: 'thermometer', sensor: 'eye', binary_sensor: 'checkbox-blank-circle',
  button: 'button-pointer',
};

export function domainMdiOf(domain) {
  return DOMAIN_MDI[String(domain || '').toLowerCase()] || '';
}

export function isToggleDomain(domain) {
  return TOGGLE_DOMAINS.includes(String(domain || '').toLowerCase());
}

/* 展示项 → { domain, service, toggle }。
 *   s = { eid, type?, action? }；type 可省略（从 eid 推断），action 是项目数据里
 *   的可选服务覆盖（当前配置弹窗不提供 UI，留作后续扩展）。
 * 默认分派：automation → trigger，button/input_button → press，
 *           三个开关域 → toggle，其余（scene / script / fan / …）→ turn_on。
 * 注意与引擎 cards.js 的同名概念区分：那是卡片 DSL 的 actionOf(node)，
 * 语义不同，这里特意叫 displayActionOf。 */
export function displayActionOf(s) {
  const eid = (s && s.eid) || '';
  const domain = String((s && s.type) || eid.split('.')[0] || '');
  const custom = s && typeof s.action === 'string' ? s.action.trim() : '';
  let service;
  if (custom) service = custom;
  else if (domain === 'automation') service = 'trigger';
  else if (domain === 'button' || domain === 'input_button') service = 'press';
  else if (isToggleDomain(domain)) service = 'toggle';
  else service = 'turn_on';
  return { domain, service, toggle: isToggleDomain(domain) && service === 'toggle' };
}
