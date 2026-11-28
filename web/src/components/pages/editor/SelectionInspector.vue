<template>
  <!-- 右侧属性栏分支三：选中对象的属性编辑。
       共用块（标题 / 样式 / 样式参数 / 房间归属 / 主实体 / 点击控制 / 拓展绑定 / 删除）
       放在 kind 分支之外，文案差异由 computed 按 selection.kind 分派；
       分支里只留各类型真正不同的「摆放参数」与家具专属区。 -->
  <div class="prop-name">{{ kindLabel }}{{ selName ? ' · ' + selName : '' }}</div>
  <div class="prop-kind" v-if="selItem.x != null">位置 ({{ selItem.x }}, {{ selItem.y }})</div>

  <!-- 样式选择 + 样式参数: 设备与门窗同一套（列表按 selection.kind 分派） -->
  <div class="sp-sec" v-if="selStyleList.length > 1"><h4>{{ selStyleTitle }}</h4>
    <div class="style-grid">
      <button v-for="s in selStyleList" :key="s.id" :class="{active: selStyleId === s.id}" @click="setSelStyle(s)">
        <i class="fz" v-if="s.custom">自定义</i>
        <span class="ic" v-html="devStyleIcon(s)"></span><span>{{ s.name }}</span>
      </button>
    </div>
    <div class="sp-tip" v-if="selStyleDesc">{{ selStyleDesc }}</div>
  </div>
  <div class="sp-sec" v-if="selOptList.length"><h4>样式参数</h4>
    <div class="sp-row" v-for="o in selOptList" :key="o.key">
      <label>{{ o.label }}</label>
      <option-row :o="o" @set="setSelOpt"></option-row>
    </div>
  </div>

  <!-- 房间归属：四类对象共用一份。自动判定只在「进入某个房间」时生效，拖出房间 /
       贴墙 / 跨房间 / 门窗中心压在墙中线上都判不准，所以这里留手动指定入口；
       空值走 setProp 的「清空 = delete」，存档里不留空串。 -->
  <div class="sp-sec"><h4>房间归属</h4>
    <div class="sp-row"><label>所属房间</label>
      <select :value="selItem.roomId || ''" @change="setProp('roomId', $event.target.value, 'str')">
        <option value="">未归属</option>
        <option v-for="r in roomOptions" :key="r.id" :value="r.id">{{ r.name }}</option>
      </select>
    </div>
  </div>

  <template v-if="selection.kind === 'furniture'">
    <div class="sp-sec" v-if="sameModels.length > 1"><h4>同类模型</h4>
      <div class="style-grid">
        <button v-for="f in sameModels" :key="f.id" :class="{active: selItem.mid === f.id}" @click="swapFurnModel(f)" :title="f.name">
          <i class="fz" v-if="f.custom">自定义</i>
          <span class="ic" v-html="furnIcon(f, 0.5)"></span><span>{{ f.name }}</span>
        </button>
      </div>
    </div>
    <div class="sp-sec"><h4>家具</h4>
      <div class="sp-row"><label>旋转(°)</label><input type="number" step="15" :value="deg(selItem.rot)" @input="setFurnNum('rot', $event.target.value, 'deg')" @wheel.prevent="wheelFurn('rot', $event, 15)"></div>
      <div class="sp-row"><label>X</label><input type="number" step="0.1" :value="selItem.x" @input="setFurnNum('x', $event.target.value)" @wheel.prevent="wheelFurn('x', $event, 0.1)"></div>
      <div class="sp-row"><label>Y</label><input type="number" step="0.1" :value="selItem.y" @input="setFurnNum('y', $event.target.value)" @wheel.prevent="wheelFurn('y', $event, 0.1)"></div>
      <div class="sp-row"><label>离地高度</label><input type="number" step="0.05" min="0" :value="selItem.z != null ? selItem.z : ''" placeholder="0" @input="setFurnNum('z', $event.target.value)" @wheel.prevent="wheelFurn('z', $event, 0.05)"></div>
      <div class="sp-row"><label>整体比例</label>
        <input type="range" min="20" max="300" step="5" :value="selItem.pct || 100" @input="setFurnNum('pct', $event.target.value)">
        <input class="num-s" type="number" min="20" max="300" step="5" :value="selItem.pct || 100" @input="setFurnNum('pct', $event.target.value)" @wheel.prevent="wheelFurn('pct', $event, 5)">
      </div>
      <div class="sp-tip">拖动实时预览，2D 占位同步缩放；范围 20%–300%</div>
      <div class="sp-row" v-if="!selHasModel"><label>模型地址</label><input placeholder="/assets/xx.glb" :value="selItem.model || ''" @change="selItem.model = $event.target.value.trim() || undefined; dirty()"></div>
    </div>
  </template>

  <template v-else-if="selection.kind === 'device'">
    <div class="sp-sec"><h4>3D 位置与大小</h4>
      <div class="sp-row"><label>X</label><input type="number" step="0.1" :value="selItem.x" @input="setDevNum('x', $event.target.value, true)" @wheel.prevent="wheelNum('x', $event, 0.1, true)"></div>
      <div class="sp-row"><label>Y</label><input type="number" step="0.1" :value="selItem.y" @input="setDevNum('y', $event.target.value, true)" @wheel.prevent="wheelNum('y', $event, 0.1, true)"></div>
      <div class="sp-row"><label>离地高度</label><input type="number" step="0.05" min="0" :value="selItem.z != null ? selItem.z : ''" placeholder="按造型默认" @input="setDevNum('z', $event.target.value)" @wheel.prevent="wheelNum('z', $event, 0.05)"></div>
      <div class="sp-row"><label>水平旋转(°)</label><input type="number" step="15" :value="selItem.rot || 0" @input="setDevNum('rot', $event.target.value, true)" @wheel.prevent="wheelNum('rot', $event, 15, true)"></div>
       <div class="sp-row"><label>标签高度</label>
        <input type="range" min="0" max="5" step="0.05" :value="labelOffsetVal"
          @input="setDevLabelOffset($event.target.value)">
        <input class="num-s" type="number" min="-1" max="6" step="0.05" :value="labelOffsetVal"
          @input="setDevLabelOffset($event.target.value)" @change="commitDevLabelOffset($event.target.value)"
          @wheel.prevent="wheelDevLabelOffset($event, 0.05)">
      </div>
      <div class="sp-row"><label>整体比例</label>
        <input type="range" min="20" max="300" step="5" :value="selItem.pct || 100" @input="setDevNum('pct', $event.target.value)">
        <input class="num-s" type="number" min="20" max="300" step="5" :value="selItem.pct || 100" @input="setDevNum('pct', $event.target.value)" @wheel.prevent="wheelNum('pct', $event, 5, false, 20, 300)">
      </div>
      <div class="sp-tip">输入或滚轮调整实时预览；吊灯/吸顶灯通过离地高度控制悬垂长度；标签高度 = 状态标签相对设备锚点的抬升量（清空回到造型默认 {{ labelOffsetDefault }}m）</div>
    </div>
    <!-- 设备绑定 / 点击控制 / 拓展绑定：与门窗共用，见下方分支外 -->
  </template>

  <template v-else-if="selection.kind === 'door' || selection.kind === 'window'">
    <div class="sp-sec"><h4>{{ kindName }}</h4>
      <div class="sp-row"><label>宽度</label><input type="number" step="0.05" :value="selItem.w" @input="setOpenNum('w', $event.target.value)" @wheel.prevent="wheelOpen('w', $event, 0.05)"></div>
      <div class="sp-row"><label>角度(°)</label><input type="number" step="15" :value="selItem.rot || 0" @input="setOpenNum('rot', $event.target.value)" @wheel.prevent="wheelOpen('rot', $event, 15)"></div>
      <!-- 离地高度：门恒 0 不可调（门贴地），窗可调（模型自带窗台 0.9m，z 是整体抬升） -->
      <div class="sp-row" v-if="selection.kind === 'window'"><label>离地高度</label>
        <input type="number" step="0.05" min="0" :value="selItem.z != null ? selItem.z : 0" @input="setOpenZ($event.target.value)" @wheel.prevent="wheelOpenZ($event, 0.05)">
      </div>
      <div class="sp-row" v-else><label>离地高度</label><span class="sp-val">固定 0（门贴地，不可调）</span></div>
      <div class="sp-row"><label>标签高度</label>
        <input type="range" min="0" max="5" step="0.05" :value="labelOffsetVal"
          @input="setDevLabelOffset($event.target.value)">
        <input class="num-s" type="number" min="-1" max="6" step="0.05" :value="labelOffsetVal"
          @input="setDevLabelOffset($event.target.value)" @change="commitDevLabelOffset($event.target.value)"
          @wheel.prevent="wheelDevLabelOffset($event, 0.05)">
      </div>
      <div class="sp-tip">标签高度 = 状态标签相对门/窗模型中部的抬升量（清空回到缺省：门 1.05m / 窗 1.45m）</div>
    </div>
    <!-- 设备绑定 / 点击控制 / 拓展绑定：与设备共用，见下方分支外 -->
  </template>

  <!-- 主实体 / 点击控制：设备与门窗同一套契约，共用一份 DOM。
       目录家具（floors.furniture，只存 mid + 摆放参数）不走插件链路，
       没有 entityId / click 语义，整块不渲染；文案差异由下方 computed 按 kind 分派。 -->
  <template v-if="hasDeviceContract">
    <div class="sp-sec"><h4>设备绑定</h4>
      <div class="sp-row"><label>实体</label><entity-input placeholder="未绑定 · 搜索切换" :model-value="selItem.entityId || ''" @update:model-value="setProp('entityId', $event, 'str')"></entity-input></div>
      <div class="bind-meta">
        <span class="bm" v-if="selItem.name" :title="selItem.name">名称 {{ selItem.name }}</span>
        <span class="bm st" v-if="devState" :title="devState">状态 {{ devState }}</span>
        <span class="bm" :title="selItem.model || devStyleName || '默认造型'">模型 {{ selItem.model || devStyleName || '默认造型' }}</span>
      </div>
      <div class="sp-tip" v-if="bindingTip">{{ bindingTip }}</div>
    </div>
    <div class="sp-sec"><h4>点击控制</h4>
      <label class="sp-check">
        <input type="checkbox" :checked="devClickOn" @change="setDevClick($event.target.checked)">
        <span>{{ clickCheckboxText }}</span>
      </label>
      <div class="sp-row"><label>点击动作</label>
        <select :value="selItem.clickSvc || ''" @change="setDevClickSvc($event.target.value)">
          <option value="">插件内置点击事件</option>
          <option v-for="o in devClickSvcOpts" :key="o.on" :value="o.on">{{ o.label }}（{{ o.on === o.off ? o.on : o.on + ' / ' + o.off }}）</option>
        </select>
      </div>
      <div class="sp-tip">{{ clickTip }}</div>
    </div>
  </template>

  <!-- 实体绑定: 设备/门窗同一套，按当前样式所属插件的 fields 声明渲染 -->
  <div class="sp-sec" v-if="selFields.length"><h4>拓展·实体绑定</h4>
    <div class="sp-field" v-for="f in selFields" :key="f.key">
      <div class="sp-field-hd">
        <label>{{ f.label }}</label>
        <span class="sp-val" :class="{bound: selItem[f.key]}">{{ selItem[f.key] ? (devFieldVal(f.key) || '读取中') : '未绑定' }}</span>
        <button v-if="selItem[f.key]" type="button" class="sp-clear" title="解除绑定" @click="clearDevField(f.key)">✕</button>
      </div>
      <entity-input :placeholder="f.placeholder || 'entity.xxx'" :domains="f.domains || null" :model-value="selItem[f.key] || ''" @update:model-value="setProp(f.key, $event, 'str')"></entity-input>
      <div class="sp-tip" v-if="f.tip">{{ f.tip }}</div>
    </div>
    <div class="sp-tip">{{ selFieldsTip }}</div>
  </div>

  <div class="sp-btns"><button class="sp-btn warn" @click="delSelected">删除</button></div>
