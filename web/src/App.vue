<template>
  <!-- 启动图：覆盖 JS/CSS 未加载完成时可能闪现的 Vue 模板字符串；挂载完成后由 bootDone() 移除 -->
  <div id="boot">
    <div class="b-logo">🏠</div>
    <div class="b-name">HA 3D Home</div>
    <div class="b-spin"></div>
    <div class="b-tip">正在加载，请稍候…</div>
  </div>

  <!-- 顶栏 -->
  <header id="topbar">
    <div class="tb-left">
      <div class="logo" style="cursor:pointer" title="点击打开展示大屏" @click="openDisplay">🏠 <b>{{ project ? project.name : '…' }}</b></div>
      <div class="tb-sep"></div>
      <div class="floor-switch">
        <button v-for="(f, i) in project.floors" :key="f.id" :class="{active: i === floorIdx}" @click="selectFloor(i)">{{ f.name }}</button>
        <button title="新增楼层" @click="addFloor">＋</button>
      </div>
      <div class="tb-chip" v-if="cur">{{ cur.walls.length }} 面墙 · {{ cur.devices.length }} 台设备</div>
    </div>
    <div class="tb-center">
      <div class="conn-chip" :class="connClass"><span class="dot"></span><span>{{ connText }}</span></div>
    </div>
    <div class="tb-right">
      <button class="tb-btn" title="撤销 (Ctrl+Z)" :disabled="!canUndo()" @click="undo">↶ 撤销</button>
      <button class="tb-btn" title="重做 (Ctrl+Shift+Z / Ctrl+Y)" :disabled="!canRedo()" @click="redo">↷ 重做</button>
      <div class="view-switch">
        <button :class="{active: mode === '2d'}" @click="setMode('2d')">2D 编辑</button>
        <button :class="{active: mode === '3d'}" @click="setMode('3d')">3D 展示</button>
      </div>
      <button class="tb-btn" :class="{primary: showLabels}" title="显示/隐藏 3D 设备标签" @click="toggleLabels">🏷 标签</button>
      <button class="tb-btn" title="长按 3D 画面可自定义旋转锚点；点此重置回房屋中心" @click="resetAnchor">◎ 重置锚点</button>
      <button class="tb-btn" @click="openConn">⛓ 连接</button>
      <button class="tb-btn primary" title="上传 zip 包：插件包（device/background）或家具包（catalog），同 id 覆盖升级" @click="openImport">导入插件/包</button>
    </div>
  </header>

  <div id="appBody">
    <!-- 左侧导航（统一状态机：除"重置本层"外全部平级，由 tool 单一状态驱动） -->
    <aside id="toolbar">
      <div class="tb-group">基础</div>
      <button class="tool" :class="{active: tool === 'select'}" data-key="V" @click="setTool('select')"><svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L16 19l-3 1.5-3-6.5L5 17z" fill="currentColor"/></svg><span>选择</span><i>V</i></button>
      <button class="tool" :class="{active: tool === 'pan'}" data-key="H" @click="setTool('pan')"><svg viewBox="0 0 24 24"><path d="M12 2l3 3h-2v5h5V8l3 3-3 3v-2h-5v5h2l-3 3-3-3h2v-5H6v2l-3-3 3-3v2h5V5H9z" fill="currentColor"/></svg><span>平移</span><i>H</i></button>
      <div class="tb-group">绘制</div>
      <button class="tool" :class="{active: tool === 'wall'}" data-key="W" @click="setTool('wall')"><svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="3" fill="currentColor"/><rect x="3" y="14" width="4" height="4" fill="currentColor" opacity=".5"/><rect x="10" y="14" width="4" height="4" fill="currentColor" opacity=".5"/><rect x="17" y="14" width="4" height="4" fill="currentColor" opacity=".5"/></svg><span>墙体</span><i>W</i></button>
      <button class="tool" :class="{active: tool === 'door'}" data-key="D" @click="setTool('door')"><svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="20" stroke="currentColor" stroke-width="2"/><line x1="6" y1="20" x2="6" y2="5" stroke="currentColor" stroke-width="2"/><path d="M6 5a15 15 0 0 1 15 15" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"/></svg><span>门</span><i>D</i></button>
      <button class="tool" :class="{active: tool === 'window'}" data-key="N" @click="setTool('window')"><svg viewBox="0 0 24 24"><rect x="3" y="9" width="18" height="6" rx="1" fill="none" stroke="currentColor" stroke-width="2"/><line x1="12" y1="9" x2="12" y2="15" stroke="currentColor" stroke-width="2"/></svg><span>窗</span><i>N</i></button>
      <div class="tb-group">放置</div>
      <button class="tool" :class="{active: tool === 'furniture'}" data-key="F" @click="setTool('furniture')"><svg viewBox="0 0 24 24"><path d="M4 11V7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="11" width="18" height="6" rx="1" fill="currentColor" opacity=".6"/></svg><span>家具</span><i>F</i></button>
      <button class="tool" :class="{active: tool === 'device'}" data-key="E" @click="setTool('device')"><svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3v3M9 3h6" stroke="currentColor" stroke-width="2" fill="none"/></svg><span>设备</span><i>E</i></button>
      <div class="tb-group">参考</div>
      <button class="tool" :class="{active: tool === 'bg'}" @click="setTool('bg')"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="2" fill="currentColor"/><path d="M4 18l5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="2"/></svg><span>贴图</span><i>B</i></button>
      <button class="tool" :class="{active: tool === 'backdrop'}" data-key="G" @click="setTool('backdrop')"><svg viewBox="0 0 24 24"><path d="M2 17h20" stroke="currentColor" stroke-width="2" fill="none"/><path d="M4 17l3-4 3 4M12 17l4-6 4 6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="6" r="2" fill="currentColor"/></svg><span>背景</span><i>G</i></button>
      <button class="tool danger sep" @click="openResetFloor"><svg viewBox="0 0 24 24"><path d="M12 4V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-8z" fill="currentColor"/></svg><span>重置本层</span></button>
    </aside>

    <!-- 画布区 -->
    <main id="canvasWrap">
      <canvas id="c2d" v-show="mode === '2d'"></canvas>
      <div id="c3dWrap" v-show="mode === '3d'"></div>

      <!-- 3D 预览提示（大屏 HUD 在 /display 页面） -->
      <div id="tooltip" :class="{hidden: !tooltipShow}" :style="tooltipStyle">{{ tooltipMsg }}</div>

      <div id="zoomBar" v-show="mode === '2d'">
        <button @click="zoomStep(1 / 1.2)">−</button>
        <span id="zoomVal">{{ zoomPct }}%</span>
        <button @click="zoomStep(1.2)">＋</button>
        <button @click="zoomCenter" title="居中">⌖</button>
        <button @click="zoomFit" title="适应">⤢</button>
      </div>
      <!-- 本层户型长宽（米，跟随当前楼层）：studio 背景占位盒取「各层最大尺寸」，保存时落盘 -->
      <div id="houseBadge" v-show="mode === '2d' && houseW > 0"
        :title="'本层户型 ' + houseW + ' × ' + houseD + ' 米；studio 背景占位盒参考各层最大尺寸'">
         {{ houseW }} × {{ houseD }}
      </div>
      <div id="statusBar" v-show="mode === '2d'">
        <span>编辑模式</span>
        <span :class="{saved: savedState === '已保存'}">{{ savedState }}</span>
        <span>数据存储于 data 目录</span>
      </div>
    </main>

    <!-- 右侧属性栏（2D/3D 预览均保留） -->
    <aside id="sidePanel" v-if="cur">

      <!-- 左侧「背景」工具激活时的专用面板：背景样式参数 + 实体绑定。
           从「楼层设置」里独立出来，只有选中左侧背景 tab 才出现；切回其它工具恢复楼层设置/选中属性。 -->
      <template v-if="tool === 'backdrop'">
        <div class="sp-title">背景设置</div>
        <!-- 3D 墙面（按楼层记忆）：从「楼层设置」迁入，和背景一起调最顺手 -->
        <div class="sp-sec"><h4>3D 墙面</h4>
          <div class="sp-row"><label>不透明度</label>
            <input type="range" min="0" max="100" step="5" :value="cur.wallOpacity != null ? cur.wallOpacity : 45" @input="setWallOpacity(parseFloat($event.target.value))">
            <input class="num-s" type="number" min="0" max="100" step="5" :value="cur.wallOpacity != null ? cur.wallOpacity : 45" @change="setWallOpacity(parseFloat($event.target.value))">
          </div>
          <div class="sp-tip">拖动实时预览；0 全透明，45 半透明可看见室内，100 不透明</div>
        </div>
        <div class="sp-sec" v-if="bgMeta">
          <h4>背景 · {{ bgMeta.icon }} {{ bgMeta.name }}</h4>
          <div class="bind-meta">
            <span class="bm" :title="bgMeta.plugin">{{ bgMeta.plugin }}</span>
            <span class="bm st" v-if="bgMeta.hz">动态 {{ bgMeta.hz }}Hz</span>
            <span class="bm" v-else>静态</span>
          </div>
          <div class="sp-row" v-for="o in bgOptionList" :key="o.key">
            <label>{{ o.label }}</label>
            <option-row :o="o" @set="setBgOpt"></option-row>
          </div>
          <div class="sp-tip">{{ bgMeta.hz ? '动态背景：引擎按 ' + bgMeta.hz + 'Hz 节流刷新，改参数即时重绘' : '静态背景：只在切换或房屋尺寸变化时绘制一次（零每帧开销）' }}</div>
          <div class="sp-tip">在左侧「背景」面板切换样式，选择即生效；离地高度可设为负值（低洼）</div>
        </div>
        <div class="sp-sec" v-else>
          <div class="sp-tip">当前是「纯色 + 网格」，没有背景插件参数。在左侧「背景」面板选一个样式后，样式参数与实体绑定会出现在这里。</div>
        </div>
        <div class="sp-sec" v-if="bgFieldList.length"><h4>背景 · 实体绑定</h4>
          <div class="sp-field" v-for="f in bgFieldList" :key="'bf-' + f.key">
            <div class="sp-field-hd">
              <label>{{ f.label || f.key }}</label>
              <span class="sp-val" :class="{bound: f.value}">{{ f.value || '未绑定' }}</span>
              <button v-if="f.value" type="button" class="sp-clear" title="解除绑定" @click="setBgField(f.key, '')">✕</button>
            </div>
            <entity-input :placeholder="f.placeholder || 'entity.xxx'" :domains="f.domains || null" :model-value="f.value" @update:model-value="setBgField(f.key, $event)"></entity-input>
            <div class="sp-tip" v-if="f.tip">{{ f.tip }}</div>
          </div>
          <div class="sp-tip">绑定的实体状态变化时自动回调插件顶层 onData(fields, api)；静态背景也能响应。未绑定或暂无数据时由插件自己回退</div>
        </div>
      </template>

      <!-- 未选中: 楼层/项目设置 -->
      <!-- 未选中 / 选中墙体: 楼层设置（墙没有可编辑属性，选中只做高亮 + Delete 删除） -->
      <template v-else-if="!selection || selection.kind === 'wall'">
        <div class="sp-title">楼层设置</div>
        <div class="sp-sec"><h4>项目</h4>
          <div class="sp-row"><label>名称</label><input :value="project.name" @change="setProjectName($event.target.value)"></div>
        </div>
        <!-- 3D 墙面与背景插件的参数/实体绑定已迁到「背景设置」面板（左侧选中「背景」工具时出现） -->
        <div class="sp-sec"><h4>楼层</h4>
          <div class="sp-row"><label>名称</label><input :value="cur.name" @change="cur.name = $event.target.value"></div>
          <div class="sp-row"><label>层高</label><input type="number" step="0.1" min="2" max="6" :value="cur.height" @input="setFloorHeight($event.target.value, 'input')" @change="setFloorHeight($event.target.value, 'change')"></div>
          <div class="sp-btns">
            <button class="sp-btn" @click="addFloor">＋ 新楼层</button>
            <button class="sp-btn warn" :disabled="project.floors.length <= 1" @click="delFloor">删除本层</button>
          </div>
        </div>
        <div class="sp-sec"><h4>大屏左侧·数据卡片</h4>
          <div class="sp-row"><label>天气实体</label>
            <entity-input placeholder="weather.xxx（全局，所有楼层共用）" :model-value="project.settings.weatherEntity || ''" @update:model-value="setWeather($event)"></entity-input>
          </div>
          <div class="sp-tip" style="margin-bottom:4px">数据卡按楼层独立配置，大屏切换楼层时跟随显示</div>
          <div class="sp-row" v-for="(c, i) in dataCardRows" :key="'c' + i"><label>数据卡{{ i + 1 }}</label>
            <entity-input :model-value="c" @update:model-value="setCard(i, $event)"></entity-input>
            <button class="row-x" title="删除此卡" @click="removeCard(i)">×</button>
          </div>
          <div class="sp-btns" style="margin-top:4px"><button class="sp-btn" @click="addCard">＋ 添加数据卡</button></div>
        </div>
        <div class="sp-sec"><h4>大屏右侧·快捷卡片</h4>
          <div class="sp-tip">勾选的场景与设备将在展示大屏右侧显示，可点击执行/控制；按楼层独立配置</div>
          <div class="sp-btns">
            <button class="sp-btn" @click="openDispCfg">⚙ 配置大屏展示项</button>
          </div>
          <div class="sp-row" style="margin-top:8px"><label>已选</label><input disabled :value="dispCountText"></div>
        </div>
        <div class="sp-sec"><h4>选择对象查看详情</h4>
          <div class="sp-steps">
            <div class="sp-step"><b>1</b>绘制墙体，摆放家具</div>
            <div class="sp-step"><b>2</b>放置设备并绑定 HA 实体</div>
            <div class="sp-step"><b>3</b>切到 3D 展示，实时查看与控制</div>
          </div>
        </div>
      </template>

      <!-- 选中: 属性 -->
      <template v-else-if="selItem">
        <div class="prop-name">{{ kindName }}{{ selName ? ' · ' + selName : '' }}</div>
        <div class="prop-kind" v-if="selItem.x != null">位置 ({{ selItem.x }}, {{ selItem.y }})</div>

        <!-- 样式选择 + 样式参数: 设备与门窗同一套（列表按 selection.kind 分派，见 app.js selStyleList/selOptList） -->
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
          <div class="sp-sec"><h4>设备绑定</h4>
            <div class="sp-row"><label>实体</label><entity-input placeholder="未绑定 · 搜索切换" :model-value="selItem.entityId || ''" @update:model-value="setProp('entityId', $event, 'str')"></entity-input></div>
            <div class="bind-meta">
              <span class="bm" v-if="selItem.name" :title="selItem.name">名称 {{ selItem.name }}</span>
              <span class="bm st" v-if="devState" :title="devState">状态 {{ devState }}</span>
              <span class="bm" :title="selItem.model || devStyleName || '默认造型'">模型 {{ selItem.model || devStyleName || '默认造型' }}</span>
            </div>
          </div>
          <div class="sp-sec"><h4>点击控制</h4>
            <label class="sp-check">
              <input type="checkbox" :checked="devClickOn" @change="setDevClick($event.target.checked)">
              <span>点击模型 / 标题标签执行<span v-if="devClickText">：{{ devClickText }}</span></span>
            </label>
            <div class="sp-row"><label>点击动作</label>
              <select :value="selItem.clickSvc || ''" @change="setDevClickSvc($event.target.value)">
                <option value="">插件内置点击事件</option>
                <option v-for="o in devClickSvcOpts" :key="o.on" :value="o.on">{{ o.label }}（{{ o.on === o.off ? o.on : o.on + ' / ' + o.off }}）</option>
              </select>
            </div>
            <div class="sp-tip">第一项走插件声明的 click（未声明时按内置默认）；其余为 HA 标准服务动作，选择后覆盖插件内置、优先级最高。勾选后点击 3D 设备即发送对应服务，取消勾选则不响应点击</div>
          </div>
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
          <div class="sp-sec"><h4>点击控制</h4>
            <label class="sp-check">
              <input type="checkbox" :checked="devClickOn" @change="setDevClick($event.target.checked)">
              <span v-if="devClickSpec || selItem.clickSvc">点击模型 / 标题标签执行<span v-if="devClickText && !selItem.clickSvc">：{{ devClickText }}</span><span v-else>：{{ selItem.clickSvc }}</span></span>
              <span v-else>点击模型 / 标题标签执行（默认不可点，勾选或选择动作后生效）</span>
            </label>
            <div class="sp-row"><label>点击动作</label>
              <select :value="selItem.clickSvc || ''" @change="setDevClickSvc($event.target.value)">
                <option value="">插件内置点击事件</option>
                <option v-for="o in devClickSvcOpts" :key="o.on" :value="o.on">{{ o.label }}（{{ o.on === o.off ? o.on : o.on + ' / ' + o.off }}）</option>
              </select>
            </div>
            <div class="sp-tip">门窗与设备同一规则：插件声明了 click（如卷帘门 open_cover/close_cover）默认勾选启用，没声明则默认不勾选。第一项走插件 click，其余为 HA 标准动作、选择后覆盖插件内置且优先级最高；未绑定实体的门窗点击不发送服务</div>
          </div>
        </template>

        <!-- 实体绑定: 设备/门窗同一套，按当前样式所属插件的 fields 声明渲染（selFields 按 kind 分派） -->
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
    </aside>
  </div>

  <!-- 贴图（参考底图）菜单 -->
  <div id="bgPanel" class="flyout" v-show="bgOpen" style="width:240px">
    <div class="flyout-head">参考贴图 <button class="close" @click="bgOpen = false">×</button></div>
    <div class="bg-ops">
      <button class="sp-btn" @click="pickBackground">📁 上传户型图…</button>
      <template v-if="bgInfo.has">
        <div class="bg-slider" v-show="!bgInfo.hidden">
          <label>贴图缩放（宽度）<b>{{ bgW }} m</b></label>
          <input type="range" min="2" max="40" step="0.5" :value="bgW" @input="onBgScale">
        </div>
        <button class="sp-btn" @click="toggleBg">{{ bgInfo.hidden ? '👁 显示贴图' : '🙈 隐藏贴图' }}</button>
        <button class="sp-btn warn" @click="clearBg">🗑 删除贴图</button>
      </template>
      <div class="sp-tip" style="margin:2px 2px 0">上传户型图作为 2D 画布底图辅助描墙（默认置于原点、宽 10、半透明）。全楼层共用一张：服务器只存 data/refimg.* 一张图（重复上传自动覆盖），随项目持久化；画完户型图可删。</div>
    </div>
  </div>
  <input type="file" ref="bgFile" accept="image/*" style="display:none" @change="onBgFile">

  <!-- 重置当前楼层确认 -->
  <div id="resetModal" class="modal" v-show="resetOpen">
    <div class="modal-box small">
      <div class="modal-head"><h2>重置当前楼层</h2><button class="close" @click="resetOpen = false">×</button></div>
      <div class="sp-tip" style="margin-bottom:10px">
        将清空「{{ cur ? cur.name : '' }}」的全部内容：墙体、门窗、家具、设备。<br>
        重置后自动保存且不可撤销。如需保留，请先取消并自行备份 data/project.json。
      </div>
      <input class="search" style="margin:0 0 12px; width:100%" placeholder="请输入：确认" v-model="resetText" @keydown.enter="confirmResetFloor">
      <div class="form-row">
        <button class="tb-btn primary" :class="{disabled: resetText.trim() !== '确认'}" :disabled="resetText.trim() !== '确认'" @click="confirmResetFloor">确认重置</button>
        <button class="tb-btn" @click="resetOpen = false">取消</button>
      </div>
    </div>
  </div>

  <!-- 家具库 -->
  <div id="furnPanel" class="flyout" v-show="furnOpen">
    <div class="flyout-head">家具 <button class="close" @click="furnOpen = false">×</button></div>
    <div class="furn-cats">
      <button v-for="t in furnTabs" :key="t.key" :class="{active: t.key === 'all' ? !furnCat : furnCat === t.key}" @click="furnCat = (t.key === 'all' ? null : t.key)">{{ t.label }}</button>
    </div>
    <div class="furn-grid">
      <button class="furn-item" v-for="f in furnListByCat" :key="f.id" :class="{sel: ghostFurn === f.id}" @click="pickFurniture(f)">
        <i class="fz" v-if="f.custom">自定义</i>
        <span v-html="furnIcon(f)"></span>
        <span class="fn">{{ f.name }}</span>
        <span class="fs">{{ f.w }} × {{ f.d }} {{ f.auto ? ' · 自动发现' : '' }}</span>
      </button>
    </div>
  </div>

  <!-- 背景面板（背景插件按插件分组，只显示图标+文字，点击即应用） -->
  <div id="backdropPanel" class="flyout" v-show="backdropOpen">
    <div class="flyout-head">背景 <button class="close" @click="setTool('select', true)">×</button></div>
    <div class="bg-groups">
      <div class="bg-group" v-for="g in bgGroups" :key="g.plugin">
        <div class="bg-group-hd"><span class="hd-name">{{ g.name }}</span><i class="bz cus" v-if="g.custom">自定义</i></div>
        <div class="bg-grid">
          <button v-for="b in g.items" :key="b.id" :class="{active: bgStyle === b.id}" :title="b.name + (b.hz ? ' · 动态 ' + b.hz + 'Hz' : ' · 静态')" @click="setBackground(b)">
            <span class="ic">{{ b.icon }}</span><span class="nm">{{ b.name }}</span><i class="bz" v-if="b.hz">动</i>
          </button>
        </div>
      </div>
      <div class="bg-group">
        <div class="bg-group-hd"><span class="hd-name">默认</span></div>
        <div class="bg-grid">
          <button :class="{active: !bgStyle}" title="无背景插件时使用纯色 + 网格" @click="setBackground(null)">
            <span class="ic">▦</span><span class="nm">纯色 + 网格</span>
          </button>
        </div>
      </div>
      <div class="sp-tip" v-if="!bgGroups.length">未发现背景插件 · 把插件放到 assets/plugins/&lt;id&gt;/（kind: background）后重启即可出现在这里</div>
      <template v-else>
        <div class="sp-tip">「动」= 动态背景，由插件声明刷新率驱动；其余为静态，只在切换/尺寸变化时绘制一次。选中后到右侧「背景设置」面板调样式参数与实体绑定</div>
        <div class="sp-tip bg-live-tip">背景在 3D 演示模型中预览，选择即生效</div>
      </template>
    </div>
  </div>

  <!-- 设备面板 -->
  <div id="devPanel" class="flyout wide" v-show="devOpen">
    <div class="flyout-head">设备 <button class="close" @click="devOpen = false">×</button></div>
    <input class="search" placeholder="搜索实体、类型或状态" v-model="devSearch">
    <div class="dev-filters" :class="{'fade-l': tabsFadeL, 'fade-r': tabsFadeR}">
      <!-- 分类页签由 catalog.js 的 DEVICE_TYPES 派生；单行横向滚动，零计数分类自动隐藏 -->
      <div class="dev-tabs" ref="devTabsBox" @scroll="onTabsScroll" @wheel.prevent="onTabsWheel">
        <button v-for="t in devTabs" :key="t.key"
                :class="{active: devFilter === t.key, zero: !devData.counts[t.key]}"
                @click="devFilter = t.key">{{ t.icon }} {{ t.label }} <b>{{ devData.counts[t.key] || 0 }}</b></button>
      </div>
    </div>
    <div class="dev-list" ref="devListBox">
      <div v-if="devData.placed.length" style="padding:2px 4px 6px;color:#8a93a5;font-size:11px">已放置 {{ devData.placed.length }} 个设备点位</div>
      <div class="dev-item" v-for="p in devData.placed" :key="'p' + p.d.id">
        <div class="ic">{{ typeIcon(p.d.type) }}</div>
        <div class="m"><div class="n">{{ p.name }}</div><div class="s"><code>{{ p.d.entityId }}</code> · {{ p.fl }}</div></div>
        <div class="act"><button class="tb-btn" style="padding:3px 9px" @click="locateDevice(p)">定位</button></div>
      </div>
      <div class="dev-item" v-for="e in devData.list" :key="e.eid" style="cursor:pointer" @click="pickEntity(e)">
        <div class="ic">{{ typeIcon(e.type) }}</div>
        <div class="m"><div class="n">{{ e.name }}</div><div class="s"><code>{{ e.eid }}</code></div></div>
        <div class="st" :class="e.on ? 'st-on' : 'st-off'">{{ e.stateText }}</div>
        <div class="act">＋</div>
      </div>
      <div class="sp-empty" v-if="!devData.list.length && !devData.placed.length">
        <template v-if="haStatus.status === 'connected'">该分类下暂无实体</template>
        <template v-else>暂无实体<br>请先在「连接」中配置 Home Assistant</template>
      </div>
    </div>
  </div>

  <!-- 连接与服务 -->
  <div id="connModal" class="modal" v-show="connOpen">
    <div class="modal-box">
      <div class="modal-head"><div><div class="modal-sub">家庭中心</div><h2>连接与服务</h2></div><button class="close" @click="connOpen = false">×</button></div>
      <div class="conn-card">
        <div class="conn-ic">📶</div>
        <div><div class="conn-t">HOME ASSISTANT</div><div class="conn-s" :class="haStatus.status === 'connected' ? 'ok' : 'bad'">{{ connStateText }}</div></div>
      </div>
      <div class="form">
        <label>Home Assistant 地址</label>
        <input v-model="inHaUrl" placeholder="http://192.168.31.16:8123">
        <label>API Key / 长期访问令牌</label>
        <textarea v-model="inToken" rows="4" placeholder="粘贴 Home Assistant 长期访问令牌（用户头像 → 安全 → 长期访问令牌）"></textarea>
        <div class="tip">⚠️ 令牌将下发到浏览器用于直连 HA WebSocket，请仅在可信内网使用。</div>
        <div class="form-row">
          <button class="tb-btn primary" @click="saveConn">保存并连接</button>
          <button class="tb-btn" @click="testConn">测试</button>
        </div>
        <div class="conn-msg" :class="connMsgOk ? 'ok' : 'err'" v-if="connMsg">{{ connMsg }}</div>
      </div>
      <div class="conn-info">
        <div class="r"><span>运行模式</span><b>独立部署 (Docker)</b></div>
        <div class="r"><span>地址</span><b>{{ haUrlText }}</b></div>
        <div class="r"><span>实体</span><b>{{ entityCount }}</b></div>
        <div class="r"><span>实时通道</span><b>浏览器直连 WebSocket</b></div>
      </div>
    </div>
  </div>

  <!-- 导入插件：拖拽 / 点击选择 zip，选好就自动上传 -->
  <div id="importModal" class="modal" v-show="importOpen" @dragover.prevent @drop.prevent>
    <div class="modal-box">
      <div class="modal-head">
        <div><div class="modal-sub">插件 / 家具</div><h2>导入插件/包</h2></div>
        <button class="close" @click="closeImport">×</button>
      </div>
      <div class="imp-drop" :class="{ over: importDrag, busy: importing }"
        @click="pickPluginFile"
        @dragover.prevent="importDrag = true"
        @dragenter.prevent="importDrag = true"
        @dragleave.prevent="importDrag = false"
        @drop.prevent="onPluginDrop">
        <div class="imp-ic">{{ importing ? '⏳' : '📦' }}</div>
        <div class="imp-t">{{ importing ? '正在导入 ' + (importFile ? importFile.name : '') + '…' : (importFile ? importFile.name : '拖拽 zip 包到这里（插件包 / 家具包都可以）') }}</div>
        <div class="imp-s">{{ importing ? '服务器正在解压并按包类型自动分流安装' : '或点击本区域选择 .zip 文件' }}</div>
      </div>
      <!-- 文件选择框放在拖拽区外面：否则 input.click() 的点击事件会冒泡回父级，形成反复打开选择框 -->
      <input ref="impFile" type="file" accept=".zip,application/zip" style="display:none" @change="onPluginPick">
      <div class="tip">可以在 <a href="https://gitee.com/sunhuip/ha3d-plugin-studio" target="_blank" rel="noopener">ha3d-plugin-studio</a> 项目中开发插件和家具包，打包后在这里导入（同 id 整包覆盖升级）。</div>

      <!-- 安装密钥：studio 远程发布插件时要在设置里填同一个值 -->
      <div class="imp-key">
        <div class="imp-key-head">
          <span>安装密钥 <em>studio 远程发布用</em></span>
          <button class="tb-btn tiny" v-if="!keyLocked" :disabled="keyBusy" @click="genInstallKey">{{ keyBusy ? '生成中…' : (keyTail ? '重新生成' : '生成密钥') }}</button>
        </div>
        <div class="imp-key-row" v-if="keyValue">
          <code>{{ keyValue }}</code>
          <button class="tb-btn tiny" @click="copyInstallKey">{{ keyCopied ? '已复制' : '复制' }}</button>
        </div>
        <div class="imp-key-s" v-else-if="keyTail">已设置 · 末 4 位 <code>{{ keyTail }}</code>，重新生成才会显示完整值</div>
        <div class="imp-key-s" v-else-if="keyLocked">已由环境变量 <code>HA3D_INSTALL_KEY</code> 设置</div>
        <div class="imp-key-s" v-else>尚未设置 · 点「生成密钥」生成一个，填到 studio 设置里即可一键发布</div>
      </div>
      <div class="conn-msg" :class="importMsgOk ? 'ok' : 'err'" v-if="importMsg">{{ importMsg }}</div>
    </div>
  </div>

  <!-- 展示大屏配置（勾选场景与设备） -->
  <div id="dispCfgModal" class="modal" v-show="dispOpen">
    <div class="modal-box small">
      <div class="modal-head"><h2>展示大屏 · 展示项配置</h2><button class="close" @click="dispOpen = false">×</button></div>
      <div class="sp-tip" style="margin-bottom:10px">勾选场景出现在展示大屏右侧（可点击执行）；快捷设备用搜索添加任意实体，显示为快捷开关</div>

      <h4 style="font-size:13px;margin-bottom:6px">🎬 场景（{{ dispScenes.length }}）</h4>
      <div class="dev-list" style="max-height:200px">
        <label class="dev-item chk" v-for="s in dispScenes" :key="s.eid">
          <input type="checkbox" :checked="inList(cur.display.displayScenes, s.eid)" @change="toggleList('displayScenes', s.eid)">
          <div class="m"><div class="n">{{ s.name }}</div><div class="s"><code>{{ s.eid }}</code></div></div>
        </label>
        <div class="sp-empty" v-if="!dispScenes.length">HA 中暂无场景（scene 实体）<br>可在 Home Assistant 中创建场景后再来配置</div>
      </div>

      <h4 style="font-size:13px;margin:14px 0 6px">⚡ 快捷设备（{{ quickList.length }}）</h4>
      <div class="dev-list" style="max-height:200px">
        <div class="dev-item chk" v-for="q in quickList" :key="q.eid">
          <div class="ic">{{ quickIcon(q.eid) }}</div>
          <div class="m"><div class="n">{{ q.name }}</div><div class="s"><code>{{ q.eid }}</code></div></div>
          <button type="button" class="sp-clear" title="移除" @click="removeQuickDevice(q.eid)">✕</button>
        </div>
        <div class="sp-empty" v-if="!quickList.length">还没有快捷设备<br>用下方搜索添加任意 HA 实体（不需要先在户型中放置）</div>
      </div>
      <div class="quick-add">
        <entity-input placeholder="搜索实体添加为快捷设备，如 light.xxx（回车添加）" :model-value="quickInput" @update:model-value="quickInput = $event" @keydown.enter="addQuickDevice"></entity-input>
        <button type="button" class="tb-btn" :disabled="!quickInput" @click="addQuickDevice">＋ 添加</button>
      </div>

      <div class="form-row">
        <button class="tb-btn primary" @click="dispOpen = false">完成</button>
        <button class="tb-btn" @click="clearDispCfg">清空全部</button>
      </div>
    </div>
  </div>

  <!-- 左下角版本号：由 /js/version.js 从 /api/version 填充（唯一出处 package.json），不写死 -->
  <span class="tb-ver tb-ver-corner" data-app-version hidden></span>
