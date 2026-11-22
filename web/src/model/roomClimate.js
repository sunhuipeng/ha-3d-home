/*
 * model/roomClimate.js — 房间温湿度 3D 标签的文案派生（纯函数，不依赖 Vue / Three / HA）
 *
 * 房间（floor.rooms[]）可绑两个 HA sensor：tempEntity / humidityEntity。
 * 展示页在每个房间重心画一个「房间 · 读数」标签，与设备标签是两套：
 *   · 设备标签 = 设备实体、可点开关、走 isOn 高亮；
 *   · 房间标签 = 环境读数、纯展示不可点、不参与任何 on/off 语义。
 * 两个字段都空 → 该房间不出标签；只绑一个 → 只显示那一个读数。
 *
 * 取值口径与 HUD 数据卡一致：状态里取 unit_of_measurement，
 * unknown/unavailable/空值不显示，数值保留 HA 原样字符串（不做四舍五入，
 * 传感器精度各异，显示层不擅自改）。
 */

/* 单个 sensor 的显示值："24.6 ℃" / "55 %"；无有效状态返回空串 */
export function climateValue(st) {
  if (!st || st.state == null) return '';
  const raw = String(st.state).trim();
  if (!raw || raw === 'unknown' || raw === 'unavailable') return '';
  const a = st.attributes || {};
  const unit = a.unit_of_measurement ? ' ' + a.unit_of_measurement : '';
  return raw + unit;
}

/* 房间标签是否要出现：绑了任一实体才画（文案派生前先判，省掉无谓的 HA 查询） */
export function roomHasClimate(room) {
  return !!(room && (room.tempEntity || room.humidityEntity));
}

/* 派生房间标签文案。get(eid) → HA state（传入 HA.getState 绑定）。
 * 返回 { name, value, text }：
 *   name  = 房间名（兜底「房间」）
 *   value = 读数拼串（"24.6 ℃ · 55 %"，只含实际取到的项）
 *   text  = 完整标签文案（"卧室 24.6 ℃ · 55 %"），无读数时只有房间名。
 * 不在这里做 on/off 高亮判断 —— 温湿度是读数，没有开关语义。 */
export function roomClimate(room, get) {
  const name = (room && room.name) || '房间';
  const parts = [];
  const read = typeof get === 'function' ? get : () => null;
  if (room && room.tempEntity) {
    const v = climateValue(read(room.tempEntity));
    if (v) parts.push(v);
  }
  if (room && room.humidityEntity) {
    const v = climateValue(read(room.humidityEntity));
    if (v) parts.push(v);
  }
  const value = parts.join(' · ');
  return { name, value, text: value ? name + ' ' + value : name };
}
