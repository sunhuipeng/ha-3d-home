/*
 * services/ha.js — Home Assistant 浏览器直连 WebSocket 客户端（非 Vue 服务层）
 *
 * 这里不是引擎层：它不做绘制，只负责连接 /api/websocket → auth(长期令牌) →
 * subscribe_entities 实时推送，支持 get_states / call_service；未配置 HA 时进入
 * 演示模式（模拟实体）。WebSocket / pending Promise / 定时器 / entities Map 都是
 * 协议状态机，必须保持普通对象，不能进 Pinia reactive state。
 *
 * UI 需要的响应式投影在 stores/ha.js，由 bridge.js 在 status/change 事件边界写入；
 * 本文件末尾把 HA 挂到 window（供动态插件与旧调用点做特性检测），并注册回前台 /
 * 网络恢复的全局监听 —— 断线重连、退避、心跳与恢复全收在这里，两页入口不用各写一份。
 */

/* 断线重连 / 回前台恢复的节奏常量（毫秒）。
 * 旧实现只有「ws.onclose → 固定 4s 定时器」：后台被冻结时这个定时器不跑，回前台
 * 还要空等 4s，再叠加 WS 握手 + auth + subscribe_entities 全量拉取，体感就是「卡几秒」。
 * 现在改成「首次 0ms 立即重试 → 指数退避到 4s 封顶」，并在回前台 / 网络恢复时
 * 绕过退避直接握手。心跳负责识别「链路已断但 readyState 仍是 OPEN」的僵尸连接
 * （容器掐链路却不派发 onclose 时，纯 onclose 重连永远不会启动）。
 * 常量集中在这里，别散落到各方法里。 */
const RETRY_DELAYS = [0, 300, 800, 1500, 2500, 4000];
const HB_INTERVAL = 15000;    // ping 周期；健康连接的 _lastRx 不会旧于一个周期
const HB_TIMEOUT = 5000;      // ping 发出后 5s 一个字节都没回来 → 判僵尸
const STALE_MS = 45000;       // 回前台时距上次收包超过 3 个周期 → 强制重连
const RESUME_DEBOUNCE = 250;  // visibilitychange / focus / online 会在同一次回前台叠加触发

