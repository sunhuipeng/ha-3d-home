/*
 * door — 门插件（type:'door' 的贴墙设备；与灯/开关等设备同一套插件契约）
 *
 * ============================================================================
 * 这份注释是「插件开发」的权威手册 —— 写新插件时照这份抄。
 * 其余插件头部的「参数速查」都是它的精简版；背景插件的权威手册在
 * assets/plugins/background/plugin.js 头部（kind: 'background' 专属的那一套）。
 * ============================================================================
 *
 * 〇、一个插件目录里有什么
 * ============================================================================
 *   assets/plugins/<目录>/          内置插件，随项目升级
 *   custom/plugins/<目录>/          自定义插件，同名目录覆盖内置，升级不丢
 *   ├─ plugin.json   清单：服务端 /api/plugins 扫它决定「加载不加载、用什么版本号加载」
 *   ├─ plugin.js     本文件：顶层调用一次 PluginEngine.register({...})
 *   └─ models/*.glb  可选，插件自带模型，插件里用 ctx.glb('models/x.glb') 读
 *
 *   plugin.json 字段：
 *     id           插件唯一 id，建议与目录名一致
 *     name         插件显示名（背景插件的面板分组标题）
 *     version      插件版本号。⚠ 它被拼进加载 URL（plugin.js?v=1.2.3），而服务端对带 ?v= 的
 *                  资源一律「immutable 缓存一年」—— 所以改了 plugin.js 就必须升 version，
 *                  否则浏览器永远拿缓存里的旧文件（只改注释也一样看不到新文件）
 *     kind         只有 'background' 有意义（背景插件）；模型插件写 'device' 或省略（与 register 一致，供人工阅读）
 *     type         可选，写清类型键，便于阅读（真正生效的是 register 里的 type）
 *     description  可选，一句话说明，出现在插件列表/文档里
 *     entry        可选，自定义入口脚本路径（默认 <目录>/plugin.js，一般不用写）
 *
 *   覆盖规则：目录名重复时 custom 覆盖 assets（服务端按目录名去重，custom 后扫）；
 *            id 重复时后 register 的那份替换先前的（同一 id 只保留一份定义）。
 *
 * ============================================================================
 * 一、register({...}) 顶层字段
 * ============================================================================
 *   id        必填，插件 id，建议与目录名一致
 *   kind      模型插件可省略或写 'device'；只有 'background'（房屋外围地面）有特殊含义
 *   type      必填（background 除外），类型键 —— 门/窗与设备已合并为同一插件类，type 一视同仁：
 *               HA 实体类型：light / switch / fan / cover / climate / sensor /
 *               camera / media_player / vacuum / water_heater …
 *               贴墙类型：'door' | 'window'（由编辑器放到墙上、墙体掏洞，其余能力与设备相同）
 *               同 type 的多个插件，styles 会合并进同一个样式下拉
 *               （本插件 door + custom/plugins/door_rolling 就是例子）
 *               漏写不报错，但造型聚合不到面板（控制台会 warn）
 *   name      必填，显示名（属性面板标题、插件列表用）
 *   styles    造型列表，见第二节。决定「有哪些外观可选」；背景类必填，每项一个地面
 *   fields    扩展实体绑定字段，见第三节（可选）
 *   click     点击控制（只描述"点下去发什么"），见第四节（可选；设备有内置默认，门/窗未声明即不可点）
 *   stateText 标题标签文案，见第五节（可选）
 *   plan2d    2D 平面符号，见第六节（可选）
 *   isOn      开/合判定的**唯一入口**（可组合多实体），见第六节（可选；引擎入口 PluginEngine.isOnOf）
 *   labels    可选，是否显示 3D 状态标签。设备缺省 true；门/窗缺省 false（要显示显式传 true）
 *   z         可选，锚点离地高度缺省（门/窗贴地声明 0；设备缺省走目录造型 z，再兜底 1.2）
 *   hitY      可选，锚点热球球心高度（保底拾取热区；窗 1.4 / 门 1.1，缺省 0 = 锚点处）
 *   labelOffset  可选，标签相对锚点的抬升缺省（door 1.05 / window 1.45，设备缺省 0.3）
 *   labelBaseY   可选，3D 标签锚点基准高度（门/窗 = 模型中部；不声明则回退锚点高度 devY）
 *   defaultW     可选，编辑器放置缺省宽度（door 0.9 / window 1.2）
 *   placeholder  可选，无插件/创建失败时的占位薄板 { w, h, color, y }（y 缺省 h/2）
 *   model3d   3D 模型工厂，见第七节（模型类必填）
 *   apply     背景工厂，见第八节（仅 background，与 model3d 二选一）
 *   refresh   背景刷新率 Hz，见第八节（仅 background，通常写在 styles 条目上）
 *   base      可选，资源基准目录（默认自动取 plugin.js 所在目录，一般不用写）
 *
 * ============================================================================
 * 二、styles[] —— 造型（面板里可切换的外观）
 * ============================================================================
 *   {
 *     id: 'single',                   // 必填，本插件内唯一。引擎聚合时加前缀
 *                                     //   → 面板/数据里是 'door:single'
 *                                     //   → 插件里拿到的 ctx.style.id 仍是 'single'
 *     name: '单开门',                  // 必填，面板按钮文案
 *     desc: '一扇门，可设手向与开向',    // 可选，按钮下方的说明小字
 *     icon: ico('<path …/>'),         // 可选，按钮图标（24×24 线性 SVG，也可直接给 emoji）
 *                                     //   不写 = 引擎用 ⚙️ 兜底
 *     z: 2.25,                        // 设备专用：锚点离地高度（米）
 *                                     //   缺省时编辑器按 1.2m 兜底
 *                                     //   门不写（恒 0，贴地不可调）；窗可选（在窗台高度基础上
 *                                     //   整体抬升，缺省 0，属性面板可调）
 *     labelOffset: 1.75,              // 可选：标题标签在锚点之上再抬多少米（缺省 0.3）
 *     model: 'models/x.glb',          // 可选：本造型的默认 GLB（相对插件目录，怎么用由插件定）
 *     options: [ … ]                  // 可选：样式参数 schema，见下
 *   }
 *
 *   —— 样式参数（options）：同一种造型的差异项 ——
 *   例：「单开门」再分左/右开门、内/外开，一个样式覆盖四种画法：
 *     options: [
 *       { key: 'hand', label: '手向', type: 'select', def: 'left',
 *         choices: [{ value: 'left', label: '左开门' }, { value: 'right', label: '右开门' }] },
 *       { key: 'open', label: '开向', type: 'select', def: 'in',
 *         choices: [{ value: 'in', label: '内开' }, { value: 'out', label: '外开' }] },
 *     ]
 *   控件类型（type；与背景参数同一套 schema，面板渲染共用一份代码）：
 *     'range'  滑块 + 数字框，要 min / max / step
 *     'number' 数字输入框，可选 step
 *     'select' 下拉，要 choices: [{ value, label }]
 *     'checkbox' 复选框（勾选框右边的文字取 tip）
 *     'text'   普通文本框（不写 type 或写别的值都按它渲染）
 *     每项都建议写 def（默认值）；没写 def 且用户没改过时值是 undefined。
 *   读取：面板改一次 → 存进实例 obj.styleOpts = { hand:'right', open:'in' }
 *         插件读 ctx.options.hand（3D）/ p.options.hand（2D）
 *         —— 已经是「条目默认值 ∪ 实例已存值」合并好的结果，缺省值不用自己兜
 *   注意：同造型的不同实例各存各的取值（A 门左开、B 门右开互不影响）。
 *
 * ============================================================================
 * 三、fields[] —— 扩展实体绑定（通用，可选）
 * ============================================================================
 *   一个模型（设备/门/窗）除了主实体，常常还挂着别的实体（插座功率、空调湿度、音箱曲目、
 *   门磁之外的门开度…）。声明在这里，属性面板就会渲染出「实体绑定」区：
 *     { key: 'posEntityId',        // 必填，数据键名 → 绑定值存 obj[key]
 *       label: '开度实体',          // 必填，界面上的字段名
 *       domains: ['sensor'],       // 可选，只在这些 HA 域里搜（不给 = 全部）
 *       placeholder: 'sensor.xxx', // 可选，输入框占位文案
 *       tip: '0~100 表示开度' }     // 可选，字段下方的一行说明
 *   约定：
 *     · 设备的主实体走「设备绑定」，不要重复写进 fields
 *     · 门/窗没有那条入口（一个门洞绑一个主实体），门磁/开度实体就写在 fields 里
 *       （key 习惯叫 entityId / posEntityId；obj.entityId 是判定链认的主实体键）
 *     · 绑定之后这些实体会被纳入监听：任意一个状态变化都会触发你的 update()
 *     · 读取用 ctx.field / fieldState / fieldOn / fieldNum / fieldText，
 *       未绑定时返回 null / ''，插件不用自己判空
 *     · 允许出现引擎不认识的附加字段（如 studio 生成的 valueType / enumValues）：
 *       引擎不读、原样透传，照抄 schema 时保留即可，不要删
 *
 * ============================================================================
 * 四、click —— 点击控制（可选）
 * ============================================================================
 *   click: {
 *     on:  'turn_on',                    // 当前「没开」时发这个服务
 *     off: 'turn_off',                   // 当前「已开」时发这个
 *     // 需要别的域或明确服务名时写成对象：{ domain: 'media_player', service: 'media_play' }
 *     label: '开 / 关',                   // 可选：属性面板勾选文案（默认 '开 / 关'）
 *     defaultOn: true,                   // 可选：默认是否响应点击（默认 true）
 *     feedback: false,                   // 可选：动作没有可见变化时弹一条提示（如「刷新读数」）
 *   }
 *   规则：
 *     · 设备不写 click → 按 type 取内置默认：light / switch / fan / cover = toggle；
 *       water_heater / climate = turn_on + turn_off；其它 type（sensor / vacuum /
 *       camera / speaker …）= 不可点击
 *     · 门/窗（type:'door'/'window'）没有内置默认 —— 不写 click 即不可点（门磁是只读实体，
 *       点门没意义；车库门卷帘这类可遥控的才声明，如 open_cover/close_cover）。
 *       服务域未显式声明时按主实体的域发（cover.garage → cover）
 *     · click 里**不再有 isOn**：「当前算不算开着」由顶层 isOn(obj, get) 判定（见第六节），
 *       点击方向、2D 底色、3D 高亮、统计全走同一个函数，不会出现两套结论
 *     · 属性面板「点击控制」的勾选存到 obj.click（true/false），未设置时跟随 defaultOn
 *
 * ============================================================================
 * 五、stateText(st, obj, get) —— 标题标签上的一行文案（可选）
 * ============================================================================
 *   参数：
 *     st   主实体状态对象 { entity_id, state, attributes, last_changed }（没有实体时调用方不调）
 *     obj  本实例数据（门窗/设备），扩展实体绑定字段都挂在上面
 *     get  (entityId) => 状态对象 | undefined，读任意/扩展实体用
 *          刻意「按参数注入」而不是让插件直接用全局 HA：将来换数据源或写测试只换这个函数
 *   返回：
 *     非空字符串 → 原样显示（可自带单位/百分比/图标，如 '制冷中 26°'、'播放中 21%'）
 *     空 / undefined → 调用方回退通用规则（on/off → 已开启/已关闭，其余 = state + 单位）
 *   常用底座（别自己再写一份映射表）：
 *     PluginEngine.baseStateText(st, { cool:'制冷中', off:'已关闭' })   // 查不到就原样返回 state
 *     PluginEngine.fieldBits(obj, get, [['powerEntity', (s, n) => n != null ? n + 'W' : '']])
 *       → 自动跳过「没绑 / 实体不在 / 格式化返回空」，末尾拼成 ' · 45W · 55%'
 *
 * ============================================================================
 * 六、plan2d(c, p) / isOn(obj, get) —— 2D 平面图（可选）
 * ============================================================================
 *   plan2d(c, p)：编辑器画平面图里的设备简笔 / 门窗口符号。不写就用引擎兜底符号。
 *     c   CanvasRenderingContext2D。画布已 translate 到中心、rotate 到墙方向（门/窗）
 *         或设备朝向，只需以原点为中心画线
 *     p   { sel, on, hasState, ppm, type, L(仅门/窗), style, options,
 *           entityId, state, obj, getState, ink, fill, accent, accent2, lw, rrect(), draw() }
 *       ├ L        门/窗洞口的屏幕像素宽度（= w × ppm）；设备没有 L：点状图形按「米 × ppm」自己算
 *       ├ ppm      像素/米，把真实尺寸换算成屏幕上该多大
 *       ├ sel      是否选中（选中虚线圈由编辑器统一画，插件别自己画）
 *       ├ on       开/关：统一判定（顶层 isOn(obj,get) → 默认规则，见 ha.js deviceIsOn）
 *       ├ hasState 设备专用：实体是否连上（没连上时 ink 是红色）
 *       ├ ink      描边主色（门/窗：选中蓝 / 窗浅蓝 / 门深灰）
 *       ├ fill     状态填充色：开 = 暖琥珀 #fdeecb，关 = 白
 *       │          **只能填在线稿的封闭形状内部**（贴合线框，透明角落不着色）
 *       ├ accent / accent2 / lw   设备专用：活动部件浅灰 / 次级部件中灰 / 线宽 1.6
 *       ├ style    当前造型内部 id（不带插件前缀）
 *       ├ options  样式参数合并后的值（同 ctx.options），据此画左右开等差异
 *       ├ entityId / state / obj  主实体与实例数据
 *       ├ getState (id) => 状态对象，需要读扩展实体时用
 *       ├ rrect(x,y,w,h,rad)      只建圆角矩形路径（不填不描），可继续自己 stroke
 *       └ draw(fn, { fill:false } / { stroke:false })  建路径后统一填 p.fill + 描 p.ink
 *     返回：设备返回包围半径（像素，编辑器据此画选中圈）；门/窗不需要返回
 *
 *   风格约束（不遵守平面图会显得脏、会闪）：
 *     · 只画中性线稿：颜色只用 p.fill / p.ink / p.accent / p.accent2 / p.lw
 *     · 状态色只填在封闭形状内部；没有封闭形状的（灯带、窗帘）画一条贴合的圆角底条，
 *       不要铺整圆背景
 *     · 不要画随机装饰：平面图每次重绘（状态 / 选中 / 参数变化都会整图重画）都执行，
 *       随机值会让符号一直闪
 *
 *   isOn(obj, get)：开/合判定的**唯一入口**（设备 / 门 / 窗通用），给 2D 填充色、
 *   3D 标签高亮、大屏统计、点击开关方向用。
 *     obj  实例数据；get (entityId) => 状态对象
 *     返回 true / false；返回 null / 不实现 → 回退 HA.isOn 默认规则
 *     例：窗 = 开关 on 且开度 > 0；卷帘 = 门磁 on；固定窗恒 false（平面上永远白底）
 *     设备用它的场景：窗帘 open / 扫地机 cleaning / 音箱 playing 这类非 on/off 状态
 *     （含多实体组合）；引擎入口 PluginEngine.isOnOf(type, style, obj, get)，
 *     click 里不再有 isOn。3D 门扇窗扇的动画仍由 model3d 自己按开度算（见 openRatioOf）
 *
 * ============================================================================
 * 七、model3d(ctx) —— 模型工厂（设备与门/窗统一，必填，可 async）
 * ============================================================================
 *   返回 { group, update?, dispose? }：
 *     group   必填，要显示的全部内容挂在这个节点下。原点 = 锚点（见下方坐标系）
 *     update  可选，任一绑定实体状态变化时被调用。只做「读状态 → 算目标值」，
 *             别在里面建模型或做重活（可能一秒几十次）
 *     dispose 可选，场景重建时被调用。自建的贴图/监听在这里释放；几何由引擎回收
 *   引擎会补齐：只返回 { group } 也合法（update 置 null、dispose 补空函数）；
 *   有 update 时引擎在挂上场景后替你调一次初值，插件里不用再写 api.update()。
 *   返回 null / 抛错 / Promise reject 只打日志：其它实例照常跑，本实例走引擎占位
 *   （设备 = 半透明小方块，门/窗 = 半透明薄板）。
 *
 *   坐标系（引擎负责摆位，你只管在原点周围搭模型）：
 *     单位统一「米」。
 *     门/窗（type:'door'/'window'）：原点 = 洞口地面中心；+X 沿洞口宽度；+Y 向上；
 *              +Z 垂直墙面；引擎把 group 摆到 (obj.x, 0, obj.y) 并按 obj.rot 绕 Y 轴旋转
 *     其他设备：原点 = 锚点（吸顶灯=天花板面、壁灯=墙面点、落地扇=地面点、扫地机=地面）；
 *              锚点离地高度 = obj.z ?? styles[].z ?? 1.2；
 *              引擎把 group 放进 body 容器，再统一做「整体比例 obj.pct、水平旋转 obj.rot、
 *              抬到锚点高度」
 *     两种都别自己给 group 加位置/朝向偏移，否则会和引擎的摆放叠加两次。
 *
 * ============================================================================
 * 八、背景插件（kind: 'background'）
 * ============================================================================
 *   背景 = 房屋外围的地面。不实现 model3d，改为在 styles 里逐项声明 apply(ctx)：
 *     apply(ctx) 必须返回 { group, refresh?, update?, size? }
 *       group   THREE.Group，你的整块地面（扁平背景 = group 里放 ctx.plane(整块画布)）
 *       refresh 可选，覆盖条目上声明的刷新率
 *       update  可选，(t, api) => void，动态背景的刷新回调；t = 挂载至今的秒数
 *       size    可选，动态背景 api.size 的取值（缺省 512）
 *     静态/动态由 refresh 决定：0 或省略 = 静态只画一次；1..30 = 每秒回调 update 这么多次。
 *     ctx：{ THREE, size, house, safe, options, refresh, plane(src, sizeM?) }
 *   逐字段详解、坐标换算、安全边界用法、可复制示例 → assets/plugins/background/plugin.js
 *   头部注释（背景插件的权威手册）。
 *
 * ============================================================================
 * 九、model3d 的 ctx —— 引擎给你的全部能力
 * ============================================================================
 *   【基础引用】
 *   ctx.THREE     three.js 命名空间。用 ctx.THREE，别自己再引 CDN（会出现两套类）
 *   ctx.obj       本实例数据（门窗/设备），字段见第十节
 *   ctx.style     当前造型条目（id 已去掉插件前缀）：
 *                 { id, name, sid, plugin, z?, labelOffset?, icon?, model?, desc?, options? }
 *                 用 ctx.style.id 判断该画哪种造型（缺省 = styles 第一项）
 *   ctx.options   当前样式的 options 取值，如 { hand:'left', open:'in' }（默认值 ∪ obj.styleOpts）；
 *                 样式没声明 options 时是 {}。用它，不要自己读 obj.styleOpts
 *   ctx.wallH     当前楼层墙高（米，默认 2.8）：做门/窗/到顶柜高度、吊灯线长时按它算
 *   ctx.baseUrl   本插件目录的 URL（'.../plugins/door/'），拼自定义资源路径用
 *   ctx.view      View3D 实例（一般不用；要强制刷新用 ctx.render()）
 *
 *   【加载模型】
 *   ctx.glb(file)                Promise<Group|null>，读插件目录下的 GLB（内部已 clone）。
 *                                失败返回 null —— 一定要写兜底分支（用户可能只拷了 plugin.js）
 *   ctx.frame(g, L, ref, fb?)    Promise<boolean>，门窗框统一入口：加载共享 models/frame.glb
 *                                并按 L/ref 缩放（门 ref=0.9、窗 1.2）；模型缺失时用引擎内置
 *                                门套/窗套兜底（ref ≤ 1m 选门套，否则窗套）。返回是否用上了 GLB
 *
 *   【几何 / 材质】（都返回 Mesh，且已 add 到 parent）
 *   ctx.lambert(color, opts?)                         Lambert 材质（本场景无环境贴图，
 *                                                     别用高 metalness 的 Standard，会发黑）
 *   ctx.box(parent, w,h,d, x,y,z, color, opts?)       方块
 *   ctx.cyl(parent, rTop,rBottom,h, seg, x,y,z, color, opts?)  圆柱
 *   ctx.sphere(parent, r, x,y,z, color, opts?)        球
 *   ctx.glowTexture()                                 径向渐变光晕贴图（跨实例共享，省内存）
 *   ctx.lightKit(parent, y, glowSize, opts)           灯具光效：灯泡 + 光晕 + 点光源(+ 聚光)
 *       y       灯泡相对 parent 的高度（米）
 *       glowSize 光晕尺寸（米，约等于灯的视觉直径）
 *       opts.dir 'down'（吸顶/吊灯/筒灯，向下锥形）| 'wall'（壁灯，向墙外斜下）
 *                | 'omni'（落地灯/灯带，全向）
 *       opts.angle / dist / strength  聚光锥角(rad) / 照射距离(m) / 强度
 *       返回 kit.set(on, rgb) 一键开关并同步光色、kit.addMat(m) 让自定义材质一起发光、
 *       kit.bulbMat / glowMat / plight / spot 可直接微调
 *
 *   【读 HA 状态】
 *   ctx.getState(eid)     完整状态对象 { state, attributes }；没连上/实体不存在 → undefined
 *   ctx.isOn(eid)         state === 'on'（light/switch/fan 域内非 off/closed 也算）
 *   ctx.binaryRatio(eid)  二态开合比例：on/open → 1，其它 → 0，未绑/无状态 → null
 *                         （门窗开合动画的目标值直接用它，别再手写三元）
 *   ctx.toNum(v)          宽松数值解析：''/unknown/unavailable/非数字 → null
 *
 *   【扩展实体（fields 里声明的 key）】未绑定一律返回空值，不用判空
 *   ctx.field(key)        'sensor.xxx' 或 null —— 绑定的实体 id
 *   ctx.hasField(key)     是否绑定
 *   ctx.fieldState(key)   完整状态对象
 *   ctx.fieldOn(key)      state === 'on'
 *   ctx.fieldNum(key)     45.2（unknown/unavailable/非数字 → null）
 *   ctx.fieldText(key)    '45.2 W'（自动带单位；未绑定 → ''）
 *
 *   【时序】
 *   ctx.animate(fn)   登记逐帧回调 fn(dt)。dt 单位是秒、已封顶 0.1s（切标签页回来不会跳帧）；
 *                     场景重建/实例销毁自动注销。单槽位：再调一次会覆盖上一个回调，
 *                     要多段动画就在一个函数里写
 *   ctx.render()      手动渲染一帧（一般不用，引擎在 update 后会刷）
 *
 *   【PluginEngine 现成工具】—— 别在插件里各写一份
 *   PluginEngine.ico(inner)                样式按钮图标包装（24×24、stroke=currentColor）
 *   PluginEngine.isOnState(st)             on/open 判定
 *   PluginEngine.runningState(st, opts?)   非 off/unavailable 即运行（多模式域用）
 *   PluginEngine.baseStateText(st, map)    标签文案底座（默认 { on:'已开启', off:'已关闭' }）
 *   PluginEngine.fieldBits(obj, get, list) 把扩展实体读数拼进标签文案
 *   PluginEngine.defFor(type, styleId)     某造型由哪个插件负责（调试用）
 *   PluginEngine.bgKit                     背景插件共享底座：canvas / speckle / seed / rand /
 *                                          retile / fullPlane / flat / repeatOpt
 *
 * ============================================================================
 * 十、obj —— 实例数据里有什么
 * ============================================================================
 *   门/窗（type:'door'/'window'，数据在 floors.doors / floors.windows）：
 *     obj.id / x / y / rot   平面位置与朝向（米 / 弧度）。引擎已应用，插件不用管
 *     obj.w                  洞口宽度（米），门默认 0.9、窗默认 1.2 —— 模型按它缩放
 *     obj.style              '<插件id>:<造型id>'，决定用哪个插件 + 哪个造型
 *     obj.styleOpts          样式参数取值，读 ctx.options 即可，不用直接碰它
 *     obj.entityId           主实体（门磁/窗磁）—— 门/窗的实体都写在 fields 里
 *     obj.posEntityId        开度实体（window 插件自己声明在 fields 里的）
 *     obj.click              可选，「点击控制」的人工覆盖（true / false，需插件声明了 click）
 *     obj.labelOffset        可选，标签抬升覆盖（插件 labels:true 时才看得到标签）
 *     obj.swing              可选，开门角度（弧度）。新实例可能没有该字段：
 *                            const swing = obj.swing != null ? obj.swing : 1.1
 *   设备（floors.devices）：
 *     obj.id / x / y / rot   平面位置、朝向（rot 单位是「度」）
 *     obj.type               HA 实体类型（light/switch…）—— 判定链/样式面板都按它
 *     obj.z                  可选，锚点离地高度（米）；不写用造型的 z
 *     obj.pct                整体比例（%），默认 100
 *     obj.style / styleOpts  同上
 *     obj.entityId           主实体
 *     obj.click              可选，属性面板「点击控制」的人工覆盖（true / false）
 *     obj.model / obj.scale  可选，自定义 GLB 与尺寸；插件自己决定要不要用
 *   通用：fields 里声明的 key 都直接挂在 obj 上。
 *
 * ============================================================================
 * 十一、状态刷新是怎么发生的（不用你订阅）
 * ============================================================================
 *   HA 推送 change
 *     → 引擎遍历所有实例调 update()（不做按键过滤，任何实体变化都会调）
 *     → 你在 update() 里读状态、算出目标值（目标角度 / 透明度 / 颜色）
 *     → ctx.animate 的逐帧回调把「当前值」缓动到「目标值」
 *   所以开关门是「滑过去」而不是「跳过去」。
 *   别把 ctx.getState() 塞进 animate：那是每帧一次 Map 查找 + 计算，纯浪费。
 *
 * ============================================================================
 * 十二、常见坑
 * ============================================================================
 *   · 忘了升 plugin.json 的 version：浏览器吃一年缓存，看不到新代码
 *   · await ctx.glb() 没写失败分支：模型文件缺失时整个实例挂掉
 *   · 多实例共用一个模型却直接 add 原型对象：Three 对象只能有一个父节点，会互相「抢走」。
 *     用 ctx.glb()（内部 clone）
 *   · 在 model3d 里 await 不确定时长的东西（网络请求 / 定时器）：场景重建后你的实例会被
 *     丢弃，白加载
 *   · 自己给 group 设 position / rotation：会和引擎的摆放叠加
 *   · 用 MeshStandardMaterial + 高 metalness：本场景没有环境贴图，会发黑
 *   · plan2d 里铺整圆背景、画随机装饰：平面图每帧重绘，会闪
 *   · 控制台调试：window.__HA_DBG !== false 时才打日志，生产环境自动静音
 *
 * ============================================================================
 * 十三、最小可跑模板（复制成一个新插件目录即可）
 * ============================================================================
 * // plugin.json: { "id": "mydoor", "name": "我的门", "version": "1.0.0" }
 * PluginEngine.register({
 *   id: 'mydoor', type: 'door', name: '我的门',      // type:'door' = 贴墙类型，与设备同一套契约
 *   styles: [{ id: 'plain', name: '平板门' }],                    // 不给 icon 就用 ⚙️
 *   fields: [{ key: 'entityId', label: '门磁实体', domains: ['binary_sensor'] }],
 *   isOn(obj, get) {                                              // 2D 填充色用
 *     const st = obj.entityId ? get(obj.entityId) : null;
 *     return !!st && (st.state === 'on' || st.state === 'open');
 *   },
 *   plan2d(c, p) { p.draw(() => c.rect(-p.L / 2, -3, p.L, 6)); }, // 一行线稿 + p.fill 填色
 *   model3d(ctx) {
 *     const T = ctx.THREE, L = ctx.obj.w || 0.9, H = 2.06;
 *     const g = new T.Group();
 *     ctx.box(g, L, H, 0.05, 0, H / 2, 0, '#8a6f52');            // 一块门板
 *     let open = false;
 *     ctx.animate((dt) => {                                      // 每帧缓动（dt 单位秒）
 *       const target = open ? 0.9 : 0;
 *       g.rotation.y += (target - g.rotation.y) * Math.min(1, dt * 4);
 *     });
 *     return {
 *       group: g,
 *       update() {                                               // 实体变化时重新算目标
 *         const st = ctx.getState(ctx.obj.entityId);
 *         open = !!(st && st.state === 'on');
 *       },
 *     };
 *   },
 * });
 * // 设备类：kind 换成 'device'、type 换成 'light'，给 styles[].z 填锚点离地高度，
 * // 需要点击再加 click: { on:'turn_on', off:'turn_off' }，需要标签文案再加 stateText(st, obj, get)。
 */
