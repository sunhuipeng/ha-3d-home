/*
 * inspectorActs.js — SelectionInspector 的动作名单（唯一出处）
 *
 * 审计 2.18：原先新增一个属性输入框要同步改 4 处（SI 模板、SI emits、SI 转发
 * method、EditApp 模板 @ 绑定），20 个通道全是一行式样板。
 *
 * 现在的契约：根组件（EditApp）按本名单把同名编排方法打包成对象经 :act props
 * 下发，SelectionInspector 按本名单生成一行式转发 —— 模板仍用裸名调用，零改动。
 * 新增输入框动作只需两处：本名单加一项 + 根组件（或其 composable 方法组）有
 * 同名方法；SI 模板照常写裸名。
 *
 * 名单分两段（仅注释分节，运行时是一维数组）：
 *  - 数值家族：落点全在 composables/useNumEditing.js 的方法组（applyNum 底座）；
 *  - 选中项操作：落点是根组件里需要操作插件样式 / 撤销栈的编排方法。
 */
export const INSPECTOR_ACTS = [
  /* 数值家族（设备 / 门窗 / 家具 / 标签抬升） */
  'setFurnNum', 'wheelFurn', 'setDevNum', 'wheelNum',
  'setDevLabelOffset', 'commitDevLabelOffset', 'wheelDevLabelOffset',
  'setOpenNum', 'wheelOpen', 'setOpenZ', 'wheelOpenZ',
  /* 属性 / 样式 / 绑定与点击控制（根组件编排） */
  'setProp', 'setSelStyle', 'setSelOpt', 'swapFurnModel',
  'setDevClick', 'setDevClickSvc', 'clearDevField',
  /* 删除与保存标记 */
  'delSelected', 'dirty',
];