export const HA = {
  ws: null,
  url: '',           // 仅存服务端已配置的 haUrl（信息展示用），不参与连接
  token: '',         // 已废弃：HA 令牌不再下发浏览器，由服务端代理代管鉴权
  hasToken: false,   // 服务端是否已配置令牌（GET /api/config 的 hasToken 镜像）
  msgId: 10,
  pending: {},        // id -> {resolve, reject}
  entities: new Map(),// entity_id -> state object {state, attributes:{friendly_name,...}}
  connected: false,
  demo: false,
  listeners: { change: [], status: [] },

  /* 连接恢复状态机（纯协议字段，绝不进 Pinia）：
   * _started      connect() 至少调用过一次，防止首屏 pageshow / focus 抢跑连第二次
   * _reconnecting 当前是「断线重连」而非首次连接（决定状态提示文案与轻提示）
   * _retryStep    退避档位，auth_ok 或回前台时归零，恢复快速通道
   * _lastRx       最后一次收到任何 WS 消息的时间戳（pong / 事件推送都算）
   * _resumeAt     回前台事件防抖时间戳 */
  _started: false,
  _reconnecting: false,
  _retryStep: 0,
  _lastRx: 0,
  _resumeAt: 0,
  _hbTimer: null,
  _hbTimeout: null,
  _hbPending: false,

  /* 实体状态是否已就绪（初批 get_states / 订阅推送 / 演示模式填过 entities）。
   * 大屏/编辑页首帧渲染标签前先问它，避免出现「实体 id + 无数据」的闪现。 */
  loaded() { return this.entities.size > 0; },

  on(evt, fn) { this.listeners[evt].push(fn); },
  emit(evt, data) { this.listeners[evt].forEach((f) => { try { f(data); } catch (e) { console.error(e); } }); },

  async loadConfig() {
    /* 2026-11-19 起 GET /api/config 只回 {haUrl, hasToken}（令牌不下发，
     * WS 鉴权由服务端代理代管）。本方法只在编辑页「连接与服务」弹窗打开时调用；
     * 展示页 / 编辑页启动序列都不再请求它 —— HA 连接直接开 WS，是否已配置
     * 由服务端用关闭码 4400 告知（onclose → 演示模式）。 */
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error('读取连接配置失败: HTTP ' + r.status);
    const c = await r.json();
    this.url = (c.haUrl || '').trim();
    this.hasToken = !!c.hasToken;
    return c;
  },

  async saveConfig(haUrl, token) {
    /* 令牌只写不读：POST /api/config 仍接受 token（服务端对空字段回退已落盘的值）。
     * 调用方需要最新配置镜像时自己再 loadConfig() 一次。 */
    const r = await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ haUrl, token }),
    });
    if (!r.ok) throw new Error('保存连接配置失败: HTTP ' + r.status);
    const c = await r.json();
    this._authInvalid = false;
    return c;
  },

  wsUrl() {
    /* 全代理（2026-11-19）：连本服务同源的 /api/ha-ws，由服务端转发到 HA 并代管鉴权。
     * 是否已配置 HA 由服务端用关闭码 4400 告知（onclose → 演示模式），前端不预判。 */
    return (location.origin || '').replace(/^http/, 'ws') + '/api/ha-ws';
  },

  connect() {
    this._started = true;
    this.close();
    clearTimeout(this._retry);
    this.demo = false;
    this.setStatus('connecting', this._reconnecting ? '重连中…' : '连接中…');
    this._lastRx = Date.now();   // 握手窗口内先别被判成僵尸
    /* 不再预判「是否已配置」：直接连服务端代理，未配置时服务端会以关闭码
     * 4400 断开（见 ha-proxy.js CLOSE_UNCONFIGURED），onclose 里进演示模式。 */
    let ws;
    try { ws = new WebSocket(this.wsUrl()); }
    catch (e) { this.setStatus('error', '地址无效: ' + e.message); this.scheduleRetry(); return; }
    this.ws = ws;
    const failTimer = setTimeout(() => { try { ws.close(); } catch (e) {} }, 8000);
    this._failTimer = failTimer;   // close() 里要能清掉，重连时不累积握手超时器

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;     // 旧 socket 的残留帧不参与状态判定 / 实体写入
      this._lastRx = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'auth_required') {
        /* HA 鉴权由服务端代理代管（服务端收到 auth_required 后代发 token），
           浏览器不再发送、也不再持有任何 HA 令牌。这里无事可做。 */
      } else if (msg.type === 'auth_ok') {
        clearTimeout(failTimer);
        this.connected = true;
        this._reconnecting = false;
        this._retryStep = 0;          // 连上了：下次断线重新走「立即重试」快速档
        this.startHeartbeat();
        this.send({ type: 'subscribe_entities' }).then((r) => {
          // subscribe_entities 会先推一份全量: r.entities = { eid: {state, attributes, ...} }
          if (this.ws !== ws) return;       // 连接已被重连替换：旧订阅的快照作废
          if (r && r.entities) {
            for (const [eid, st] of Object.entries(r.entities)) {
              this.entities.set(eid, this.norm(st, eid));
            }
            this.emit('change', { full: true });
          }
        }).catch(() => {
          /* 老版本 HA 没有 subscribe_entities: 退回一次性 get_states。
           * 二者不能并发——都是全量快照，晚到的旧快照会盖掉增量刚更新的实体。
           * 连接被替换时 _flushPending 会 reject 这个订阅，此时绝不能往新 socket
           * 补发 get_states（会和新订阅并发），所以先确认还是同一个 ws。 */
          if (!this.connected || this.ws !== ws) return;
          this.send({ type: 'get_states' }).then((r) => {
            if (this.ws !== ws || !Array.isArray(r.result)) return;
            r.result.forEach((s) => this.entities.set(s.entity_id, this.norm(s, s.entity_id)));
            this.emit('change', { full: true });
          }).catch(() => {});
        });
        this.setStatus('connected');
      } else if (msg.type === 'auth_invalid') {
        /* 服务端配置的 HA 令牌被 HA 拒绝（令牌在服务端，浏览器只负责展示错误） */
        clearTimeout(failTimer);
        this._authInvalid = true;
        this._reconnecting = false;
        this.stopHeartbeat();
        this.setStatus('error', 'HA 令牌无效（服务端已配置的长期访问令牌被 HA 拒绝）');
        this.startDemo();
      } else if (msg.type === 'event' && msg.event) {
        const ev2 = msg.event;
        if (window.__HA_DBG !== false) console.log('[HA-DBG] 收到 ws 事件:', JSON.stringify(ev2).slice(0, 300));
        /* subscribe_events 的 state_changed（完整事件格式） */
        if (ev2.event_type === 'state_changed' && ev2.data && ev2.data.entity_id) {
          const d = ev2.data;
          if (d.new_state) this.entities.set(d.entity_id, d.new_state);
          else this.entities.delete(d.entity_id);
          this.emit('change', { entity_id: d.entity_id, state: d.new_state });
        }
        /* subscribe_entities 增量: 缩写键 c=change / a=add / r=remove
         * 例: { c: { 'light.x': { s:'on', a:{...}, lc:... } } }，r 为实体 id 数组 */
        const applyMap = (map, isRemove) => {
          if (isRemove) {
            (Array.isArray(map) ? map : Object.keys(map)).forEach((eid) => this.entities.delete(eid));
            return;
          }
          for (const [eid, st] of Object.entries(map)) {
            const prev = this.entities.get(eid);
            const nn = this.norm(st, eid);
            // 增量 attributes 是部分 diff，与旧属性合并（避免丢 friendly_name 等）
            if (prev && prev.attributes && nn && nn.attributes) nn.attributes = Object.assign({}, prev.attributes, nn.attributes);
            this.entities.set(eid, Object.assign(prev || { entity_id: eid, attributes: {} }, nn));
          }
        };
        let touched = false;
        if (ev2.c && typeof ev2.c === 'object') { applyMap(ev2.c, false); touched = true; }
        if (ev2.a && typeof ev2.a === 'object') { applyMap(ev2.a, false); touched = true; }
        if (ev2.r) { applyMap(ev2.r, true); touched = true; }
        if (touched) {
          this.emit('change', { batch: true });
          return;
        }
      } else if (msg.id && this.pending[msg.id]) {
        const p = this.pending[msg.id];
        delete this.pending[msg.id];
        clearTimeout(p.timer);   // 已结算，撤掉 15s 超时定时器
        if (msg.type === 'result' && !msg.success) p.reject(new Error(msg.error ? (msg.error.message || JSON.stringify(msg.error)) : '调用失败'));
        else p.resolve(msg);
      }
    };
    ws.onclose = (ev) => {
      clearTimeout(failTimer);
      this.stopHeartbeat();
      if (this.ws === ws) {
        this.ws = null; this.connected = false;
        this._flushPending('连接已关闭');
        /* 服务端明确告知「未配置 HA」（ha-proxy CLOSE_UNCONFIGURED）→ 演示模式，
           不走重连退避；其余（含 1006 网络不通）照旧退避重连。 */
        if (ev && (ev.code === 4400 || ev.reason === 'HA 未配置' || ev.reason === 'HA 令牌未配置')) {
          this._reconnecting = false;
          this.startDemo();
        } else {
          this.scheduleRetry();
        }
      }
    };
    ws.onerror = () => {};
  },

  norm(st, eid) {
    // subscribe_entities 增量可能是 diff 包装: {"+":{s,a,lc,c}}（键变更用 "+" 表示）
    if (st && st['+'] && typeof st['+'] === 'object') st = Object.assign({}, st['+']);
    if (!st || typeof st !== 'object') return st;
    // 全量精简格式: 带 s（状态）→ 统一为 HA state object
    if (st.s !== undefined) {
      return { entity_id: eid, state: st.s, attributes: st.a || {}, last_changed: st.lc ? new Date(st.lc * 1000).toISOString() : undefined };
    }
    // 属性 diff 格式（状态不变，只有 a/lu/c，无 s）→ 只取 attributes，由 applyMap 与旧属性合并
    if (st.a && typeof st.a === 'object') {
      return { entity_id: eid, attributes: st.a };
    }
    return {};   // 只有 lu/c 等元数据变化，状态与属性都没动
  },

  close() {
    clearTimeout(this._retry);
    clearTimeout(this._failTimer);
    this.stopHeartbeat();
    this._flushPending('连接已关闭');
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) {} this.ws = null; }
    this.connected = false;
    this.stopDemo();
  },

  /* 连接被替换 / 关闭时把挂起的请求一次性结算：否则 15s 超时定时器会留到重连之后，
   * 订阅 / 服务调用的 Promise 永远不落地（场景执行的回执 watcher 会一直等到超时）。
   * 调用方（cards / sceneRunner / toggle / 订阅链）都带 catch，reject 不会变成未处理异常。 */
  _flushPending(reason) {
    const pend = this.pending;
    this.pending = {};
    Object.keys(pend).forEach((id) => {
      const p = pend[id];
      if (p.timer) clearTimeout(p.timer);
      try { p.reject(new Error(reason)); } catch (e) { /* 已结算 */ }
    });
  },

  /* 断线自动重连：首次 0ms 立即重试，之后 300ms → 800ms → 1.5s → 2.5s → 4s 封顶。
   * 旧版固定 4s，且后台冻结期间定时器不跑 —— 回前台往往要空等 4s 以上。
   * auth_ok 或回前台（reconnectNow）把 _retryStep 归零，恢复快速通道。 */
  scheduleRetry() {
    if (this._authInvalid) return;
    this._reconnecting = true;
    this.setStatus('connecting', '重连中…');
    clearTimeout(this._retry);
    const i = Math.min(this._retryStep, RETRY_DELAYS.length - 1);
    this._retryStep = Math.min(this._retryStep + 1, RETRY_DELAYS.length - 1);
    this._retry = setTimeout(() => this.connect(), RETRY_DELAYS[i]);
  },

  /* 回前台 / 网络恢复：不等任何退避定时器，立即重新握手（0 等待）。
   * 关键是处理「僵尸连接」：容器把链路掐了却没派发 onclose，readyState 仍是 OPEN，
   * 旧实现既不会重连、也不会有任何状态变化；靠 _lastRx 与心跳把它认出来。 */
  reconnectNow() {
    if (!this._started || this.demo || this._authInvalid) return;
    const now = Date.now();
    if (now - this._resumeAt < RESUME_DEBOUNCE) return;   // 同一次回前台只处理一次
    this._resumeAt = now;
    const ws = this.ws;
    /* 链路确实活着（刚收到过消息）就别打断：否则每次切回前台都白白重连一次 */
    if (this.connected && ws && ws.readyState === 1 && (now - this._lastRx) < STALE_MS) return;
    clearTimeout(this._retry);
    this._retryStep = 0;
    this._reconnecting = true;
    this.connect();     // connect() 内部 close() 会顺手关掉僵尸 socket
  },

  /* ---------------- 心跳：识别不发 onclose 的假连接 ----------------
   * HA WebSocket 支持 {type:'ping'} → {type:'pong'}；老版本不支持时返回 result:false，
   * 也算「有响应」，不误判断线。只有 5s 内一个字节都没回来才强制重连。
   * 隐藏时跳过：WebView 后台会冻结 JS 定时器，恢复瞬间不能拿冻结前的时间戳误判。 */
  startHeartbeat() {
    this.stopHeartbeat();
    if (this.demo) return;
    this._hbTimer = setInterval(() => this._ping(), HB_INTERVAL);
  },
  stopHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    if (this._hbTimeout) { clearTimeout(this._hbTimeout); this._hbTimeout = null; }
    this._hbPending = false;
  },
  _ping() {
    const ws = this.ws;
    if (!this.connected || !ws || ws.readyState !== 1) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (this._hbPending) return;
    this._hbPending = true;
    this._hbTimeout = setTimeout(() => {
      this._hbTimeout = null;
      if (!this._hbPending) return;
      this._hbPending = false;
      this._staleReconnect();
    }, HB_TIMEOUT);
    /* send 自带 15s 超时太慢，这里用上面那个 5s 独立的短超时判定 */
    this.send({ type: 'ping' }).then(() => this._onPong(), () => this._onPong());
  },
  _onPong() {
    if (this._hbTimeout) { clearTimeout(this._hbTimeout); this._hbTimeout = null; }
    this._hbPending = false;
  },
  _staleReconnect() {
    if (!this.connected) return;
    this._reconnecting = true;
    clearTimeout(this._retry);
    this._retryStep = 0;
    this.connect();
  },

  send(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('WebSocket 未连接'));
      const id = ++this.msgId;
      /* 超时 timer 记进 pending，结算（成功/失败/超时）时清掉 —— 不留 no-op 定时器 */
      const timer = setTimeout(() => {
        if (this.pending[id]) { delete this.pending[id]; reject(new Error('请求超时')); }
      }, 15000);
      this.pending[id] = { resolve, reject, timer };
      this.ws.send(JSON.stringify(Object.assign({ id }, payload)));
    });
  },

  /* 调用服务。data = 服务数据（entity_id 自动拆到 target，其余进 service_data）。
   * HA websocket 的 call_service 要求 target（实体定位：entity_id/device_id/area_id）
   * 与 service_data（服务参数，如 brightness_pct/temperature）分开传 —— 混在 target 里
   * 会被 HA 拒绝：not a valid option at 'target.xxx' */
  async callService(domain, service, data) {
    const d = Object.assign({}, data || {});
    const eid = d.entity_id;
    delete d.entity_id;
    const target = eid ? { entity_id: eid } : {};
    if (this.demo) return this.demoCall(domain, service, target, d);
    return this.send({ type: 'call_service', domain, service, target, service_data: d });
  },

  /* ---------------- 演示模式（未配置 HA 时可用） ---------------- */
  demoTimer: null,
  startDemo() {
    if (this.demo) return;
    this.demo = true;
    this._reconnecting = false;
    this.stopHeartbeat();
    this.setStatus('demo');
    const mk = (eid, state, attrs, domain) => ({ entity_id: eid, state, attributes: Object.assign({ friendly_name: eid.split('.')[1].replace(/_/g, ' ') }, attrs), demo: true, domain });
    const demoEntities = [
      mk('light.living', 'on', { friendly_name: '客厅 吸顶灯', brightness: 180, brightness_pct: 71, color_temp_kelvin: 3000, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
      mk('light.living_ambient', 'off', { friendly_name: '客厅 氛围灯', brightness: 0, brightness_pct: 0, color_temp_kelvin: 2700, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
      mk('light.master', 'on', { friendly_name: '卧室 主灯', brightness: 220, brightness_pct: 86, color_temp_kelvin: 4000, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
      mk('light.kitchen', 'off', { friendly_name: '厨房 灯', brightness: 0, brightness_pct: 0, color_temp_kelvin: 5000, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
      mk('light.study', 'off', { friendly_name: '书房 灯', brightness: 0, brightness_pct: 0, color_temp_kelvin: 4500, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
      mk('light.hall', 'on', { friendly_name: '楼道 灯', brightness: 120, brightness_pct: 47, color_temp_kelvin: 3000, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
      mk('switch.ac_plug', 'on', { friendly_name: '空调插座' }, 'switch'),
      mk('switch.tv_plug', 'off', { friendly_name: '电视插座' }, 'switch'),
      /* 卡片用：气候 / 风扇 / 热水器必须有属性，否则 range 取不到 attr: 边界会直接不渲染 */
      mk('climate.living', 'cool', {
        friendly_name: '客厅 空调', temperature: 24, current_temperature: 26.5,
        min_temp: 16, max_temp: 30, temperature_step: 0.5,
        hvac_modes: ['off', 'cool', 'heat', 'dry', 'fan_only', 'auto'], hvac_mode: 'cool',
        fan_modes: ['auto', 'low', 'medium', 'high'], fan_mode: 'auto',
      }, 'climate'),
      mk('fan.bedroom', 'on', {
        friendly_name: '卧室 风扇', percentage: 60, percentage_step: 10, oscillating: false,
      }, 'fan'),
      mk('water_heater.boiler', 'eco', {
        friendly_name: '阳台 热水器', temperature: 50, current_temperature: 48,
        min_temp: 30, max_temp: 75, operation_mode: 'eco',
      }, 'water_heater'),
      mk('sensor.living_temp', '24.5', { friendly_name: '客厅 温度', unit_of_measurement: '°C' }, 'sensor'),
      mk('sensor.living_hum', '56', { friendly_name: '客厅 湿度', unit_of_measurement: '%' }, 'sensor'),
      mk('sensor.outdoor_temp', '18.2', { friendly_name: '室外 温度', unit_of_measurement: '°C' }, 'sensor'),
      mk('sensor.outdoor_hum', '62', { friendly_name: '室外 湿度', unit_of_measurement: '%' }, 'sensor'),
      mk('sensor.power', '860', { friendly_name: '全家 功率', unit_of_measurement: 'W' }, 'sensor'),
      mk('sensor.pm25', '23', { friendly_name: 'PM2.5', unit_of_measurement: 'µg/m³' }, 'sensor'),
      mk('weather.home', 'partlycloudy', { friendly_name: '天气', temperature: 18, humidity: 62 }, 'weather'),
      mk('cover.curtain_living', 'open', { friendly_name: '客厅 窗帘', current_position: 70, supported_features: 15 }, 'cover'),
      mk('vacuum.robot', 'docked', { friendly_name: '扫地机器人', battery_level: 82 }, 'vacuum'),
      mk('scene.good_morning', 'off', { friendly_name: '晨起模式' }, 'scene'),
      mk('scene.movie_night', 'off', { friendly_name: '观影模式' }, 'scene'),
      mk('scene.away', 'off', { friendly_name: '离家模式' }, 'scene'),
      mk('scene.sleep', 'off', { friendly_name: '睡眠模式' }, 'scene'),
      mk('automation.auto_light', 'on', { friendly_name: '人来灯亮' }, 'automation'),
      mk('automation.night_off', 'on', { friendly_name: '深夜熄灯' }, 'automation'),
    ];
    demoEntities.forEach((s) => this.entities.set(s.entity_id, s));
    this.emit('change', { full: true });
    this.demoTimer = setInterval(() => {
      // 温湿度缓慢波动，制造“实时”感
      const drift = (eid, base, amp, dec) => {
        const e = this.entities.get(eid);
        if (!e) return;
        const v = parseFloat(e.state) || base;
        const nv = Math.max(base - amp, Math.min(base + amp, v + (Math.random() - 0.5) * amp / 8));
        e.state = nv.toFixed(dec);
      };
      drift('sensor.living_temp', 24.5, 2, 1);
      drift('sensor.living_hum', 56, 8, 0);
      drift('sensor.outdoor_temp', 18.2, 3, 1);
      drift('sensor.power', 860, 300, 0);
      this.emit('change', { demo: true });
    }, 3000);
  },
  stopDemo() { this.demo = false; if (this.demoTimer) { clearInterval(this.demoTimer); this.demoTimer = null; } },
  /* 演示模式的「服务调用」：必须吃 service_data，否则卡片上的滑块/下拉点了没有任何反馈，
   * 而本项目所有卡片验证都跑在演示模式 + 无头 Edge 里。 */
  demoCall(domain, service, target, data) {
    const eid = target && target.entity_id;
    const d = data || {};
    const e = eid && this.entities.get(eid);

    if (e) {
      const a = e.attributes;
      const on = () => { e.state = 'on'; };
      const off = () => { e.state = 'off'; };

      if (domain === 'light') {
        if (service === 'toggle') e.state = e.state === 'on' ? 'off' : 'on';
        else if (service === 'turn_on') {
          on();
          if (d.brightness_pct != null) {
            a.brightness_pct = Math.round(d.brightness_pct);
            a.brightness = Math.round(d.brightness_pct * 255 / 100);
          }
          if (d.brightness != null) {
            a.brightness = Math.round(d.brightness);
            a.brightness_pct = Math.round(d.brightness / 255 * 100);
          }
          if (d.color_temp_kelvin != null) a.color_temp_kelvin = Math.round(d.color_temp_kelvin);
        } else if (service === 'turn_off') {
          off(); a.brightness_pct = 0; a.brightness = 0;
        }
      } else if (domain === 'switch' || domain === 'fan' || domain === 'input_boolean') {
        if (service === 'toggle') e.state = e.state === 'on' ? 'off' : 'on';
        else if (service === 'turn_on') on();
        else if (service === 'turn_off') off();
        if (service === 'set_percentage' && d.percentage != null) {
          a.percentage = Math.round(d.percentage);
          e.state = d.percentage > 0 ? 'on' : 'off';
        }
        if (service === 'set_speed' && d.speed != null) { a.speed = d.speed; on(); }
        if (service === 'oscillate' && d.oscillating != null) a.oscillating = !!d.oscillating;
      } else if (domain === 'climate') {
        if (service === 'turn_on') e.state = a.hvac_mode && a.hvac_mode !== 'off' ? a.hvac_mode : 'auto';
        else if (service === 'turn_off') { off(); a.hvac_mode = 'off'; }
        else if (service === 'toggle') e.state = e.state === 'off' ? (a.hvac_mode === 'off' ? 'auto' : a.hvac_mode) : 'off';
        if (service === 'set_temperature' && d.temperature != null) {
          a.temperature = d.temperature;
          if (e.state === 'off') { a.hvac_mode = 'heat'; e.state = 'heat'; }
        }
        if (service === 'set_hvac_mode' && d.hvac_mode) { a.hvac_mode = d.hvac_mode; e.state = d.hvac_mode; }
        if (service === 'set_fan_mode' && d.fan_mode) a.fan_mode = d.fan_mode;
      } else if (domain === 'cover') {
        if (service === 'open_cover') { e.state = 'open'; a.current_position = 100; }
        else if (service === 'close_cover') { e.state = 'closed'; a.current_position = 0; }
        else if (service === 'toggle') {
          const opened = e.state === 'open';
          e.state = opened ? 'closed' : 'open';
          a.current_position = opened ? 0 : 100;
        }
        if (service === 'set_cover_position' && d.position != null) {
          a.current_position = Math.round(d.position);
          e.state = d.position > 0 ? 'open' : 'closed';
        }
      } else if (domain === 'water_heater') {
        if (service === 'turn_on') e.state = a.operation_mode && a.operation_mode !== 'off' ? a.operation_mode : 'eco';
        else if (service === 'turn_off') { off(); a.operation_mode = 'off'; }
        if (service === 'set_temperature' && d.temperature != null) a.temperature = d.temperature;
        if (service === 'set_operation_mode' && d.operation_mode) { a.operation_mode = d.operation_mode; e.state = d.operation_mode; }
      } else if (domain === 'media_player') {
        if (service === 'volume_set' && d.volume_level != null) a.volume_level = d.volume_level;
        if (service === 'media_play') e.state = 'playing';
        if (service === 'media_pause') e.state = 'paused';
      }

      this.emit('change', { entity_id: eid, state: e });
      return Promise.resolve({ demo: true });
    }

    /* 场景 / 自动化：没有单实体 target，按名字批量改灯 */
    if (domain === 'scene') {
      const off = /away|sleep|night/.test(eid || '');
      this.entities.forEach((s, id) => {
        if (/^light\./.test(id)) { s.state = off ? 'off' : 'on'; }
      });
      this.emit('change', { demo: true, full: true });
    } else if (domain === 'automation') {
      this.entities.forEach((s, id) => {
        if (/^light\.hall/.test(id)) s.state = s.state === 'on' ? 'off' : 'on';
      });
      this.emit('change', { demo: true });
    }
    return Promise.resolve({ demo: true });
  },

  /* retrying 供 UI 区分「断线重连」与「首次连接」——展示页据此显示轻提示。
   * 其余字段保持原样，bridge.js 把整个对象写进 ha store。 */
  setStatus(s, msg) {
    this.emit('status', { status: s, message: msg || '', retrying: s === 'connecting' && this._reconnecting });
  },

  /* 工具 */
  getState(eid) { return eid ? this.entities.get(eid) : undefined; },
  isOn(eid) { const s = this.getState(eid); return s && (s.state === 'on' || (s.state !== 'off' && s.state !== 'unavailable' && s.state !== 'closed' && ['light', 'switch', 'fan'].includes((eid || '').split('.')[0]))); },
  /* 实体可读名的唯一出处：friendly_name 优先；取不到回退实体 id 尾段（下划线转空格，
   * 与 engine/cards.js 的标题兜底同一语义 —— 别再各自发明第三种拼法） */
  friendly(eid) { const s = this.getState(eid); return (s && s.attributes && s.attributes.friendly_name) || (eid || '').split('.').pop().replace(/_/g, ' '); },
  all() { return Array.from(this.entities.values()); },
  /* 单位拼接: ' °C' / ' %'（带前导空格，直接拼在 state 后面）；无单位 → '' */
  unitOf(st) {
    const u = st && st.attributes && st.attributes.unit_of_measurement;
    return u ? ' ' + u : '';
  },
  /* ---------------- 「开 / 合」判定统一入口 ----------------
   * 插件侧只有一个判定函数：register 顶层的 isOn(obj, get)。引擎侧只有 PluginEngine.isOnOf。
   * 这里再按上下文包两层，供 UI 直接调用：
   *   deviceIsOn(d)       有实例（2D 绘制 / 3D 标签高亮 / 统计）—— d = { entityId, type, style }
   *   entityIsOn(eid, t)  只有实体 id（设备列表 / 大屏快捷设备），合成 { entityId, type } 交给插件
   * 都回退到 HA.isOn（默认规则）。插件异常已在 PluginEngine.isOnOf 里 warn 并兜底，不会向外冒泡
   * （2D 是在重绘循环里逐个设备调的，一个异常会打断整个平面层的绘制）。 */
  deviceIsOn(d) {
    if (!d || !d.entityId) return false;
    const pe = window.PluginEngine;
    if (!pe || !pe.ready || typeof pe.isOnOf !== 'function') return !!this.isOn(d.entityId);
    // 老实例可能没写 type（放置早于该字段），按实体域兜底；门/窗调用方都会显式传 door/window
    const type = d.type || String(d.entityId).split('.')[0];
    const p = pe.isOnOf(type, d.style, d, (eid) => this.getState(eid));
    return p != null ? p : !!this.isOn(d.entityId);
  },

  /* 同一个判定，但只有实体 id（实体列表、大屏快捷设备这类没有实例/造型的场景）。
   * 插件 isOn 里依赖 fields 的判定拿不到绑定值，按「未绑定」处理 —— 插件侧要写宽容。 */
  entityIsOn(eid, type) {
    const pe = window.PluginEngine;
    const t = type || String(eid || '').split('.')[0];
    if (!pe || !pe.ready || typeof pe.isOnOf !== 'function') return !!this.isOn(eid);
    const p = pe.isOnOf(t, null, { entityId: eid, type: t }, (x) => this.getState(x));
    return p != null ? p : !!this.isOn(eid);
  },

  /* 卡片标题电源开关的统一入口：完全复用插件的 isOn 与 click（与 3D/2D 点击同一套）。
   * 与 view3d.toggleDevice 同判定：PluginEngine.clickSpec 决定发什么服务（插件 click / 内置默认），
   * deviceIsOn 决定当前开着发 off、关着发 on，callService 发出去。
   * obj = { entityId, type?, style? }；type 缺则按实体域兜底。无 click / 无默认 → 不可点。 */
  /* 点击 → 发服务（设备 / 门窗 / 卡片标题电源开关 / 兜底单开关的唯一实现）。
   * 门控与「发什么服务」全部问 PluginEngine，三处调用方不再各写一份：
   *   instanceClickSpec = 实例级「能不能点」（click:false / click:true / clickSvc / defaultOn）；
   *   clickSvcPair      = 实例在属性面板选的 HA 标准动作（优先级最高，整体替换插件 click）；
   *   clickSpec         = 插件声明 click / 内置默认（on/off/label/feedback/domain）。
   * on/off 可以是字符串服务名，也可以是插件自定义函数 fn(obj, api)：方向仍由 deviceIsOn 决定，
   * api 给 call/get/toast —— 函数可自由执行，且**无实体也允许**（不走域/实体校验）。
   * view3d.toggleDevice 只是本方法的转发。 */
  toggle(obj, typeOrKind) {
    if (!obj) return;
    const pe = window.PluginEngine;
    if (!pe || typeof pe.instanceClickSpec !== 'function') return;
    const type = typeOrKind || String(obj.entityId || '').split('.')[0];
    const spec = pe.instanceClickSpec(obj, type);   // 不可点 → 直接返回
    if (!spec) return;
    const entDomain = () => (String(obj.entityId || '').includes('.') ? String(obj.entityId).split('.')[0] : null);
    const domain0 = spec.domain || entDomain();
    let on = spec.on || 'toggle';
    let off = spec.off || 'toggle';
    let label = spec.label;
    let feedback = spec.feedback === true;
    let domain = domain0;
    if (obj.clickSvc) {   // 实例级覆盖（面板「点击动作」下拉，优先级最高）
      const pair = (typeof pe.clickSvcPair === 'function') ? pe.clickSvcPair(obj.clickSvc) : null;
      if (pair) {
        on = pair.on; off = pair.off; label = pair.label; feedback = pair.feedback === true;
        domain = entDomain() || domain0;
      }
    }
    /* 方向判定必须把**完整实例**交给 deviceIsOn：复合 isOn（如「主实体开 且
     * 功率 > 0」）要读实例上的 fields 绑定（powerEntity 等）。这里若只挑
     * {entityId,type,style} 重建，插件 isOn 里的 obj.powerEntity 为 undefined
     * → 恒判「关」→ 运行中点关反而发出 turn_on，表现为「点了没反应」。
     * type 用上面归一化过的值覆盖，其余字段（fields 绑定）原样保留。 */
    const onNow = this.deviceIsOn(Object.assign({}, obj, { type }));
    const svc = onNow ? off : on;
    if (typeof svc === 'function') {           // 自定义函数形态（高级用法）：方向由 isOn 驱动
      const api = {
        obj,
        call: (dom, service, data) => this.callService(dom, service, data || {}),
        get: (eid) => (typeof this.getState === 'function' ? this.getState(eid) : null),
        toast: (msg) => { if (window.App) App.toast(String(msg)); },
      };
      try {
        Promise.resolve(svc.call(null, obj, api)).catch((err) => {
          if (window.App) App.toast('控制失败: ' + (err && err.message ? err.message : err));
        });
      } catch (err) {
        if (window.App) App.toast('控制失败: ' + (err && err.message ? err.message : err));
      }
      return;
    }
    if (!domain || !obj.entityId) return;
    this.callService(domain, svc, { entity_id: obj.entityId })
      .then(() => { if (feedback && window.App) App.toast((obj.name || this.friendly(obj.entityId) || '设备') + ' · ' + (label || svc)); })
      .catch((err) => { if (window.App) App.toast('控制失败: ' + (err && err.message ? err.message : err)); });
  },
};

/* 暴露到 window: 其它模块（插件引擎/实体搜索组件）用 window.HA 做特性检测 */
window.HA = HA;

/* 回前台 / 网络恢复的全局监听（模块单例，只注册一次）。
 * 空壳 App 的 WebView 在后台会暂停 JS 定时器，旧的 4s 重连定时器不会按时跑；
 * 这里在可见 / 联网 / 获得焦点 / bfcache 恢复时直接 reconnectNow()，绕过退避等待。
 * _started 由 connect() 置位，避免首屏 pageshow / focus 抢在 bootStage 之前连第二次。
 * 纯前端改动，不需要 App 壳配合；壳日后若也发 resume 事件，防抖会合并重复触发。 */
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) HA.reconnectNow(); });
  window.addEventListener('online', () => HA.reconnectNow());
  window.addEventListener('focus', () => HA.reconnectNow());
  window.addEventListener('pageshow', (ev) => { if (ev && ev.persisted) HA.reconnectNow(); });
}