</template>

<script>
/*
 * SelectionInspector — 右侧「选中属性」分支，批次 3 从 App.vue 拆出（最大的一块）。
 *
 * 共享状态全部来自 useEditorStore，零 props：
 *  - project / selection / entVersion：原始 state
 *  - cur / selItem / kindName：共享 getters（原先本组件与 App.vue 各算一份，现收敛到 store）
 *  - 样式列表 / 造型参数 / 点击规格 / 标签高度…：服务层派生已收敛到 editor store
 *    getters（审计 3.15，依赖信号在 store 统一建），本组件 mapState 直读；
 *    纯文案 / 纯逻辑类派生留在本组件
 *
 * 动作经 :act props 注入根组件的编排方法（名单唯一出处见 inspectorActs.js，
 * 审计 2.18：原先 20 个 emits 通道 + 20 个转发壳，新增输入框要同步改 4 处）；
 * 编排动作（压撤销栈 / 重建 3D / 推插件状态）仍由根组件完成，本组件不碰引擎。
 * 模板按「共用块 + kind 分支」组织：房间归属 / 主实体 / 点击控制 / 拓展绑定 /
 * 删除对所有类型共用一份 DOM，文案差异由 hasDeviceContract / bindingTip /
 * clickCheckboxText / clickTip 按 kind 分派；分支里只留各类型不同的摆放参数。
 * deg / devStyleIcon / furnIcon / devFieldVal 是纯展示辅助，留在组件内。
 */
