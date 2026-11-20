/*
 * services/haIcon.js — HA 实体图标解析（独立小工具，不依赖 HA 实例）
 *
 * HA 实体的 attributes.icon 是一个「图标名字符串」，不是图片：
 *   · 'mdi:sofa'  → Pictogrammers MDI 图标库（HA 图标选择器的默认来源）
 *   · 其它前缀（hass: / hacs: 等自定义集）→ HA 前端运行时注册的图标集，
 *     独立网页没有那个运行时，拿不到就返回 null，调用方走自己的兜底显示。
 *
 * MDI 图标我们用自托管的 @mdi/font 字体渲染（web/main-index.js 引入一次 CSS）：
 * 名字去掉 'mdi:' 前缀就是字体类名（kebab-case 天然一致，'sofa' → 'mdi-sofa'）。
 *
 * 用法：
 *   const h = haIconOf(entityState);      // entityState = HA.getState(eid) 的原始对象
 *   if (h) <i class="mdi" :class="'mdi-' + h.mdi">
 *   else   走调用方自己的兜底（emoji / 关键词猜测）
 *
 * 只认 mdi: 前缀；名字必须是纯 kebab-case 字符（防御实体上被手填的乱串）。
 */
export function haIconOf(st) {
  const icon = st && st.attributes ? st.attributes.icon : null;
  if (typeof icon !== 'string' || icon.indexOf('mdi:') !== 0) return null;
  const name = icon.slice(4).trim();
  return /^[a-z0-9-]+$/i.test(name) ? { mdi: name.toLowerCase() } : null;
}