</template>

<script>
/*
 * App.vue — 编辑页根组件（由 public/js/app.js 的伪 Vue 组件迁移为 SFC）
 *
 * 迁移口径与 DisplayApp.vue 一致：
 *  - 模板 = 原 public/index.html 的 #app 内容（v-* 指令原样保留）
 *  - data / computed / methods / watch / mounted 原样保留（Options API）
 *  - HA / HUD / Editor / View3D / PluginEngine / Recode / loadCatalog / fetchProject /
 *    buildDefaultProject / allFurniture / furnIcon / devStyleIcon … 等共享模块仍按
 *    window 全局直接使用，不改动 public/js；它们由 web/index.html 里的经典 <script> 挂载。
 *  - EntityInput / OptionRow 两个子组件抽成独立 SFC，本地注册。
 */
import EntityInput from './EntityInput.vue';
import OptionRow from './OptionRow.vue';

export default {
  name: 'App',
  components: { EntityInput, OptionRow },

  data() {
    return {
      project: { name: '我的家', floors: [], settings: newSettings() },
      floorIdx: 0,
      mode: '2d',
      showLabels: true,   // 3D 设备标签显示开关
      tool: 'select',
      selection: null,          // {kind, id}
      savedState: '已保存',
      houseW: 0, houseD: 0,     // 本层户型长宽（米）——2D 徽标显示，跟随当前楼层（切层即刷新）
      entVersion: 0,            // HA 实体变化版本号（触发计算属性）
      histVer: 0,               // 历史栈版本号（撤销/重做按钮置灰态的触发器）
      haStatus: { status: 'connecting' },

      furnOpen: false,
      devOpen: false,
      ghostFurn: null,          // 待放置家具的形态 id（catalog item.id，不是 type）
      furnCat: null,            // 家具库当前类别（null=全部）

      devSearch: '',
      devFilter: 'all',
      tabsFadeL: false,         // 分类页签左侧还有内容（渐隐提示）
      tabsFadeR: false,         // 右侧还有内容

      connOpen: false,
      inHaUrl: '',
      inToken: '',
      connMsg: '',
      connMsgOk: false,

      /* 导入插件（zip 上传：拖拽或点选，选好后自动上传） */
      importOpen: false,
      importDrag: false,
      importing: false,
      importFile: null,
      importMsg: '',
      importMsgOk: true,
      /* 安装密钥：studio 发布插件时要在设置里填同一个值。
       * keyValue 只在「刚生成」的这一次会话里拿得到（生成接口的响应），刷新后
       * 页面只显示末 4 位 —— 明文始终可以从服务端 data/install-key.json 取回。 */
      keyTail: '',
      keyLocked: false,
      keyValue: '',
      keyBusy: false,
      keyCopied: false,

      dispOpen: false,      // 展示大屏配置弹窗
      quickInput: '',       // 快捷设备搜索输入

      bgOpen: false,        // 贴图（参考底图）菜单
      backdropOpen: false,  // 背景插件面板（3D 地面背景：扁平/立体、静态/动态）
      bgTick: 0,            // 背景参数变更计数器（驱动 bgOptionList 重算）
      bgW: 10,              // 贴图宽度（米，滑块双向绑定）
      bgInfo: { has: false, hidden: false },

      resetOpen: false,     // 重置本层确认弹窗
      resetText: '',

      zoomPct: 100,
      tooltipMsg: '',
      tooltipShow: false,
      tooltipStyle: {},
    };
  },

  computed: {
    cur() { return this.project ? this.project.floors[this.floorIdx] : null; },
    /* 数据卡列表（按楼层独立；动态数量，至少显示一行空行便于添加） */
    dataCardRows() {
      const c = (this.cur && this.cur.display && this.cur.display.dataCards) || [];
      return c.length ? c : [''];
    },
    furnitureList() { void this.entVersion; return allFurniture(); },
    /* 家具分类页签（catalog.js 派生: 全部 → 各固定类型 → 其他） */
    furnTabs() {
      void this.entVersion;
      return furnitureTabs();
    },
    /* 当前类型下的家具形态（null=全部; 'other'=其他，含历史数据里枚举外的野值） */
    furnListByCat() {
      void this.entVersion;
      const all = allFurniture();
      if (!this.furnCat) return all;
      if (this.furnCat === 'other') return all.filter((f) => isOtherFurnType(f.type));
      return all.filter((f) => f.type === this.furnCat);
    },
    /* 背景插件（按插件分组；面板只显示 icon + 文案，不做实时预览） */
    bgGroups() {
      void this.entVersion;
      return (window.PluginEngine && PluginEngine.ready) ? PluginEngine.backgroundGroups() : [];
    },
    /* 当前背景（项目设置里的聚合 id，如 'background:grass'；空=默认纯色+网格） */
    bgStyle() {
      return (this.project && this.project.settings && this.project.settings.background) || '';
    },
    /* 当前背景的元信息（未选中对象时右侧面板标题用） */
    bgMeta() {
      void this.entVersion;
      void this.bgTick;
      if (!this.bgStyle || !window.PluginEngine || !PluginEngine.ready) return null;
      const b = PluginEngine.backgroundOf(this.bgStyle);
      if (!b) return null;
      return { name: b.name, icon: b.icon, plugin: b.group, hz: b.hz || 0 };
    },
    /* 当前背景可配置参数（插件声明 options schema，值 = 默认值 ∪ 已保存值） */
    bgOptionList() {
      void this.entVersion;
      void this.bgTick;
      if (!this.bgStyle || !window.PluginEngine || !PluginEngine.ready) return [];
      const schema = PluginEngine.normalizeOptions(PluginEngine.optionsSchema(this.bgStyle));
      if (!schema.length) return [];
      const saved = (PluginEngine.bgOptions && PluginEngine.bgOptions[this.bgStyle]) || {};
      return schema.map((o) => Object.assign({}, o, {
        value: saved[o.key] != null && saved[o.key] !== '' ? saved[o.key] : o.def,
      }));
    },
    /* 当前背景的「动态实体字段」绑定区（def.fields 声明；值存 settings.backgroundFields）。
     * 与 bgOptionList 的静态手工参数分开：这里的实体状态变化会回调插件顶层 onData(fields, api)。
     * 绑定按**插件**共用一份：同一插件下切换具体样式不会丢失已绑实体。 */
    bgFieldList() {
      void this.entVersion;   // 插件异步加载完成后重算（loadAll 完成时会 entVersion++）
      void this.bgTick;
      if (!this.bgStyle || !window.PluginEngine || !PluginEngine.ready) return [];
      const bd = PluginEngine.backgroundOf(this.bgStyle);
      if (!bd || !Array.isArray(bd.fields) || !bd.fields.length) return [];
      const saved = PluginEngine.bgBindings(this.bgStyle);
      return bd.fields.filter((f) => f && f.key).map((f) => Object.assign({}, f, {
        value: saved[f.key] || '',
      }));
    },
    /* 选中项标题（家具从目录形态解析；设备名跟随 HA，门窗跟随插件样式名） */
    selName() {
      const it = this.selItem;
      if (!it || !this.selection) return '';
      void this.entVersion;   // HA 改名 / 插件加载完成后重算
      return itemDisplayName(this.selection.kind, it);
    },
    /* 选中家具的固定类型（目录解析，枚举外的历史野值已归一成 other） */
    furnType() {
      const it = this.selItem;
      if (!it || !this.selection || this.selection.kind !== 'furniture') return '';
      return furnSpec(it).type;
    },
    /* 选中家具有没有可用模型：目录与实例都没给地址时，面板才露出「模型地址」手填行 */
    selHasModel() {
      const it = this.selItem;
      if (!it || !this.selection || this.selection.kind !== 'furniture') return true;
      return !!(it.model || furnSpec(it).model);
    },
    /* 选中家具的同类模型（右侧切换，按固定类型聚合） */
    sameModels() {
      void this.entVersion;
      const it = this.selItem;
      if (!it || this.selection.kind !== 'furniture') return [];
      const t = furnSpec(it).type;
      if (!t) return [];
      /* 「其他」把野值一起收进来（归一后它们都显示为 other） */
      return allFurniture().filter((f) => (t === 'other' ? isOtherFurnType(f.type) : f.type === t));
    },
    /* 选中对象的插件样式列表（右侧切换）: 设备按 type 聚合，门窗按插件 styles 聚合 */
    selStyleList() {
      const it = this.selItem;
      if (!it) return [];
      const k = this.selection.kind;
      if (k === 'device') return deviceStyles(devTypeOf(it)) || [];
      if (k === 'door' || k === 'window') {
        void this.entVersion;   // 插件异步加载完成后重算
        if (!window.PluginEngine || !PluginEngine.ready) return [];
        return PluginEngine.styles(k) || [];
      }
      return [];
    },
    selStyleId() {
      const it = this.selItem;
      if (!it) return '';
      if (this.selection.kind === 'device') {
        const s = deviceStyleDef(it, devTypeOf(it));
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
    /* 样式区标题: 设备按类型取名（灯体样式/设备造型），门窗用 kindName */
    selStyleTitle() {
      return this.selection.kind === 'device'
        ? (this.devIsLight ? '灯体样式' : '设备造型')
        : this.kindName + '样式';
    },
    devIsLight() {
      const it = this.selItem;
      if (!it || this.selection.kind !== 'device') return false;
      return devTypeOf(it) === 'light';
    },
    devStyleName() {
      const it = this.selItem;
      if (!it || this.selection.kind !== 'device') return '';
      const type = devTypeOf(it);
      const s = deviceStyleDef(it, type);
      return s ? s.name : '';
    },
    /* 标签抬升高度的造型默认值（styles[].labelOffset，缺省 0.3m） */
    labelOffsetDefault() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it) return 0.3;
      if (k !== 'device' && k !== 'door' && k !== 'window') return 0.3;
      const type = k === 'device' ? devTypeOf(it) : k;
      return window.PluginEngine ? PluginEngine.labelOffset(type, it.style) : 0.3;
    },
    /* 面板显示值：实例覆盖 obj.labelOffset 优先，没设过就显示造型默认值 */
    labelOffsetVal() {
      const it = this.selItem;
      return it && it.labelOffset != null ? it.labelOffset : this.labelOffsetDefault;
    },
    /* 当前样式的条目参数（样式条目声明 options schema，值 = 默认值 ∪ 实例已存值 obj.styleOpts）。
     * 引擎对设备/门窗一视同仁（ctx.options 注入），设备样式声明了 options 也能在这里配 */
    selOptList() {
      void this.entVersion;
      const k = this.selection && this.selection.kind;
      if (k !== 'device' && k !== 'door' && k !== 'window') return [];
      const it = this.selItem;
      if (!it) return [];
      const s = this.selStyleList.find((x) => x.id === this.selStyleId);
      const schema = PluginEngine.normalizeOptions((s && s.options) || []);
      if (!schema.length) return [];
      const saved = it.styleOpts || {};
      return schema.map((o) => Object.assign({}, o, {
        value: saved[o.key] != null && saved[o.key] !== '' ? saved[o.key] : o.def,
      }));
    },
    /* 选中对象的插件绑定字段（设备/门窗同一套: 按当前样式所属**插件**取 fields 声明；
     * 切到没有 fields 的插件样式（如自定义台灯/固定窗）本区自动隐藏）
     * ⚠ 绑定值存在实例 obj[key] 上（不是按 style 分桶），同一插件下切换多个样式
     *   共用同一份绑定 —— 灯换个灯体造型不会丢已绑的功率/色温实体。
     *   序列化时 catalog.copyFields 用所有插件 fields 的并集做白名单，切样式/存档都不丢。 */
    selFields() {
      const k = this.selection.kind;
      if (k !== 'device' && k !== 'door' && k !== 'window') return [];
      if (!window.PluginEngine) return [];
      void this.entVersion;   // 插件异步加载完成后重算
      const it = this.selItem;
      const kindOrType = k === 'device' ? devTypeOf(it) : k;
      const def = PluginEngine.defFor(kindOrType, it && it.style);
      return def ? PluginEngine.fieldsOf(def) : [];
    },
    /* 实体绑定区的说明文案（设备/门窗各一句） */
    selFieldsTip() {
      return this.selection.kind === 'device'
        ? '除主实体外，插件还可挂功率/温湿度/人体/曲目等实体，用来丰富模型屏幕与标签的数据'
        : '绑定实体后由插件按状态驱动模型（如门磁 on=开门动画）';
    },

    /* 点击控制规格（插件声明优先，否则内置默认；null = 不支持点击）。
     * 设备与门/窗同一套：门/窗的 type 就是 'door'/'window'（实例数据没有 type 字段，按选中种类传） */
    devClickSpec() {
      const it = this.selItem;
      const k = this.selection && this.selection.kind;
      if (!it || !window.PluginEngine) return null;
      if (k !== 'device' && k !== 'door' && k !== 'window') return null;
      return PluginEngine.clickSpec(k === 'device' ? devTypeOf(it) : k, it.style);
    },
    /* 复选框状态: 实例显式设置优先，未设置时跟随插件的 defaultOn。
     * 门窗已并入设备、同一规则：插件声明了 click 的门窗默认勾选，
     * 没声明的没有 spec、默认不勾选（即旧的「门窗默认不可点」效果改由插件声明驱动） */
    devClickOn() {
      const it = this.selItem;
      if (!it) return false;
      if (it.click === true || it.click === false) return it.click;
      const spec = this.devClickSpec;
      return !!(spec && spec.defaultOn);
    },
    devClickText() {
      const spec = this.devClickSpec;
      if (!spec) return '';
      /* on/off 为插件自定义函数时显示「自定义动作」（服务名拿不到） */
      const name = (v) => (typeof v === 'function' ? '自定义动作' : v);
      const a = name(spec.on), b = name(spec.off);
      return spec.label + '（' + (a === b ? a : a + ' / ' + b) + '）';
    },
    /* 「点击动作」下拉选项：全局拉平一张表（不按设备域分流，绝对自由选）；
     * 实例选中的值存 it.clickSvc = on 服务名，发服务的域由绑定实体前缀决定 */
    devClickSvcOpts() {
      if (!window.PluginEngine) return [];
      return PluginEngine.clickServiceOptions();
    },

    /* 展示大屏展示项配置数据 */
    dispScenes() {
      void this.entVersion;
      return HA.all()
        .filter((s) => /^scene\./.test(s.entity_id))
        .map((s) => ({ eid: s.entity_id, name: HA.friendly(s.entity_id) }));
    },
    /* 快捷设备列表（当前楼层 display.quickDevices，含任意 HA 实体，不限户型内） */
    quickList() {
      void this.entVersion;
      return ((this.cur && this.cur.display && this.cur.display.quickDevices) || [])
        .map((eid) => ({ eid, name: HA.friendly(eid) || eid }));
    },
    dispCountText() {
      const d = (this.cur && this.cur.display) || {};
      return ((d.displayScenes || []).length) + ' 个场景 · ' + ((d.quickDevices || []).length) + ' 个设备';
    },
    selItem() {
      if (!this.selection || !this.cur) return null;
      const map = { wall: 'walls', door: 'doors', window: 'windows', furniture: 'furniture', device: 'devices' };
      const arr = this.cur[map[this.selection.kind]];
      return arr ? arr.find((x) => x.id === this.selection.id) || null : null;
    },
    kindName() {
      return this.selection ? ({ wall: '墙体', door: '门', window: '窗', furniture: '家具', device: '设备' })[this.selection.kind] : '';
    },
    devState() {
      void this.entVersion;
      const it = this.selItem;
      if (!it || !it.entityId) return '';
      const st = HA.getState(it.entityId);
      if (!st) return '';
      return st.state + HA.unitOf(st);
    },

    /* 设备面板分类页签: 完全由 catalog.js 的 DEVICE_TYPES 派生（新增类型不用改 UI）。
     * 零计数的分类默认隐藏（全部/其他/已添加常驻），当前选中的那一项始终保留，
     * 避免数据变化时选中的按钮凭空消失。 */
    devTabs() {
      const c = this.devData.counts || {};
      const keep = { all: 1, other: 1, placed: 1 };
      return deviceTabs().filter((t) => keep[t.key] || (c[t.key] || 0) > 0 || this.devFilter === t.key);
    },

    /* 设备面板数据 */
    devData() {
      void this.entVersion;
      const counts = { all: HA.all().length };
      Object.keys(DEVICE_TYPES).forEach((k) => { counts[k] = 0; });
      const q = this.devSearch.toLowerCase();
      const f = this.devFilter;
      const list = [];
      HA.all().forEach((s) => {
        const eid = s.entity_id;
        const type = deviceTypeOf(eid);
        counts[type] = (counts[type] || 0) + 1;
        // 分类过滤: all 显示全部；placed 只显示已放置点位；其余按 type 精确匹配
        if (f !== 'all') {
          if (f === 'placed') return;
          if (type !== f) return;
        }
        const name = HA.friendly(eid);
        if (q && !(eid.toLowerCase().includes(q) || name.toLowerCase().includes(q) || (s.state || '').toLowerCase().includes(q))) return;
        const unit = HA.unitOf(s);
        /* 状态文案与"已开启"判定都问插件（与 3D 标签同一套规则），不在 UI 里按 type 写分支 */
        const txt = window.PluginEngine ? PluginEngine.labelOf(type, s) : '';
        list.push({
          eid, name, type,
          on: HA.entityIsOn(eid, type),
          stateText: txt || (s.state === 'on' ? '已开启' : s.state === 'off' ? '已关闭' : s.state + unit),
        });
      });
      const placed = [];
      if (this.project) {
        this.project.floors.forEach((fl, fi) => fl.devices.forEach((d) => {
          // "已添加"分类: 支持按名称/实体/楼层过滤（设备名实时由 HA 解析，实例不存 name）
          const hay = (HA.friendly(d.entityId) + ' ' + (d.name || '') + ' ' + (d.entityId || '') + ' ' + fl.name).toLowerCase();
          if (q && !hay.includes(q)) return;
          placed.push({ fl: fl.name, fi, d, name: itemDisplayName('device', d) });
        }));
        counts.placed = placed.length;
      }
      // 已放置点位只在"已添加"分类显示，其余 tab 只看实体列表
      if (this.devFilter === 'placed') return { counts, list: [], placed };
      return { counts, list: list.slice(0, 120), placed: [] };
    },

    /* 连接状态 */
    connClass() {
      const s = this.haStatus.status;
      return { on: s === 'connected', err: s === 'demo' || s === 'error' || s === 'disconnected' };
    },
    connText() {
      const s = this.haStatus.status;
      if (s === 'connected') return 'HA 已连接';
      if (s === 'demo') return '演示模式';
      if (s === 'connecting') return '连接中…';
      if (s === 'error') return this.haStatus.message || '连接失败';
      return '未连接';
    },
    connStateText() {
      const s = this.haStatus.status;
      if (s === 'connected') return '已连接 · 设备状态正在实时同步';
      if (s === 'demo') return '演示模式（未配置 Home Assistant）';
      if (s === 'connecting') return '正在连接…';
      return this.haStatus.message || '未连接';
    },
    haUrlText() { return HA.url || '未配置'; },
    entityCount() { void this.entVersion; return HA.all().length; },

    /* HUD（纯函数在共享模块 hud.js，编辑页与大屏同一套实现） */
    weatherState() {
      void this.entVersion;
      return HUD.weatherState(HA, this.project && this.project.settings);
    },
    hudTemp() {
      void this.entVersion;
      return HUD.hudTemp(this.weatherState);
    },
    hudSubs() {
      void this.entVersion;
      return HUD.hudSubs(this.weatherState);
    },
    hudCards() {
      void this.entVersion;
      return HUD.hudCards(HA, this.cur && this.cur.display);
    },
  },

  methods: {
    /* ------- 设备分类页签（单行横向滚动） ------- */
    onTabsScroll() { this.updateTabsEdge(); },
    /* 鼠标滚轮在页签条上 → 横向滚动（触控板横向滑动同样支持） */
    onTabsWheel(e) {
      const box = this.$refs.devTabsBox;
      if (!box) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      box.scrollLeft += delta;
      this.updateTabsEdge();
    },
    /* 两端渐隐提示: 只有该侧确实还有被裁掉的内容时才显示 */
    updateTabsEdge() {
      const box = this.$refs.devTabsBox;
      if (!box || !box.clientWidth) return;
      const max = box.scrollWidth - box.clientWidth;
      this.tabsFadeL = box.scrollLeft > 2;
      this.tabsFadeR = max > 2 && box.scrollLeft < max - 2;
    },
    /* 选中的分类滚动到可视区中部（切换分类、数据变化、面板打开时调用） */
    scrollTabsToActive() {
      const box = this.$refs.devTabsBox;
      if (!box || !box.clientWidth) return;
      const el = box.querySelector('button.active');
      if (el) {
        const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
        const target = r.left - b.left + box.scrollLeft - (box.clientWidth - r.width) / 2;
        box.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
      }
      this.updateTabsEdge();
    },
    /* 切换分类/搜索后实体列表重刷 → 回到顶部 */
    resetDevListScroll() {
      const list = this.$refs.devListBox;
      if (list) list.scrollTop = 0;
    },

    /* ------- 初始化 ------- */
    async init() {
      await loadCatalog();   // 目录先于项目加载（示例户型需要按形态 id 引用家具）
      this.entVersion++;   // CATALOG 非响应式: 加载完成手动触发依赖它的计算属性（家具列表/页签）重算
      await this.loadProject();
      await PluginEngine.loadAll();   // 加载 assets/plugins 有状态模型插件
      this.entVersion++;   // 同理: 插件注册完成后再触发一次（背景分组/设备造型等）
      await this.$nextTick();

      Editor.init(document.getElementById('c2d'));
      Editor.onChange = (light, label) => { this.dirty(label || (light ? 'drag' : 'edit')); };
      Editor.onViewChange = () => this.viewDirty();   // 平移/缩放也进撤销栈（见 recode.js pushView）
      this.setFloor();
      if (typeof Recode !== 'undefined') Recode.setBaseView(Editor.viewState());   // 初始快照也记视图
      View3D.init('c3dWrap');
      View3D.frame({ dir: [9, 10, 11], dist: Math.hypot(9, 10, 11), target: [0, 0, 0] });   // 编辑器取景由 app 自己控制（= 原默认视角）
      this.applyBg();   // 恢复项目里保存的背景插件地面（空则默认纯色 + 网格）

      // 关闭页面前确保已保存
      window.addEventListener('beforeunload', () => {
        if (this.savedState !== '已保存' && this.project && navigator.sendBeacon) {
          /* 与手动保存 / autoSave 走同一份 serializeProject 快照：原始 this.project
           * 可能带着过期的 anchors 等运行期字段，整份提交会干扰服务端 disk 优先的合并。 */
          navigator.sendBeacon('/api/project',
            new Blob([JSON.stringify(serializeProject(this.project))], { type: 'application/json' }));
        }
      });

      await HA.loadConfig();
      this.inHaUrl = HA.url;
      this.inToken = HA.token;
      HA.on('change', () => this.onHAChange());
      HA.on('status', (s) => { this.haStatus = s; });
      HA.connect();

      View3D.startLoop();
      this.bindKeys();

      // 支持 ?view=3d 直达 3D 视图
      const q = new URLSearchParams(location.search);
      if (q.get('view') === '3d') this.setMode('3d');

      // 点画布关闭悬浮面板
      document.getElementById('c2d').addEventListener('mousedown', () => {
        if (this.tool === 'select') { this.furnOpen = false; this.devOpen = false; }
      });

      this.bootDone();   // 挂载完成，移除启动图
    },

    async loadProject() {
      this.project = await fetchProject() || buildDefaultProject();
      Recode.init(this.project, this.floorIdx);   // 撤销栈以载入的项目为初始态
      this.applyTitle();
      this.updateHouseSize();
    },

    /* 本层户型长宽（米）：2D 画布右上角徽标（跟随当前楼层，切层/改墙即刷新）。
     * studio 背景占位盒参考的是「各层最大尺寸」（保存时落盘 houseW/houseD），不再看这个徽标 */
    updateHouseSize() {
      const fp = (typeof floorFootprint === 'function') ? floorFootprint(this.cur) : null;
      this.houseW = fp ? Math.round(fp.w * 10) / 10 : 0;
      this.houseD = fp ? Math.round(fp.d * 10) / 10 : 0;
    },

    /* 浏览器标签页标题: 项目名称 · 编辑（名称改动/撤销重做后由 watch 同步） */
    applyTitle() { document.title = (this.project && this.project.name ? this.project.name : 'HA 3D Home') + ' · 编辑'; },

    async saveProject() {
      clearTimeout(this._saveTimer);
      const body = serializeProject(this.project);   // 自上而下重建，旧字段不入库
      if (!body) { this.toast('项目为空，无需保存'); return; }
      try {
        await fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        this.savedState = '已保存';
        this.toast('项目已保存');
      } catch (e) { this.toast('保存失败: ' + e.message); }
    },
    dirty(label) {
      // 快照式撤销: 每次数据改动压栈（restoring 期间的 dirty 来自恢复动作本身，不进栈）
      if (typeof Recode !== 'undefined') Recode.push(this.project, this.floorIdx, label || 'edit', Editor.viewState());
      this.histVer++;
      this.updateHouseSize();   // 墙体增删/拖动都会走到这里，长宽徽标实时跟着变
      this._save();
    },
    /* 视图改动（平移/缩放）单独压栈: 数据没变 → 不动保存状态、不用重算长宽。
     * 有了这条，「先平移视图、再改东西」后撤销时才不会把画面拽回平移前的取景 */
    viewDirty() {
      if (typeof Recode === 'undefined' || !this.project) return;
      if (Recode.pushView(this.project, this.floorIdx, Editor.viewState())) this.histVer++;   // 让撤销按钮可用态刷新
    },
    _save() {
      this.savedState = '未保存';
      // 自动保存: 编辑停止 1 秒后同步到服务器
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.autoSave(), 1000);
    },

    /* ------- 撤销 / 重做（快照式，见 js/recode.js） ------- */
    canUndo() { void this.histVer; return typeof Recode !== 'undefined' && Recode.canUndo(); },
    canRedo() { void this.histVer; return typeof Recode !== 'undefined' && Recode.canRedo(); },
    undo() {
      const s = Recode.undo();
      if (!s) return;
      this._applySnapshot(s);
      this.toast(s.undone === 'view' ? '已撤销视图（平移/缩放）' : '已撤销');
    },
    redo() {
      const s = Recode.redo();
      if (!s) return;
      this._applySnapshot(s);
      this.toast(s.undone === 'view' ? '已重做视图（平移/缩放）' : '已重做');
    },
    /* 恢复快照 + 全套联动刷新（restoring 抑制期间的 dirty 进栈） */
    _applySnapshot(s) {
      Recode.restoring = true;
      try {
        this.project = s.project;
        this.floorIdx = Math.min(Math.max(0, s.floorIdx), this.project.floors.length - 1);
        Editor.select(null);   // 选中对象可能已不在恢复后的数据里
        /* 楼层重指向但不重新 fit: 视图直接用快照里存的，撤销/重做时画面不跳 */
        this.setFloor(false);
        Editor.setView(s.view);   // 同步缩放标签（setView 内部回调 updateZoomLabel）
        this.applyBg();        // 背景插件地面（settings.background 属于快照）
        this.rebuild3D();      // 3D 模式下重建（2D 模式 no-op，进 3D 时 setMode 会再建）
        this.updateHouseSize(); // 快照里的墙体可能不同，长宽徽标同步
        this.histVer++;
        this._save();          // 恢复的结果也要落盘（刷新页面不回跳）
      } finally {
        Recode.restoring = false;
      }
    },
    async autoSave() {
      if (!this.project) return;
      const body = serializeProject(this.project);   // 与手动保存同一份干净快照
      if (!body) return;
      try {
        await fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        this.savedState = '已保存';
      } catch (e) { /* 下次编辑会重试 */ }
    },

    /* ------- 楼层 ------- */
    /* fit=false: 只重指向楼层 + 联动刷新，不用重新适配视野（撤销恢复走这条路，避免画面跳动） */
    setFloor(fit) {
      Editor.floor = this.cur;
      if (fit === false) Editor.render(); else Editor.fit();
      this.zoomPct = Math.round(Editor.ppm / 60 * 100);
      this.syncBg();
      this.updateHouseSize();
    },
    /* noView=true: 不记录切层这个「视图动作」（新建/删除楼层自己会压一条数据快照，
     * 再插一条视图快照会让撤销要按两次） */
    selectFloor(i, noView) {
      this.floorIdx = i;
      Editor.select(null);   // 切层清选中（App 与 Editor 两边由 select 内部同步）
      this.setFloor();
      if (!noView) this.viewDirty();   // 切层 = fit 重新取景，算一次视图变化（撤销能回到原来那层的取景）
      /* 切层必须让 3D 场景（含背景插件构图）一起换层：背景 group 是按当前楼层的
       * 房屋包围盒摆位的，只在 3D 模式 rebuild 会让「2D 下切层」时背景停留在上一层
       * 的落点，之后切回 3D 前房屋与平台就是错开的。切层是低频操作，隐藏容器里
       * 多建一次 3D 模型可以接受；进 3D 时 setMode 会再 resize + rebuild 一次。 */
      View3D.rebuild(this.project, i);
    },
    addFloor() {
      this.project.floors.push(newFloor((this.project.floors.length + 1) + '层'));
      this.selectFloor(this.project.floors.length - 1, true);
      this.dirty();
    },
    delFloor() {
      if (this.project.floors.length <= 1) return;
      this.project.floors.splice(this.floorIdx, 1);
      this.selectFloor(0, true);
      this.dirty();
    },
    setProjectName(v) { this.project.name = v.trim() || '我的家'; this.dirty(); },

    /* 墙面不透明度(%)：按楼层记忆，拖动实时刷新 3D */
    setWallOpacity(v) {
      const fl = this.cur;
      if (!fl) return;
      if (isNaN(v)) return;
      fl.wallOpacity = Math.min(100, Math.max(0, Math.round(v)));
      this.commit();
    },

    /* 层高(m)：实时预览。input（打字/点步进箭头）防抖 120ms 后重建 3D，change（失焦/回车）
     * 立即收口并钳制到 2~6。打字途中不钳制——0.5 会被 2~6 夹成 2 反写回输入框，打断输入。
     * 2D 平面不画层高，redraw2d 省掉；高度只影响 3D，由 commit 的 rebuild3D 刷新（wallH 在
     * View3D.build 里读 fl.height）。 */
    setFloorHeight(v, phase) {
      const fl = this.cur;
      if (!fl) return;
      const h = parseFloat(v);
      if (isNaN(h)) {
        if (phase === 'change') { fl.height = 2.8; this.commit({ redraw2d: false }); }   // 清空/乱输，失焦兜底回默认
        return;   // 输入中途（如「3.」）不更新，等下一个字符或失焦
      }
      clearTimeout(this._fhTimer);
      if (phase === 'change') {
        fl.height = Math.min(6, Math.max(2, h));
        this.commit({ redraw2d: false });
        return;
      }
      fl.height = h;
      this._fhTimer = setTimeout(() => this.commit({ redraw2d: false }), 120);
    },

    /* ------- 数据卡（按楼层独立，动态数量，实体搜索输入） ------- */
    setCard(i, v) {
      const cards = this.cur.display.dataCards = this.cur.display.dataCards || [];
      cards[i] = String(v || '').trim();
      this.dirty();
    },
    addCard() {
      const cards = this.cur.display.dataCards = this.cur.display.dataCards || [];
      cards.push('');
      this.dirty();
    },
    removeCard(i) {
      const cards = this.cur.display.dataCards || [];
      cards.splice(i, 1);
      this.dirty();
    },
    setWeather(v) { this.project.settings.weatherEntity = String(v || '').trim(); this.dirty(); },

    /* ------- 重置当前楼层 ------- */
    openResetFloor() { this.resetText = ''; this.resetOpen = true; },
    confirmResetFloor() {
      if (this.resetText.trim() !== '确认' || !this.cur) return;
      const fl = this.cur;
      fl.walls = []; fl.doors = []; fl.windows = []; fl.furniture = []; fl.devices = [];
      Editor.select(null);   // 清选中（App 与 Editor 两边同步）
      Editor.wallStart = null;
      Editor.ghost = null;
      this.resetOpen = false;
      this.commit();
      this.toast('已重置「' + fl.name + '」（自动保存）');
    },

    /* ------- 展示大屏展示项配置 ------- */
    openDispCfg() { this.dispOpen = true; },
    inList(arr, eid) { return Array.isArray(arr) && arr.includes(eid); },
    toggleList(key, eid) {
      const st = this.cur.display;
      const arr = st[key] = st[key] || [];
      const i = arr.indexOf(eid);
      if (i >= 0) arr.splice(i, 1); else arr.push(eid);
      this.dirty();
    },
    clearDispCfg() {
      this.cur.display.displayScenes = [];
      this.cur.display.quickDevices = [];
      this.dirty();
    },
    /* 快捷设备: 搜索添加 / 移除（楼层 display.quickDevices 存实体 id 数组） */
    quickIcon(eid) {
      const dom = String(eid || '').split('.')[0];
      return { light: '💡', switch: '🔌', fan: '🌀', cover: '🪟', climate: '❄️', media_player: '🎵', water_heater: '♨️', vacuum: '🤖', camera: '📯' }[dom] || '⚙️';
    },
    addQuickDevice() {
      const eid = String(this.quickInput || '').trim();
      if (!eid || !/^[a-z_]+\.[a-z0-9_]+$/i.test(eid)) { this.toast('请先在搜索框选择或输入完整实体 ID'); return; }
      const st = this.cur.display;
      const arr = st.quickDevices = st.quickDevices || [];
      if (arr.includes(eid)) { this.toast('该实体已在快捷设备中'); return; }
      arr.push(eid);
      this.quickInput = '';
      this.entVersion++;
      this.dirty();
      this.toast('已添加快捷设备 · ' + eid);
    },
    removeQuickDevice(eid) {
      const st = this.cur.display;
      const arr = st.quickDevices = st.quickDevices || [];
      const i = arr.indexOf(eid);
      if (i >= 0) arr.splice(i, 1);
      this.entVersion++;
      this.dirty();
    },
    /* ------- 左侧导航（统一状态机） -------
     * tool 是唯一激活源: select / pan / wall / door / window / furniture / device / bg / backdrop
     * 家具、设备、贴图、背景是"浮层工具"，再次点击同一按钮 → 收起并回到选择；
     * bg（贴图）态画布行为等同选择（Editor.isSelectTool 统一处理）；
     * 视图联动: 除背景（backdrop）外的所有工具强制 2D 编辑；背景反过来强制 3D（选完即所见）
     * keepView: 只收浮层/回到选择，不切换 2D/3D（浮层的 × 与 Esc 用） */
    setTool(t, keepView) {
      const togglable = ['furniture', 'device', 'bg', 'backdrop'];
      const next = (t === this.tool && togglable.includes(t)) ? 'select' : t;
      this.tool = next;
      Editor.tool = next;
      Editor.wallStart = null;
      if (next !== 'furniture' && next !== 'device') Editor.ghost = null;
      this.furnOpen = next === 'furniture';
      this.devOpen = next === 'device';
      this.bgOpen = next === 'bg';
      this.backdropOpen = next === 'backdrop';   // 左侧导航互斥：同一时刻只有一个是 active
      // 视图联动（两条互补规则）:
      //   · 背景（backdrop）→ 3D 展示：背景只在 3D 里看得见，选完即见即所得
      //   · 其余所有工具（选择/平移/墙体/门/窗/家具/设备/贴图）→ 2D 编辑
      // 例外: 再次点同一个浮层工具只是「收起浮层」（next 回到 select），或显式 keepView（× / Esc），
      //       此时不动视图，否则在 3D 里点背景收浮层会被拽回 2D
      const closingFlyout = next === 'select' && t !== 'select';
      if (!keepView && !closingFlyout) {
        if (next === 'backdrop') {
          if (this.mode === '2d') this.setMode('3d');
        } else if (this.mode === '3d') {
          this.setMode('2d');
        }
      }
      // 背景不是选择类工具（isSelectTool 不含 backdrop），选中对象时点背景面板不会自己变，
      // 这里显式清掉选中态 → 右侧统一切到「背景设置」面板（由 tool === 'backdrop' 驱动）
      if (next === 'backdrop' && this.selection) {
        Editor.select(null);
        Editor.render();
      }
    },
    pickFurniture(f) {
      this.ghostFurn = f.id;   // 形态标识（catalog.json items[].id）
      Editor.ghost = { kind: 'furniture', data: Object.assign({}, f) };
      Editor.tool = 'furniture';
      this.toast('在户型图上点击放置: ' + f.name);
    },

    /* ------- 背景（背景插件：统一返回 3D group，扁平或立体；静态或动态） ------- */
    applyBg() {
      if (!window.PluginEngine || !View3D.scene) return;
      this.bindBgSettings();
      /* 显式重放的三个前置动作（缺一个都会让背景与房屋错位）：
       * 1) init 时 View3D 还没 build 过，houseBounds() 返回 null，插件会按默认
       *    8×8 原点构图 —— 这里先把 project / house 对准当前楼层；
       * 2) 取消同层拖墙挂起的 160ms 重放，避免和本次显式重放并发双重建销 group；
       * 3) 成功后提交构图指纹，下一次 build 才不会误判「构图变了」再画一遍；
       *    失败不提交，留旧 key 让 build 自动重试。 */
      View3D.cancelBgReplay();
      View3D.ensureHouse(this.project, this.floorIdx);
      if (PluginEngine.applyBackground(this.bgStyle, View3D) === true) View3D.syncBgKey();
    },
    /* 把项目里的背景参数 / 实体绑定对象直接交给引擎（同一引用：面板改值 → 项目数据同步变 → 自动保存） */
    bindBgSettings() {
      if (!window.PluginEngine || !this.project) return;
      const s = this.project.settings || (this.project.settings = {});
      /* 老存档的实体绑定按样式存，这里就地合并成插件级一份（幂等），
       * 保证后续自动保存写进 data/project.json 的也是同一把 key。 */
      if (PluginEngine.migrateProjectBg) PluginEngine.migrateProjectBg(s);
      if (!s.backgroundOptions) s.backgroundOptions = {};
      if (!s.backgroundFields) s.backgroundFields = {};
      PluginEngine.bgOptions = s.backgroundOptions;
      PluginEngine.bgFields = s.backgroundFields;
      /* bgOptions / bgFields 是挂在引擎上的普通对象（非 Vue 响应式）。首次初始化时
       * 面板可能已经先算过一次空值并缓存，这里用 bgTick 让依赖它们的计算属性
       * （bgOptionList / bgFieldList）在引用接好之后重算一次，避免刷新后显示旧值。 */
      this.bgTick++;
    },
    /* 改背景参数: 只重绘地面（不重建户型），即时生效并自动保存。
     * 重绘做 90ms 防抖——自绘类背景（1024 贴图 + 撒点）不能让滑块的每个 input 都跑一遍 */
    setBgOpt(key, val) {
      if (!this.bgStyle || !window.PluginEngine) return;
      this.bindBgSettings();
      const store = PluginEngine.bgOptions;
      const cur = store[this.bgStyle] || (store[this.bgStyle] = {});
      cur[key] = val;
      this.bgTick++;
      clearTimeout(this._bgOptTimer);
      this._bgOptTimer = setTimeout(() => this.applyBg(), 90);
      this.dirty();
    },
    /* 改背景的实体绑定：绑定只影响数据，不重建几何，所以只推一次 onData。
     * 值存 settings.backgroundFields['<插件id>'][key] —— 该插件所有样式共用，
     * 切样式不会丢；换回未绑定时删掉该键。 */
    setBgField(key, val) {
      if (!this.bgStyle || !window.PluginEngine || !key) return;
      this.bindBgSettings();
      const store = PluginEngine.bgFields;
      const pk = PluginEngine.bgFieldKey(this.bgStyle);
      const cur = store[pk] || (store[pk] = {});
      const eid = String(val || '').trim();
      if (eid) cur[key] = eid; else delete cur[key];
      this.bgTick++;
      this.dirty();
      PluginEngine.notifyBackgroundData(true);
    },
    setBackground(b) {
      if (!this.project) return;
      if (!this.project.settings) this.project.settings = newSettings();
      this.project.settings.background = b ? b.id : '';
      this.applyBg();
      this.dirty();   // 自动保存到 data/project.json
      this.toast(b ? ('背景已切换: ' + b.name) : '已恢复默认背景（纯色 + 网格）');
    },
    pickEntity(e) {
      Editor.ghost = { kind: 'device', data: { entityId: e.eid, name: e.name, type: e.type } };
      Editor.tool = 'device';
      this.devOpen = false;
      this.toast('在户型图上点击放置: ' + e.name);
    },
    delSelected() { Editor.deleteSelection(); },
    locateDevice(p) {
      if (p.fi !== this.floorIdx) this.selectFloor(p.fi);
      Editor.select(p.d.kindName || 'device', p.d.id);
      Editor.fit();
      this.zoomPct = Math.round(Editor.ppm / 60 * 100);
      this.viewDirty();   // 定位后取景变了，记一条视图快照（撤销能回到定位前）
    },
    typeIcon(type) { return DEVICE_TYPES[type] ? DEVICE_TYPES[type].icon : '⚙️'; },
    /* 家具图标: 直接引用 catalog.js 的全局 furnIcon（图标数据在 catalog.json 的 icon 字段） */
    furnIcon(f, scale) { return window.furnIcon(f, scale); },

    /* ------- 视图 ------- */
    setMode(m) {
      this.mode = m;
      this.$nextTick(() => {
        if (m === '3d') {
          // 关键: 容器从 v-show 隐藏变为可见后先 resize 再 build
          View3D.resize();
          View3D.rebuild(this.project, this.floorIdx);
          View3D.setLabelsVisible(this.showLabels);   // 恢复顶栏开关状态
        } else {
          Editor.resize();
        }
      });
    },
    toggleLabels() {
      this.showLabels = !this.showLabels;
      View3D.setLabelsVisible(this.showLabels);
      this.toast(this.showLabels ? '已显示设备标签' : '已隐藏设备标签');
    },
    /* 旋转锚点重置回房屋中心（长按 3D 画面可自定义锚点；编辑页不持久化锚点） */
    resetAnchor() {
      View3D.resetAnchor();
      this.toast('锚点已重置回房屋中心');
    },
    openDisplay() { window.open('/display.html', '_blank'); },
    zoomStep(f) { Editor.setZoom(Editor.ppm * f); this.zoomPct = Math.round(Editor.ppm / 60 * 100); },
    zoomFit() { Editor.fit(); this.zoomPct = Math.round(Editor.ppm / 60 * 100); this.viewDirty(); },
    zoomCenter() { Editor.center(); this.viewDirty(); },
    updateZoomLabel(pct) { this.zoomPct = pct; },

    /* ------- 属性编辑 ------- */
    setSelection(sel) { this.selection = sel; },
    setProp(key, value, type) {
      const it = this.selItem;
      if (!it) return;
      let v = parseFloat(value);
      if (type === 'str') {
        const s = (value || '').trim();
        if (s) it[key] = s; else delete it[key];   // 清空 = 解绑，不留空串（插件侧统一按 falsy 判未绑定）
      }
      else { if (isNaN(v)) return; it[key] = type === 'deg' ? v * Math.PI / 180 : v; }
      this.commit({
        rebuild: type !== 'str',   // 数值修改实时刷新 3D 预览
        updateAll: true,           // 实体绑定等字段变化 → 插件即时响应
        syncLabels: true,          // 绑定字段变化 → 标签文案重算
      });
    },
    deg(rad) { return Math.round((rad || 0) * 180 / Math.PI); },

    /* ------- 同类模型/造型切换 ------- */
    /* 「2D 重绘 + 存档 + 3D 重建」统一出口（属性/造型/数值修改共 10 余处手抄收敛于此）。
     * opts.redraw2d           是否重绘 2D（默认 true；纯 3D 属性可关）
     * opts.rebuild            是否重建 3D（默认 true；rebuild3D 内部只在 3D 模式生效）
     * opts.updateAll          附带推送插件状态（扩展实体绑定等字段变化）
     * opts.syncLabels         附带重算标签文案（绑定字段变化） */
    commit(opts) {
      const o = opts || {};
      if (o.redraw2d !== false) Editor.changed();
      this.dirty();
      if (o.rebuild !== false) this.rebuild3D();
      if (o.updateAll && window.PluginEngine) PluginEngine.updateAll();
      if (o.syncLabels && this.mode === '3d') View3D.syncLabels(this.project);
    },
    rebuild3D() {
      if (this.mode !== '3d') return;
      View3D.rebuild(this.project, this.floorIdx);
    },
    /* 家具: 切换为同类别的另一个模型（保留位置/旋转）。实例只存 mid，
     * 尺寸/名称/模型随目录形态解析，所以这里把旧数据抄在实例上的字段一并清掉 */
    swapFurnModel(f) {
      const it = this.selItem;
      if (!it || !f) return;
      it.mid = f.id;   // 形态标识（type/name/尺寸/颜色/模型等由目录解析）
      ['type', 'name', 'w', 'd', 'h', 'color', 'model'].forEach((k) => { if (k in it) delete it[k]; });
      this.commit();
      this.toast('已切换为: ' + f.name);
    },
    /* 点击控制开关（设备级覆盖插件默认） */
    setDevClick(v) {
      const it = this.selItem;
      if (!it) return;
      it.click = !!v;
      this.commit({ redraw2d: false });   // 标签可点击状态随重建刷新
      this.toast(it.click ? '点击控制已启用' : '点击控制已关闭');
    },
    /* 「点击动作」下拉（实例级覆盖，优先级最高）: 选择后整体替换插件 click / 内置默认；
     * 选回「默认」即清空回到插件/内置链路。选中动作时自动勾选启用（否则点了也不生效） */
    setDevClickSvc(key) {
      const it = this.selItem;
      if (!it) return;
      if (key) {
        it.clickSvc = key;
        if (it.click !== false) it.click = true;
        this.toast('点击动作已覆盖: ' + key);
      } else {
        delete it.clickSvc;
        this.toast('点击动作已恢复默认（插件 / 内置）');
      }
      this.commit({ redraw2d: false });
    },
    /* 切换样式: 只存 obj.style（形如 'plugin:style'）；设备首次切换带出该造型的默认离地高度。
     * 只改 style / z，不动实例上的 fields 绑定值 —— 同一插件多个样式共用绑定（与背景同口径）。 */
    setSelStyle(s) {
      const it = this.selItem;
      if (!it || !s || it.style === s.id) return;
      it.style = s.id;
      if (this.selection.kind === 'device' && it.z == null) it.z = s.z;
      this.commit();   // 2D 平面简笔立即重绘（changed 顺带触发自动保存）
      this.toast('样式已切换: ' + s.name);
    },
    /* 样式条目参数（如门的手向/开向）: 值按实例存 obj.styleOpts，整对象替换保证 Vue2 响应；
     * 120ms 防抖后 commit（2D 符号 + 3D 模型一起重画，滑杆拖动不会每次 input 都重建） */
    setSelOpt(key, val) {
      const it = this.selItem;
      if (!it) return;
      const cur = Object.assign({}, it.styleOpts);
      cur[key] = val;
      it.styleOpts = cur;
      clearTimeout(this._openOptTimer);
      this._openOptTimer = setTimeout(() => this.commit(), 120);
    },
    /* 扩展实体绑定的当前读数（面板里直接显示，确认绑对了没有）
     * 返回 { text, on } —— text 为空表示未绑定，'未找到' 表示实体不存在 */
    devFieldVal(key) {
      void this.entVersion;   // 依赖实体状态版本: HA 推送后自动重算
      const it = this.selItem;
      const eid = it && it[key];
      if (!eid) return '';
      const st = HA.getState(eid);
      if (!st) return '未找到';
      return st.state + HA.unitOf(st);
    },
    clearDevField(key) {
      const it = this.selItem;
      if (!it || !it[key]) return;
      this.setProp(key, '', 'str');
      this.toast('已解绑');
    },
    /* ------- 数值编辑（设备/门窗/家具共用底座） -------
     * applyNum: 解析 + 可选角度换算/夹取 + commit（原 setDevNum/setOpenNum/setFurnNum 三胞胎收敛于此）
     * wheelStep: 滚轮步进（deltaY 向上 = 增）后走 applyNum（原 wheelNum/wheelOpen/wheelFurn 收敛于此）
     * opts: { deg: 按°输入换算弧度, min/max: 夹取, int: 取整, redraw2d: 是否重绘 2D } */
    applyNum(key, value, opts) {
      const it = this.selItem;
      if (!it) return;
      const o = opts || {};
      const v = parseFloat(value);
      if (isNaN(v)) return;
      let n = o.deg ? v * Math.PI / 180 : v;
      if (o.int) n = Math.round(n);
      if (o.min != null) n = Math.max(o.min, n);
      if (o.max != null) n = Math.min(o.max, n);
      it[key] = n;
      this.commit({ redraw2d: o.redraw2d !== false });
    },
    wheelStep(key, e, step, opts) {
      const it = this.selItem;
      if (!it) return;
      const o = opts || {};
      const cur = o.deg ? this.deg(it[key]) : (parseFloat(it[key]) || 0);
      let v = cur + (e.deltaY < 0 ? step : -step);
      if (!o.deg) v = Math.round(v * 1000) / 1000;   // 浮点步进不留 0.30000000000000004 这类尾巴
      this.applyNum(key, String(v), o);
    },
    /* 设备数值: x/y/rot 重绘 2D（redraw2d=true），z 不重绘（贴地属性由 3D 决定） */
    setDevNum(key, value, redraw2d) {
      this.applyNum(key, value, { min: key === 'z' ? 0 : null, redraw2d: !!redraw2d });
    },
    wheelNum(key, e, step, redraw2d, min, max) {
      this.wheelStep(key, e, step, {
        redraw2d: !!redraw2d,
        min: min != null ? min : (key === 'z' ? 0 : null),
        max: max != null ? max : null,
      });
    },
    /* 标签抬升高度（m）: 实例覆盖造型声明值，只动 HTML 标签位置、不重建 3D ——
     * View3D.updateLabels 每帧读 obj.labelOffset，改完下一帧就到位。
     * 拖滑条时 200ms 防抖再 dirty（快照/自动保存），避免每一档都压一条撤销栈 */
    setDevLabelOffset(value) {
      const it = this.selItem;
      if (!it) return;
      if (String(value).trim() === '') return;                // 正在清空：等 @change 再决定
      const v = parseFloat(value);
      if (isNaN(v)) return;
      it.labelOffset = Math.round(Math.max(-1, Math.min(6, v)) * 100) / 100;
      clearTimeout(this._labelOffTimer);
      this._labelOffTimer = setTimeout(() => this.dirty(), 200);
    },
    /* 输入框失焦/回车：清空 = 删掉实例覆盖，回到造型声明的 labelOffset */
    commitDevLabelOffset(value) {
      if (String(value).trim() === '') this.clearDevLabelOffset();
      else this.setDevLabelOffset(value);
    },
    clearDevLabelOffset() {
      const it = this.selItem;
      if (!it || it.labelOffset == null) return;
      delete it.labelOffset;
      clearTimeout(this._labelOffTimer);
      this._labelOffTimer = setTimeout(() => this.dirty(), 200);
    },
    wheelDevLabelOffset(e, step) {
      const cur = parseFloat(this.labelOffsetVal) || 0;
      this.setDevLabelOffset(cur + (e.deltaY < 0 ? step : -step));
    },
    /* 门窗数值: 宽度（最小 0.05m）/角度，实时刷新 2D + 3D */
    setOpenNum(key, value, type) {
      this.applyNum(key, value, { deg: type === 'deg', min: type === 'deg' ? null : 0.05 });
    },
    /* 窗离地高度: 0 起步（门恒 0 不可调，面板不渲染输入框） */
    setOpenZ(value) { this.applyNum('z', value, { min: 0 }); },
    wheelOpenZ(e, step) { this.wheelStep('z', e, step, { min: 0 }); },
    wheelOpen(key, e, step, type) {
      this.wheelStep(key, e, step, { deg: type === 'deg', min: type === 'deg' ? null : 0.05 });
    },
    /* 家具数值: 旋转/位置/离地高度/整体比例（20–300 取整），实时刷新 2D + 3D */
    setFurnNum(key, value, type) {
      this.applyNum(key, value, {
        deg: type === 'deg',
        min: key === 'z' ? 0 : (key === 'pct' ? 20 : null),
        max: key === 'pct' ? 300 : null,
        int: key === 'pct',
      });
    },
    wheelFurn(key, e, step) {
      if (key === 'rot') return this.wheelStep(key, e, step, { deg: true });
      this.wheelStep(key, e, step, {
        min: key === 'z' ? 0 : (key === 'pct' ? 20 : null),
        max: key === 'pct' ? 300 : null,
        int: key === 'pct',
      });
    },
    /* 设备造型图标（由插件 styles[].icon 提供，缺省 ⚙️） */
    devStyleIcon(s) { return window.devStyleIcon(s); },

    /* ------- 参考底图（2D 户型图：全项目共用一张 —— 服务器端只存 data/refimg.* 一张图，
     *          画完户型图基本就弃用，没必要按楼层各存一份；经 /api/refimg 读取，
     *          src 带 ?t= 时间戳防缓存，重复上传不用刷新页面即可看到新图） ------- */
    pickBackground() {
      // 打开系统文件选择框时保持贴图浮层可见（浏览器文件对话框不会触发页面事件）
      if (this.$refs.bgFile) this.$refs.bgFile.click();
    },
    onBgFile(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const rd = new FileReader();
      rd.onload = async () => {
        this.toast('贴图上传中…');
        try {
          const r = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name, data: rd.result }),
          });
          const j = await r.json();
          if (!r.ok || !j.url) throw new Error(j.error || ('HTTP ' + r.status));
          this.applyBgImage(j.url, file.name);
          this.toast('参考底图已上传（全项目共用，重复上传自动覆盖）');
        } catch (err) {
          this.toast('上传失败: ' + err.message);
        }
      };
      rd.readAsDataURL(file);
    },
    /* 加载贴图并写入项目（bgImage 挂在 project 上：全楼层共用一张）。
     * src 追加 ?t= 时间戳：同一会话里重复上传时 URL 变化，浏览器不命中旧缓存 */
    applyBgImage(src, name) {
      if (src.startsWith('/api/refimg')) {
        src = src + (src.includes('?') ? '&' : '?') + 't=' + Date.now();
      }
      const img = new Image();
      img.onload = () => {
        const meta = { src, name: name || '贴图', x: 0, y: 0, w: 10, opacity: 0.35, hidden: false };
        Editor.backgroundImage = Object.assign({ img }, meta);
        this.bgW = 10;
        this.bgInfo = { has: true, hidden: false };
        if (this.project) this.project.bgImage = meta;
        Editor.render();
        this.dirty();
      };
      img.onerror = () => this.toast('图片加载失败');
      img.src = src;
    },
    /* 把编辑器中的贴图状态写回项目并标记保存 */
    writeBg() {
      const bg = Editor.backgroundImage;
      if (!this.project || !bg || !bg.src) return;
      this.project.bgImage = {
        src: bg.src, name: bg.name || '贴图',
        x: bg.x, y: bg.y, w: bg.w,
        opacity: bg.opacity == null ? 0.35 : bg.opacity,
        hidden: !!bg.hidden,
      };
      this.dirty();
    },
    /* 楼层切换/载入时恢复贴图（项目级共用，切层不换图） */
    syncBg() {
      const b = this.project && this.project.bgImage;
      const cur = Editor.backgroundImage;
      if (!b || !b.src) {
        if (cur && cur.src) { Editor.backgroundImage = null; this.bgInfo = { has: false, hidden: false }; Editor.render(); }
        return;
      }
      if (cur && cur.src === b.src) {
        Object.assign(cur, { x: b.x, y: b.y, w: b.w, opacity: b.opacity, hidden: !!b.hidden });
        this.bgW = b.w || 10;
        this.bgInfo = { has: true, hidden: !!b.hidden };
        Editor.render();
        return;
      }
      const img = new Image();
      img.onload = () => {
        // 载入期间项目可能已被撤销/重做替换
        if (!this.project || !this.project.bgImage || this.project.bgImage.src !== b.src) return;
        Editor.backgroundImage = Object.assign({}, this.project.bgImage, { img });
        this.bgW = this.project.bgImage.w || 10;
        this.bgInfo = { has: true, hidden: !!this.project.bgImage.hidden };
        Editor.render();
      };
      img.src = b.src;
    },
    toggleBg() {
      const bg = Editor.backgroundImage;
      if (!bg || !bg.img) return;
      bg.hidden = !bg.hidden;
      this.bgInfo = { has: true, hidden: !!bg.hidden };
      this.writeBg();
      Editor.render();
    },
    onBgScale(e) {
      const bg = Editor.backgroundImage;
      if (!bg || !bg.img) return;
      const nw = parseFloat(e.target.value) || 10;
      // 缩放锚点 = 图片中心：调整左上角位置使中心保持不动
      const ratio = bg.img.height / bg.img.width;
      bg.x += (bg.w - nw) / 2;
      bg.y += (bg.w - nw) * ratio / 2;
      bg.w = nw;
      this.bgW = nw;
      this.writeBg();
      Editor.render();
    },
    clearBg() {
      Editor.backgroundImage = null;
      this.bgInfo = { has: false, hidden: false };
      // 保持贴图浮层打开，方便紧接着重新上传
      if (this.project && this.project.bgImage) { this.project.bgImage = null; this.dirty(); }
      Editor.render();
    },

    /* ------- 连接 ------- */
    openConn() {
      this.connOpen = true;
      this.inHaUrl = HA.url;
      this.inToken = HA.token;
      this.connMsg = '';
    },
    async saveConn() {
      this.connMsg = '保存中…'; this.connMsgOk = true;
      try {
        const r = await HA.saveConfig(this.inHaUrl, this.inToken);
        if (r.test && r.test.ok) { this.connMsg = '已保存 · HA 连接成功 (v' + (r.test.version || '?') + ')'; this.connMsgOk = true; }
        else if (r.test && !r.test.ok) { this.connMsg = '已保存，但测试失败: ' + r.test.error; this.connMsgOk = false; }
        else { this.connMsg = '已保存'; this.connMsgOk = true; }
        HA.connect();
      } catch (e) { this.connMsg = '保存失败: ' + e.message; this.connMsgOk = false; }
    },
    async testConn() {
      this.connMsg = '测试中…'; this.connMsgOk = true;
      try {
        const j = await (await fetch('/api/config/test', { method: 'POST' })).json();
        if (j.ok) { this.connMsg = '连接成功 · HA v' + j.version + ' · ' + (j.location_name || ''); this.connMsgOk = true; }
        else { this.connMsg = '失败: ' + j.error; this.connMsgOk = false; }
      } catch (e) { this.connMsg = '失败: ' + e.message; this.connMsgOk = false; }
    },

    /* ------- 导入插件 -------
     * 拖拽 / 点选一个 zip → 原样 POST 给服务端（/api/plugins/import）：
     * 服务端解压到临时目录、读 plugin.json 拿插件 id、再整体放进 custom/plugins/<id>/
     * （同 id 覆盖升级）；成功后刷新页面，插件引擎重新拉清单并加载。 */
    openImport() {
      this.importOpen = true;
      this.importDrag = false;
      this.importing = false;
      this.importFile = null;
      this.importMsg = '';
      this.importMsgOk = true;
      this.loadInstallKey();
    },
    /* 读安装密钥状态：只有末 4 位 + 是否被环境变量锁定（明文不走这条接口） */
    async loadInstallKey() {
      try {
        const d = await (await fetch('/api/install/config')).json();
        this.keyTail = d.keyTail || '';
        this.keyLocked = !!d.locked;
      } catch (e) { /* 读不到就保持原样 */ }
    },
    /* 生成新密钥（旧密钥立即失效）。明文只出现在这次响应里，直接显示在弹窗中供复制。 */
    async genInstallKey() {
      if (this.keyBusy) return;
      if (this.keyValue && !confirm('重新生成会让 studio 里已填的旧密钥立即失效，继续？')) return;
      this.keyBusy = true;
      this.keyCopied = false;
      try {
        const r = await fetch('/api/install/config/generate', { method: 'POST' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.key) throw new Error(d.error || ('HTTP ' + r.status));
        this.keyValue = d.key;
        this.keyTail = d.keyTail || d.key.slice(-4);
        this.importMsg = '已生成新密钥，复制后填到 studio 的「设置 → 密钥」里';
        this.importMsgOk = true;
      } catch (e) {
        this.importMsg = '生成失败: ' + e.message;
        this.importMsgOk = false;
      } finally { this.keyBusy = false; }
    },
    async copyInstallKey() {
      if (!this.keyValue) return;
      try {
        await navigator.clipboard.writeText(this.keyValue);
      } catch (e) {
        /* 非 https / 剪贴板权限被拒时的兜底：临时 textarea + execCommand */
        const ta = document.createElement('textarea');
        ta.value = this.keyValue; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
        document.body.removeChild(ta);
      }
      this.keyCopied = true;
      setTimeout(() => { this.keyCopied = false; }, 1600);
    },
    closeImport() { if (!this.importing) this.importOpen = false; },
    pickPluginFile() { if (!this.importing && this.$refs.impFile) this.$refs.impFile.click(); },
    onPluginPick(e) {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';                 // 清掉选择，允许再次选同一个文件
      if (f) this.importPluginZip(f);
    },
    onPluginDrop(e) {
      this.importDrag = false;
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.importPluginZip(f);
    },
    async importPluginZip(file) {
      if (this.importing) return;
      if (!/\.zip$/i.test(String(file.name || ''))) {
        this.importMsg = '请选择 .zip 插件包'; this.importMsgOk = false; return;
      }
      this.importing = true;
      this.importFile = file;
      this.importMsg = '';
      this.importMsgOk = true;
      try {
        const buf = await file.arrayBuffer();
        const r = await fetch('/api/plugins/import', {
          method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: buf,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
        /* 家具包（kind: catalog）自带件数/包名，提示按类分开写，免得「已导入插件」误导 */
        if (d.kind === 'catalog') {
          this.importMsg = (d.upgraded ? '已升级家具包 ' : '已导入家具包 ')
            + (d.name || d.id) + '（' + (d.count || 0) + ' 件家具）'
            + (d.version ? ' v' + d.version : '') + '，正在刷新…';
        } else {
          this.importMsg = (d.upgraded ? '已升级插件 ' : '已导入插件 ') + d.id
            + (d.version ? ' v' + d.version : '') + '，正在刷新…';
        }
        this.importMsgOk = true;
        setTimeout(() => location.reload(), 900);      // 刷新后 /api/plugins 重新拉取并加载
      } catch (err) {
        this.importMsg = '导入失败: ' + err.message;
        this.importMsgOk = false;
        this.importing = false;
        this.importFile = null;
      }
    },

    /* ------- HA 事件 ------- */
    onHAChange() {
      this.entVersion++;
      if (this.mode === '3d') View3D.refresh();
      else Editor.render();
    },

    /* ------- 提示 ------- */
    toast(msg) {
      this.tooltipMsg = msg;
      this.tooltipShow = true;
      this.tooltipStyle = { left: '50%', top: '60px', transform: 'translateX(-50%)' };
      clearTimeout(this._tt);
      this._tt = setTimeout(() => { this.tooltipShow = false; this.tooltipStyle = {}; }, 2200);
    },

    bindKeys() {
      window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        const map = { v: 'select', h: 'pan', w: 'wall', d: 'door', n: 'window', f: 'furniture', e: 'device', b: 'bg', g: 'backdrop' };
        const k = e.key.toLowerCase();
        /* 撤销/重做: Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z（或 Ctrl+Y）；输入框聚焦时 bindKeys 顶部已跳过 */
        const mod = e.ctrlKey || e.metaKey;
        if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
        if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
        if (map[k] && this.mode === '2d') this.setTool(map[k]);
        if ((e.key === 'Delete' || e.key === 'Backspace') && this.mode === '2d') Editor.deleteSelection();
        /* Esc 统一收起: 取消绘制 + 收浮层 + 清选中 → 右侧无论从属性面板还是背景面板进来，
         * 都回到「楼层设置」；'none' 是故意不存在的工具值 —— 不点亮任何左侧按钮
         * （落到 editor 的 select default 分支，画布点击选中仍可用），也不默认切回「选择」 */
        if (e.key === 'Escape') { Editor.wallStart = null; Editor.ghost = null; Editor.select(null); Editor.render(); this.setTool('none', true); }
      });
    },

    /* 启动图移除（原 window.__bootDone）：挂载完成后调用，12s 兜底在 mounted 里 */
    bootDone() {
      const b = document.getElementById('boot');
      if (!b) return;
      b.style.opacity = '0';
      b.style.pointerEvents = 'none';
      setTimeout(() => { b.remove(); }, 260);
    },
  },

  watch: {
    /* 项目名称变化（手动改名 / 撤销重做恢复）→ 标签页标题同步 */
    'project.name'() { if (this.project) this.applyTitle(); },
    /* 分类页签（单行滚动）: 选中项滚进可视区 + 两端渐隐提示同步 + 列表回顶部 */
    devFilter() {
      this.$nextTick(() => {
        this.scrollTabsToActive();
        this.resetDevListScroll();
      });
    },
    devTabs() { this.$nextTick(() => { this.scrollTabsToActive(); this.updateTabsEdge(); }); },
    devOpen(v) { if (v) this.$nextTick(() => { this.scrollTabsToActive(); this.updateTabsEdge(); }); },
    /* 搜索词变化列表重刷，同样回顶部 */
    devSearch() { this.$nextTick(() => this.resetDevListScroll()); },
  },

  mounted() {
    // 12s 兜底：脚本异常导致 init() 未走到 bootDone 时，强制移除启动图，避免卡死
    setTimeout(() => this.bootDone(), 12000);
    this.init();
  },
};
</script>

<style>
/* 启动图：覆盖 JS/CSS 未加载完成时可能闪现的 Vue 模板字符串；样式内联不依赖外部资源 */
#boot { position: fixed; inset: 0; z-index: 9999; background: #f4f6fa; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; transition: opacity .25s; font-family: system-ui, sans-serif; }
#boot .b-logo { font-size: 46px; filter: drop-shadow(0 4px 10px rgba(60,80,120,.18)); }
#boot .b-name { font-size: 17px; font-weight: 700; color: #1f2733; letter-spacing: 1px; }
#boot .b-spin { width: 30px; height: 30px; border: 3px solid #d7deea; border-top-color: #3b82f6; border-radius: 50%; animation: b-rot .8s linear infinite; }
#boot .b-tip { font-size: 12px; color: #8a94a6; }
@keyframes b-rot { to { transform: rotate(360deg); } }
/* 编辑页版本号：固定在页面左下角（左侧工具栏底部），2D/3D 模式都常驻。
   只用定位修饰 .tb-ver-corner，基础胶囊样式仍在 style.css，大屏页标题旁的版本号不受影响。 */
.tb-ver-corner { position: fixed; left: 10px; bottom: 10px; z-index: 25; }
</style>