'use strict';

/* 包一层 IIFE：插件是独立 <script> 加载的经典脚本，顶层 const 会与其他插件共享全局作用域，
 * 重名会直接 SyntaxError（整个插件失效）。所有辅助函数/常量都写在函数作用域内。 */
(function () {

/* 造型图标（属性面板样式按钮里用，v-html 渲染） */
const ico = PluginEngine.ico;   // 图标包装在引擎里统一实现（PluginEngine.ico）
const ICON_SINGLE = ico('<line x1="4" y1="4" x2="4" y2="20"/><path d="M4 5h8v14H4z"/><path d="M12 7a8 8 0 0 1 0 10" opacity=".5"/>');
const ICON_DOUBLE = ico('<line x1="3" y1="4" x2="3" y2="20"/><line x1="21" y1="4" x2="21" y2="20"/><path d="M3 6h6v12H3zM15 6h6v12h-6z"/>');

/* 门框: ctx.frame 优先取 models/frame.glb（标准洞宽 0.9m 等比缩放），
 * GLB 缺失时用引擎内置门框兜底（ref ≤ 1m 自动选通高门套几何，见 plugins.js frameFallback） */
async function buildFrame(ctx, g, L) {
  await ctx.frame(g, L, 0.9);
}

/* 单开门: 一扇门。造型条目 options 决定差异（值存实例 obj.styleOpts，经 ctx.options 读到）:
 *   hand: 'left'(缺省)=铰链在 -X 侧 / 'right'=铰链在 +X 侧（右开门）
 *   open: 'in'(缺省)=向 +Z 内开 / 'out'=向 -Z 外开 */
async function buildSingle(ctx, L) {
  const o = ctx.options || {};
  const right = o.hand === 'right';
  const out = o.open === 'out';
  const g = new ctx.THREE.Group();
  await buildFrame(ctx, g, L);

  const hinge = new ctx.THREE.Group();
  hinge.position.set(right ? L / 2 : -L / 2, 0, 0);
  const leaf = await ctx.glb('models/leaf.glb');
  if (leaf) {
    leaf.scale.x = (L - 0.08) / 0.86;
    if (right) leaf.rotation.y = Math.PI;   // 右铰链: 门板从铰链向 -X 伸展（镜像）
    hinge.add(leaf);
  } else {
    ctx.box(hinge, L - 0.06, 1.98, 0.045, right ? -(L - 0.06) / 2 : (L - 0.06) / 2, 0.99, 0, '#8a6f52');
  }
  g.add(hinge);

  const swing = Math.abs(ctx.obj.swing != null ? ctx.obj.swing : 1.1);
  const openAngle = swing * (right ? -1 : 1) * (out ? 1 : -1);
  let target = 0;
  const api = {
    group: g,
    update() {
      const r = ctx.binaryRatio(ctx.obj.entityId);
      target = r == null ? openAngle : openAngle * r;
    },
  };
  ctx.animate((dt) => { hinge.rotation.y += (target - hinge.rotation.y) * Math.min(1, dt * 4.5); });
  hinge.rotation.y = target;
  return api;
}

/* 双开门: 两扇对开，各自绕门洞两侧的铰链轴旋转 */
async function buildDouble(ctx, L) {
  const g = new ctx.THREE.Group();
  await buildFrame(ctx, g, L);

  const lw = L / 2 - 0.02;              // 单扇宽
  const leafModel = await ctx.glb('models/leaf.glb');
  const left = new ctx.THREE.Group();   // 左扇: 铰链在 -X 端
  left.position.set(-L / 2, 0, 0);
  const right = new ctx.THREE.Group();  // 右扇: 铰链在 +X 端
  right.position.set(L / 2, 0, 0);

  [left, right].forEach((h, i) => {
    const sign = i === 0 ? 1 : -1;      // 左扇向 +X 伸展、右扇向 -X 伸展
    if (leafModel) {
      const leaf = leafModel.clone(true);
      leaf.scale.x = lw / 0.86;
      leaf.position.x = sign * 0.02;
      if (i === 1) leaf.rotation.y = Math.PI;   // 右扇镜像
      h.add(leaf);
    } else {
      ctx.box(h, lw, 1.98, 0.045, sign * lw / 2, 0.99, 0, '#8a6f52');
      ctx.box(h, 0.03, 0.03, 0.05, sign * (lw - 0.1), 1.0, 0.03, '#c8b79c');   // 把手
    }
  });
  g.add(left, right);

  const openAngle = Math.abs(ctx.obj.swing != null ? ctx.obj.swing : 1.1);
  let target = 0;   // 0..1
  const api = {
    group: g,
    update() {
      const r = ctx.binaryRatio(ctx.obj.entityId);
      target = r == null ? 1 : r;   // 未绑定 → 按 2D 画的姿态默认全开
    },
  };
  ctx.animate((dt) => {
    const k = Math.min(1, dt * 4.5);
    const a = openAngle * target;
    left.rotation.y += (-a - left.rotation.y) * k;
    right.rotation.y += (a - right.rotation.y) * k;
  });
  left.rotation.y = -openAngle * target;
  right.rotation.y = openAngle * target;
  return api;
}

/* ---------------- 2D 平面符号（编辑器调用，造型差异画在这里） ----------------
 * 编辑器把画布移到洞口中心并按墙方向旋转好再调用，所以你只管以原点为中心画。
 * p = { L: 屏幕像素宽度, sel: 是否选中, ink: 描边色(已按选中态给好), fill: 填充色,
 *       ppm: 像素/米, style: 造型内部 id('single'|'double'), kind: 'door' }
 * 不实现 plan2d 也能用，编辑器会画一个通用「洞口矩形 + 中缝线」兜底。 */
function planFrame(c, L, ink, fill) {
  c.fillStyle = fill || '#fff';    // 开=暖琥珀/关=白（p.on 由编辑器按插件 isOn 判定后给出）
  c.strokeStyle = ink;
  c.lineWidth = 1.6;
  c.fillRect(-L / 2, -3, L, 5);
  c.strokeRect(-L / 2, -3, L, 5);
}

function planDoor(c, p) {
  const L = p.L, ink = p.ink || '#2a3346';
  planFrame(c, L, ink, p.fill);
  if (p.style === 'double') {
    /* 双开门：两扇各开 90°，两侧四分之一弧线在中点相接 */
    const half = L / 2;
    c.beginPath();
    c.moveTo(-L / 2, 0); c.lineTo(-L / 2, half);
    c.arc(-L / 2, 0, half, Math.PI / 2, 0, true);
    c.moveTo(L / 2, 0); c.lineTo(L / 2, half);
    c.arc(L / 2, 0, half, Math.PI / 2, Math.PI, false);
    c.stroke();
    return;
  }
  /* 单开门: 按 options 镜像绘制 —— hand='right' 左右镜像（铰链在右）、open='out' 上下镜像（外开）。
   * p.options 由引擎把样式条目 options 与实例 obj.styleOpts 合并后传入 */
  const o = p.options || {};
  const mx = o.hand === 'right' ? -1 : 1;
  const my = o.open === 'out' ? -1 : 1;
  if (mx !== 1 || my !== 1) {
    c.save();
    c.scale(mx, my);
    c.beginPath();
    c.moveTo(-L / 2, 0);
    c.lineTo(-L / 2, L);
    c.arc(-L / 2, 0, L, Math.PI / 2, 0, true);
    c.stroke();
    c.restore();
    return;
  }
  /* 单开门（左铰链·内开，即缺省姿态）：门扇开启 90°，弧线由门扇端点扫向右侧门框 */
  c.beginPath();
  c.moveTo(-L / 2, 0);
  c.lineTo(-L / 2, L);
  c.arc(-L / 2, 0, L, Math.PI / 2, 0, true);
  c.stroke();
}

PluginEngine.register({
  builtin: true,   // 内置插件标记：不带此参数的注册一律视为自定义（「自定义」角标）
  id: 'door',
  type: 'door',        // 贴墙类型：与设备同一套契约（click/isOn/plan2d/标签），编辑器放到墙上并掏洞
  name: '门',

  /* 几何缺省声明（引擎不再按 door/window 硬编码，全部读这里的声明）:
   *   z           锚点离地高度缺省 0（门贴地）
   *   hitY        锚点热球球心高度（保底拾取热区）
   *   labelOffset 标签相对锚点的抬升缺省（≈ 模型中部）
   *   labelBaseY  3D 标签锚点基准高度（模型竖直中部）
   *   defaultW    编辑器放置缺省宽度
   *   placeholder 无插件/创建失败时的占位薄板（宽/高/颜色，y 缺省 h/2） */
  z: 0,
  hitY: 1.1,
  labelOffset: 1.05,
  labelBaseY: 1.05,
  defaultW: 0.9,
  placeholder: { w: 0.9, h: 2.0, color: 0xd8c9b4 },

  plan2d: planDoor,
  styles: [
    /* 样式条目可声明 options（同背景插件的参数 schema）:
     * 同一个「单开门」按实例配 左/右开门、内开/外开 —— 值存 obj.styleOpts，
     * model3d 里 ctx.options / plan2d 里 p.options 读到合并默认值后的结果 */
    { id: 'single', name: '单开门', desc: '单扇平开，可配手向与开向；门磁 on=开门', icon: ICON_SINGLE,
      options: [
        { key: 'hand', label: '手向', type: 'select', def: 'left',
          choices: [{ value: 'left', label: '左开门' }, { value: 'right', label: '右开门' }] },
        { key: 'open', label: '开向', type: 'select', def: 'in',
          choices: [{ value: 'in', label: '内开门' }, { value: 'out', label: '外开门' }] },
      ] },
    { id: 'double', name: '双开门', desc: '两扇对开，各向两侧打开；门磁 on=两扇同时开', icon: ICON_DOUBLE },
  ],
  fields: [
    { key: 'entityId', label: '门磁实体', placeholder: 'binary_sensor.xxx（on=门开）' },
  ],

  /* 2D「开」判定不声明 isOn：走引擎默认规则（主实体 on/open = 开，未绑定 = 关） */

  async model3d(ctx) {
    const L = ctx.obj.w || 0.9;
    const sid = (ctx.style && ctx.style.id) || 'single';
    if (sid === 'double') return buildDouble(ctx, L);
    return buildSingle(ctx, L);
  },
});

})();