import { mapState } from 'pinia';
import { useEditorStore } from '../../../stores/editor';
import { labelOffsetDefaultOf, labelOffsetValOf } from '../../../composables/useNumEditing';
import { INSPECTOR_ACTS } from './inspectorActs';
/* 服务层派生已收敛到 editor store getters（审计 3.15），本组件只留两个纯展示
 * 辅助（图标渲染）的 ESM 直连（审计 3.10：不走 window 双轨）。 */
import { devStyleIcon, furnIcon } from '../../../model/catalog.js';
import OptionRow from '../../common/OptionRow.vue';
import EntityInput from '../../common/EntityInput.vue';

export default {
  name: 'SelectionInspector',
  components: { OptionRow, EntityInput },
  /* 根组件打包的动作对象（见 inspectorActs.js 的名单契约） */
  props: { act: { type: Object, required: true } },
  computed: {
    /* 服务层派生（样式列表 / 参数 schema / 点击规格 / 实时读数…）已收敛到 editor
     * store getters（审计 3.15）：依赖 window 服务层 + void entVersion 的重算信号
     * 统一在 store 里建一次，组件不再各自手写。纯文案类留在下方本组件内。 */
    ...mapState(useEditorStore, [
      'project', 'selection', 'entVersion', 'cur', 'selItem', 'kindName',
      'selName', 'selHasModel', 'sameModels', 'selStyleList', 'selStyleId',
      'selStyleDesc', 'devIsLight', 'furnKind', 'devStyleName',
      'labelOffsetDefault', 'labelOffsetVal', 'selOptList', 'selFields',
      'devClickSpec', 'devClickOn', 'devClickSvcOpts', 'devState', 'devFieldState',
    ]),
    /* 「所属房间」下拉的选项：房间是楼层级数据，设备/家具不可能跨层归属 */
    roomOptions() {
      return ((this.cur && this.cur.rooms) || []).map((r) => ({ id: r.id, name: r.name || '房间' }));
    },
    /* 标题类别名: 家具插件显示家具分类（替代「设备」），其它沿用 kindName */
    kindLabel() {
      return this.furnKind || this.kindName;
    },
    /* 样式区标题: 家具插件按分类取名（柜架样式），灯 = 灯体样式，其它设备 = 设备造型，门窗 = kindName + 样式 */
    selStyleTitle() {
      if (this.selection.kind === 'device') {
        return this.furnKind ? this.furnKind + '样式'
          : (this.devIsLight ? '灯体样式' : '设备造型');
      }
      return this.kindName + '样式';
    },
    selFieldsTip() {
      return this.selection.kind === 'device'
        ? '除主实体外，插件还可挂功率/温湿度/人体/曲目等实体，用来丰富模型屏幕与标签的数据'
        : '除主实体外，插件还可挂开度等扩展实体；绑定后由插件按状态驱动模型（如门磁 on=开门动画）';
    },
    /* 「设备绑定」区的动作文案：由 store 的 devClickSpec 组装（纯文案，留在组件内） */
    devClickText() {
      const spec = this.devClickSpec;
      if (!spec) return '';
      const name = (v) => (typeof v === 'function' ? '自定义动作' : v);
      const a = name(spec.on), b = name(spec.off);
      return spec.label + '（' + (a === b ? a : a + ' / ' + b) + '）';
    },
    /* ---- 共用块的显隐与文案：设备 / 门窗同一份 DOM，差异只在这里按 kind 分派 ----
     * 目录家具（floors.furniture）不走插件链路，没有 entityId / click 契约，
     * hasDeviceContract 让「设备绑定」「点击控制」整块不渲染（原来靠 kind 分支隔开）。
     * 设备原本没有主实体 tip；点击控制的 checkbox 文案 / tip 两分支也不同，
     * 逐字保留原有措辞，避免合并时悄悄改掉界面说明。 */
    hasDeviceContract() {
      const k = this.selection && this.selection.kind;
      return k === 'device' || k === 'door' || k === 'window';
    },
    bindingTip() {
      const k = this.selection && this.selection.kind;
      return (k === 'door' || k === 'window')
        ? '与设备同一套主实体入口；门磁、开度等插件扩展实体在下方「拓展·实体绑定」；未绑定主实体时不出卡片'
        : '';
    },
    clickCheckboxText() {
      const k = this.selection && this.selection.kind;
      const it = this.selItem || {};
      const base = '点击模型 / 标题标签执行';
      if (k === 'device') return base + (this.devClickText ? '：' + this.devClickText : '');
      if (this.devClickSpec || it.clickSvc) {
        const tail = (this.devClickText && !it.clickSvc) ? this.devClickText : it.clickSvc;
        return base + '：' + (tail || '');
      }
      return base + '（默认不可点，勾选或选择动作后生效）';
    },
    clickTip() {
      const k = this.selection && this.selection.kind;
      return k === 'device'
        ? '第一项走插件声明的 click（未声明时按内置默认）；其余为 HA 标准服务动作，选择后覆盖插件内置、优先级最高。勾选后点击 3D 设备即发送对应服务，取消勾选则不响应点击'
        : '门窗与设备同一规则：插件声明了 click（如卷帘门 open_cover/close_cover）默认勾选启用，没声明则默认不勾选。第一项走插件 click，其余为 HA 标准动作、选择后覆盖插件内置且优先级最高；未绑定实体的门窗点击不发送服务';
    },
  },
  methods: {
    /* ---- 纯展示辅助（不需要回根组件） ---- */
    deg(rad) { return Math.round((rad || 0) * 180 / Math.PI); },
    devStyleIcon(s) { return devStyleIcon(s); },
    furnIcon(f, scale) { return furnIcon(f, scale); },
    devFieldVal(key) { return this.devFieldState(key); },
    /* ---- 动作转发（inspectorActs.js 名单生成）：根组件负责 commit / 撤销栈 / 引擎刷新。
     * Vue 的 options methods 会在模板解析时绑定实例，this.act 即根组件打包的动作对象；
     * 模板里仍是裸名调用（方法名解析优先于 props，不会与 act 撞名）。 ---- */
    ...Object.fromEntries(INSPECTOR_ACTS.map((n) => [n, function (...args) { return this.act[n](...args); }])),
  },
};
</script>
