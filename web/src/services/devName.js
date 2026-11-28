/*
 * devName.js — 设备显示名的唯一出处（审计 2.16）
 *
 * 口径与 2D 标签 / 卡片一致：HA 已连上取 friendly_name（HA.friendly 自带
 * 实体 id 尾段回退）；未连上时退回实例名（动态家具才有，走 catalog 的
 * itemDisplayName，引擎已桥到 window），最后兜底实体 id / 占位文案。
 * RoomsPanel 与 DevOrderPanel 之前各抄了一份且已漂移（一份丢了
 * itemDisplayName 回退），此处收敛后不再允许第三份。
 */
import { HA } from './ha.js';

export function devNameOf(d) {
  const eid = d && d.entityId;
  if (eid && HA.getState && HA.getState(eid)) {
    return HA.friendly(eid) || eid;
  }
  const nm = window.itemDisplayName ? window.itemDisplayName('device', d) : '';
  return nm || eid || '未命名设备';
}
