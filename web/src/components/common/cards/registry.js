/**
 * 卡片 type → Vue 组件的唯一注册处。
 *
 * 引擎（engine/cards.js）只负责 DSL：componentOf(node) 返回**组件名字符串**，
 * 真实组件对象在这里维护一份。CardGroup / CardDevices 都从本模块取，
 * 新增一种卡片渲染组件时只改这里，不再有「漏改一处就静默不渲染」的风险。
 *
 * ⚠ engine/cards.js 与 studio 的同名副本逐字同源，DSL 侧（COMPONENTS 字符串表）
 *   不能动；本文件只做「名字 → 组件对象」的绑定，不改引擎语义。
 */
import { CardEngine } from '../../../engine/cards.js';
import CardToggle from './CardToggle.vue';
import CardRange from './CardRange.vue';
import CardSelect from './CardSelect.vue';
import CardChoice from './CardChoice.vue';
import CardButton from './CardButton.vue';
import CardReadonly from './CardReadonly.vue';
import CardImage from './CardImage.vue';

export const CARD_COMPONENTS = {
  CardToggle, CardRange, CardSelect, CardChoice, CardButton, CardReadonly, CardImage,
};

/** 节点 → 组件对象（供 <component :is="..."> 直接用）；未知类型返回 null */
export function cardComponentOf(node) {
  return CARD_COMPONENTS[CardEngine.componentOf(node)] || null;
}

/* 开发期自检：DSL 里声明的组件名如果没在这里注册，立刻提示，避免线上静默空白 */
if (import.meta.env && import.meta.env.DEV) {
  const missing = [...new Set(Object.values(CardEngine.COMPONENTS || {}))]
    .filter((name) => !CARD_COMPONENTS[name]);
  if (missing.length) console.warn('[cards] 组件未注册:', missing.join(', '));
}

export default CARD_COMPONENTS;
