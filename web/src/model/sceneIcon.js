/**
 * 场景图标：按场景中文名关键词猜一个 emoji，够用且不依赖插件声明。
 *
 * 从 PanelApp.vue 逐字搬出（阶段 0）：纯函数、零依赖，可在 Node 里单测。
 * HA 实体显式配了 attributes.icon 时由磁贴优先用 mdi，本函数只提供兜底。
 */
export const SCENE_ICONS = [
  [/明亮|取光|天亮|晨/, '☀️'],
  [/温馨|舒适|暖|傍晚/, '🛋'],
  [/观影|电影|影院|电视/, '🎬'],
  [/夜间|睡眠|睡觉|晚安|夜灯/, '🌙'],
  [/离家|外出|离开|无人/, '🚪'],
  [/回家|归家|到家/, '🏡'],
  [/会客|客人|访客/, '🍵'],
  [/用餐|餐厅|吃饭|早餐|晚餐/, '🍽'],
  [/阅读|读书|书房/, '📖'],
  [/清洁|打扫|扫除/, '🧹'],
  [/派对|聚会|party/i, '🎉'],
  [/工作|办公|专注/, '💻'],
];

export function sceneIcon(name) {
  const n = String(name || '');
  for (const [re, ic] of SCENE_ICONS) if (re.test(n)) return ic;
  return '🎬';
}
