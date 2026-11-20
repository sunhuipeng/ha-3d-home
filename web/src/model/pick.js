/* 3D 拾取 → 选中 → 卡片：三个页面共用的唯一判定处。
 *
 * 三个页面的容器、面板、数据源都不同（编辑页是 options API + editor store，
 * 大屏 / 控制面板是本页 data），但「点到了谁 / 点击是出卡还是执行 / 场景怎么高亮」
 * 这三件事必须完全一致，所以收敛到这个模块，各页只负责把结果写进各自的选中态。
 *
 * 场景模式统一口径（见 applySceneMode）：**标签显隐就是点击语义本身** ——
 *   显示标签 → 点标签执行动作，点设备模型只选中出卡；
 *   隐藏标签 → 没有可点的标签，点设备模型直接执行动作。
 *
 * 纯函数 + 显式传入 View3D：本文件不 import 引擎、不碰 Vue / Pinia，可在 Node 里直接单测。
 */

/* 拾取结果 → 选中项 { kind, id }
 * hit 由 View3D 的 onPick 回传：{ kind:'device'|'room', item, devType }
 *   - 设备：devType 是插件 type（light/climate/…）
 *   - 门窗：devType 是 'door' / 'window'（贴墙实例的数据里没有 type 字段）
 *   - 房间：kind === 'room'
 * 空白（hit === null）→ null，调用方据此清空选中。 */
export function selOfPick(hit) {
  if (!hit || !hit.item || !hit.item.id) return null;
  if (hit.kind === 'room') return { kind: 'room', id: hit.item.id };
  /* 门窗在编辑器里是独立数组（doors/windows），选中态 kind 也必须用 door/window，
   * 否则属性面板与卡片都找不到实例（devices 里没有这条记录）。 */
  const k = (hit.devType === 'door' || hit.devType === 'window') ? hit.devType : 'device';
  return { kind: k, id: hit.item.id };
}

/* View3D.onPick 的唯一赋值点（只由 applySceneMode 调用，页面不要再直接调它）。
 * 装上了：canvas 点击只「选中出卡」，执行动作交给设备标签；
 * 没装：canvas 点击回到引擎的旧语义 —— 点设备直接 toggleDevice 执行。 */
export function applyPickMode(V3, enabled, onHit) {
  if (!V3) return;
  V3.onPick = (enabled && typeof onHit === 'function') ? onHit : null;
}

/* 3D 场景模式的唯一装载点：标签显隐 ⇔ 点击语义，两个开关必须一次拨完。
 *
 *   labelsVisible = true  → 显示标签：点标签执行动作，点设备模型只「选中 / 切换卡片」；
 *   labelsVisible = false → 隐藏标签：没有可点的标签，点设备模型直接执行动作。
 *
 * 两个页面（展示页 PanelApp / EditApp 的 3D 展示）都只负责
 * 决定「标签该不该显示」，同一个函数同时拨 setLabelsVisible 与 onPick，杜绝
 * 「标签显示却点设备执行」「标签隐藏却点设备出卡（没有执行入口）」这类错位。
 * 页面各自的「卡片面板显隐」偏好（showCards / 🃏）只管面板，不参与本判定。
 *
 * index 的窄屏是唯一特例：由 PanelApp 传入 false 强制隐藏标签，于是自然落到
 * 「点设备 = 执行」，不需要在引擎里再开一条窄屏分支。 */
export function applySceneMode(V3, labelsVisible, onHit) {
  if (!V3 || typeof V3.setLabelsVisible !== 'function') return;
  const visible = !!labelsVisible;
  V3.setLabelsVisible(visible);
  applyPickMode(V3, visible, onHit);
}

/* 选中项 → 场景高亮（房间地面提亮 + 描边 / 设备脚下圆环）
 * visible === false 时一律清空：2D 模式、大屏关卡片后不该留一圈高亮在场景里。
 * kind:'all'（全屋）没有具体的几何对象，直接当"无高亮"处理。 */
export function applyPickHi(V3, sel, visible) {
  if (!V3 || typeof V3.setPick !== 'function') return;
  V3.setPick((visible && sel && sel.kind !== 'all') ? sel : null);
}
