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
 *  - 样式列表 / 造型参数 / 点击规格 / 标签高度…：本分支独有派生数据，仍在组件内从
 *    window 服务层（catalog / PluginEngine / HA）算，靠 void entVersion 触发重算
 *
 * 动作一律 emit 回根组件：它们要压撤销栈、重建 3D、推插件状态，属于根组件编排；
 * 这里的同名 method 只是薄转发。
 * 模板按「共用块 + kind 分支」组织：房间归属 / 主实体 / 点击控制 / 拓展绑定 /
 * 删除对所有类型共用一份 DOM，文案差异由 hasDeviceContract / bindingTip /
 * clickCheckboxText / clickTip 按 kind 分派；分支里只留各类型不同的摆放参数。
 * deg / devStyleIcon / furnIcon / devFieldVal 是纯展示辅助，留在组件内。
 */
import { mapState } from 'pinia';
import { useEditorStore } from '../../../stores/editor';
import { useCatalogStore } from '../../../stores/catalog';
import OptionRow from '../../common/OptionRow.vue';
import EntityInput from '../../common/EntityInput.vue';

export default {
  name: 'SelectionInspector',
  components: { OptionRow, EntityInput },
  emits: [
    'set-sel-style', 'set-sel-opt', 'swap-furn-model', 'set-furn-num', 'wheel-furn',
    'set-dev-num', 'wheel-num', 'set-dev-label-offset', 'commit-dev-label-offset',
    'wheel-dev-label-offset', 'set-prop', 'set-dev-click', 'set-dev-click-svc',
    'set-open-num', 'wheel-open', 'set-open-z', 'wheel-open-z',
    'clear-dev-field', 'del-selected', 'dirty',
  ],
  computed: {
    ...mapState(useEditorStore, [
      'project', 'selection', 'entVersion', 'cur', 'selItem', 'kindName',
    ]),
    /* 家具分类枚举的响应式信号：只用于让 furnKind 在目录加载完成后重算
     * （FURNITURE_TYPES 由 /api/catalog 下发，首帧只有 other 占位） */
    ...mapState(useCatalogStore, { catalogTypes: 'types' }),
    /* 「所属房间」下拉的选项：房间是楼层级数据，设备/家具不可能跨层归属 */
    roomOptions() {
      return ((this.cur && this.cur.rooms) || []).map((r) => ({ id: r.id, name: r.name || '房间' }));
    },
    /* 选中项标题（家具从目录形态解析；设备名跟随 HA，门窗跟随插件样式名） */
    selName() {
      const it = this.selItem;
      if (!it || !this.selection) return '';
      void this.entVersion;
      return window.itemDisplayName(this.selection.kind, it);
    },
    /* 选中家具有没有可用模型：目录与实例都没给地址时，面板才露出「模型地址」手填行 */
    selHasModel() {
      const it = this.selItem;
      if (!it || !this.selection || this.selection.kind !== 'furniture') return true;
      return !!(it.model || window.furnSpec(it).model);
    },
    /* 选中家具的同类模型（右侧切换，按固定类型聚合） */
    sameModels() {
      void this.entVersion;
      const it = this.selItem;
      if (!it || this.selection.kind !== 'furniture') return [];
      const t = window.furnSpec(it).type;
      if (!t) return [];
      return window.allFurniture().filter((f) => (t === 'other' ? window.isOtherFurnType(f.type) : f.type === t));
    },
    /* 选中对象的插件样式列表: 设备按 type 聚合，门窗按插件 styles 聚合 */
    selStyleList() {
      const it = this.selItem;
      if (!it) return [];
      const k = this.selection.kind;
      if (k === 'device') return window.deviceStyles(window.devTypeOf(it)) || [];
      if (k === 'door' || k === 'window') {
        void this.entVersion;
        if (!window.PluginEngine || !PluginEngine.ready) return [];
        return PluginEngine.styles(k) || [];
      }
      return [];
    },
    selStyleId() {
      const it = this.selItem;
      if (!it) return '';
      if (this.selection.kind === 'device') {
        const s = window.deviceStyleDef(it, window.devTypeOf(it));
        return s ? s.id : '';
      }
      const list = this.selStyleList;
      const s = (it.style && list.find((x) => x.id === it.style)) || list[0];
      return s ? s.id : '';
    },
    selStyleDesc() {
      const s = this.selStyleList.find((x) => x.id === this.selStyleId);
      return s && s.desc ? s.desc : '';
    },
    devIsLight() {
      const it = this.selItem;
      if (!it || this.selection.kind !== 'device') return false;
      return window.devTypeOf(it) === 'light';
    },
    /* 家具插件实例（device + type:'furniture'）的家具分类中文名（柜架/床品/桌几…）:
     * 分类键来自插件造型的 ftype（styles[].ftype 覆盖插件级），由引擎透传到聚合造型条目。
     * 未声明 ftype 回退「家具」，枚举外的值经 furnTypeOfStyle 归「其他」。非家具返回 ''。 */
    furnKind() {
      const it = this.selItem;
      if (!it || this.selection.kind !== 'device' || window.devTypeOf(it) !== 'furniture') return '';
      void this.entVersion;   // 插件加载/热刷新后 ftype 才有值，跟样式列表同一信号重算
      void this.catalogTypes; // 家具分类枚举来自 /api/catalog，目录到齐后中文名才可解析
      return window.furnTypeName(window.furnTypeOfDevice(it)) || '家具';
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
    /* 当前造型名（「设备绑定」区的模型 chip）：设备按 devTypeOf 解析，
     * 门/窗按插件聚合样式列表取 —— 与设备同一套展示，不再回退成「默认造型」。 */
    devStyleName() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it) return '';
      if (k === 'device') {
        const s = window.deviceStyleDef(it, window.devTypeOf(it));
        return s ? s.name : '';
      }
      if (k === 'door' || k === 'window') {
        const s = this.selStyleList.find((x) => x.id === this.selStyleId);
        return s ? s.name : '';
      }
      return '';
    },
    /* 标签抬升高度的造型默认值（styles[].labelOffset，缺省 0.3m） */
    labelOffsetDefault() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it) return 0.3;
      if (k !== 'device' && k !== 'door' && k !== 'window') return 0.3;
      const type = k === 'device' ? window.devTypeOf(it) : k;
      return window.PluginEngine ? PluginEngine.labelOffset(type, it.style) : 0.3;
    },
    /* 面板显示值：实例覆盖 obj.labelOffset 优先，没设过就显示造型默认值 */
    labelOffsetVal() {
      const it = this.selItem;
      return it && it.labelOffset != null ? it.labelOffset : this.labelOffsetDefault;
    },
    /* 当前样式的条目参数（值 = 默认值 ∪ 实例已存值 obj.styleOpts） */
    selOptList() {
      void this.entVersion;
      const k = this.selection && this.selection.kind;
      if (k !== 'device' && k !== 'door' && k !== 'window') return [];
      const it = this.selItem;
      if (!it) return [];
      const s = this.selStyleList.find((x) => x.id === this.selStyleId);
      const schema = PluginEngine.normalizeOptions((s && s.options) || []);
      if (!schema.length) return [];
      /* 取值合并（默认∪已存）直接用引擎的 mergeOptions —— 与 model3d/plan2d 渲染时
       * styleOptionsOf 是同一套规则，面板显示什么、场景就画什么，不会各改各的 */
      const merged = PluginEngine.mergeOptions(schema, it.styleOpts || {});
      return schema.map((o) => Object.assign({}, o, { value: merged[o.key] }));
    },
    /* 选中对象的插件绑定字段（按当前样式所属插件取 fields 声明） */
    selFields() {
      const k = this.selection.kind;
      if (k !== 'device' && k !== 'door' && k !== 'window') return [];
      if (!window.PluginEngine) return [];
      void this.entVersion;
      const it = this.selItem;
      const kindOrType = k === 'device' ? window.devTypeOf(it) : k;
      const def = PluginEngine.defFor(kindOrType, it && it.style);
      return def ? PluginEngine.fieldsOf(def) : [];
    },
    selFieldsTip() {
      return this.selection.kind === 'device'
        ? '除主实体外，插件还可挂功率/温湿度/人体/曲目等实体，用来丰富模型屏幕与标签的数据'
        : '除主实体外，插件还可挂开度等扩展实体；绑定后由插件按状态驱动模型（如门磁 on=开门动画）';
    },
    /* 点击控制规格（插件声明优先，否则内置默认；null = 不支持点击） */
    /* devClickSpec = 插件**声明**的原始 click 规格（label / on / off 供下拉与文案展示，
     * 不含实例覆盖 —— 面板正是编辑覆盖的地方）；「能不能点」的实例级判定走
     * PluginEngine.instanceClickSpec（与 3D 标签 clickable / toggleDevice 同一口径） */
    devClickSpec() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it || !window.PluginEngine) return null;
      if (k !== 'device' && k !== 'door' && k !== 'window') return null;
      return PluginEngine.clickSpec(k === 'device' ? window.devTypeOf(it) : k, it.style);
    },
    devClickOn() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it || !window.PluginEngine) return false;
      if (k !== 'device' && k !== 'door' && k !== 'window') return false;
      /* 勾选框编辑的正是 obj.click：显式值直接回显（否则勾上又自己弹回）；
       * 未设置时跟随 instanceClickSpec 的默认结论（插件 defaultOn / clickSvc 覆盖都算进来），
       * 与 3D 标签是否可点、卡片电源开关是否渲染完全同一口径。
       * type 要传真实 HA 域（设备取 devTypeOf，门窗就是 kind），不能直接传 'device'。 */
      if (it.click === true || it.click === false) return it.click;
      return !!PluginEngine.instanceClickSpec(it, k === 'device' ? window.devTypeOf(it) : k);
    },
    devClickText() {
      const spec = this.devClickSpec;
      if (!spec) return '';
      const name = (v) => (typeof v === 'function' ? '自定义动作' : v);
      const a = name(spec.on), b = name(spec.off);
      return spec.label + '（' + (a === b ? a : a + ' / ' + b) + '）';
    },
    devClickSvcOpts() {
      if (!window.PluginEngine) return [];
      return PluginEngine.clickServiceOptions();
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
    devState() {
      void this.entVersion;
      const it = this.selItem;
      if (!it || !it.entityId) return '';
      const st = HA.getState(it.entityId);
      if (!st) return '';
      return st.state + HA.unitOf(st);
    },
  },
  methods: {
    /* ---- 纯展示辅助（不需要回根组件） ---- */
    deg(rad) { return Math.round((rad || 0) * 180 / Math.PI); },
    devStyleIcon(s) { return window.devStyleIcon(s); },
    furnIcon(f, scale) { return window.furnIcon(f, scale); },
    devFieldVal(key) {
      void this.entVersion;
      const it = this.selItem;
      const eid = it && it[key];
      if (!eid) return '';
      const st = HA.getState(eid);
      if (!st) return '未找到';
      return st.state + HA.unitOf(st);
    },
    /* ---- 动作转发：根组件负责 commit / 撤销栈 / 引擎刷新 ---- */
    dirty() { this.$emit('dirty'); },
    setSelStyle(s) { this.$emit('set-sel-style', s); },
    setSelOpt(k, v) { this.$emit('set-sel-opt', k, v); },
    swapFurnModel(f) { this.$emit('swap-furn-model', f); },
    setFurnNum(k, v, t) { this.$emit('set-furn-num', k, v, t); },
    wheelFurn(k, e, s) { this.$emit('wheel-furn', k, e, s); },
    setDevNum(k, v, r) { this.$emit('set-dev-num', k, v, r); },
    wheelNum(k, e, s, r, min, max) { this.$emit('wheel-num', k, e, s, r, min, max); },
    setDevLabelOffset(v) { this.$emit('set-dev-label-offset', v); },
    commitDevLabelOffset(v) { this.$emit('commit-dev-label-offset', v); },
    wheelDevLabelOffset(e, s) { this.$emit('wheel-dev-label-offset', e, s); },
    setProp(k, v, t) { this.$emit('set-prop', k, v, t); },
    setDevClick(v) { this.$emit('set-dev-click', v); },
    setDevClickSvc(k) { this.$emit('set-dev-click-svc', k); },
    setOpenNum(k, v, t) { this.$emit('set-open-num', k, v, t); },
    wheelOpen(k, e, s, t) { this.$emit('wheel-open', k, e, s, t); },
    setOpenZ(v) { this.$emit('set-open-z', v); },
    wheelOpenZ(e, s) { this.$emit('wheel-open-z', e, s); },
    clearDevField(k) { this.$emit('clear-dev-field', k); },
    delSelected() { this.$emit('del-selected'); },
  },
};
</script>
