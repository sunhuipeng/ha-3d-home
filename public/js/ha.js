/*
 * ha.js — Home Assistant 浏览器直连 WebSocket 客户端
 * 流程: 连接 /api/websocket → auth(长期令牌) → subscribe_entities 实时推送
 * 支持 get_states / call_service；未配置 HA 时进入演示模式（模拟实体）。
 */
'use strict';

const HA = {
  ws: null,
  url: '',
  token: '',
  msgId: 10,
  pending: {},        // id -> {resolve, reject}
  entities: new Map(),// entity_id -> state object {state, attributes:{friendly_name,...}}
  connected: false,
  demo: false,
  listeners: { change: [], status: [] },

  /* 实体状态是否已就绪（初批 get_states / 订阅推送 / 演示模式填过 entities）。
   * 大屏/编辑页首帧渲染标签前先问它，避免出现「实体 id + 无数据」的闪现。 */
  loaded() { return this.entities.size > 0; },

  on(evt, fn) { this.listeners[evt].push(fn); },
  emit(evt, data) { this.listeners[evt].forEach((f) => { try { f(data); } catch (e) { console.error(e); } }); },

  async loadConfig() {
    const r = await fetch('/api/config');
    const c = await r.json();
    this.url = (c.haUrl || '').trim();
    this.token = (c.token || '').trim();
    return c;
  },

  async saveConfig(haUrl, token) {
    const r = await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ haUrl, token }),
    });
    const c = await r.json();
    this.url = (haUrl || '').trim();
    this.token = (token || '').trim();
    this._authInvalid = false;
    return c;
  },

  wsUrl() {
    if (!this.url) return '';
    return this.url.replace(/^http/, 'ws').replace(/\/+$/, '') + '/api/websocket';
  },

  connect() {
    this.close();
    clearTimeout(this._retry);
    if (!this.url || !this.token) { this.startDemo(); return; }
    this.demo = false;
    this.setStatus('connecting');
    let ws;
    try { ws = new WebSocket(this.wsUrl()); }
    catch (e) { this.setStatus('error', '地址无效: ' + e.message); this.scheduleRetry(); return; }
    this.ws = ws;
    const failTimer = setTimeout(() => { try { ws.close(); } catch (e) {} }, 8000);

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
      } else if (msg.type === 'auth_ok') {
        clearTimeout(failTimer);
        this.connected = true;
        this.send({ type: 'subscribe_entities' }).then((r) => {
          // subscribe_entities 会先推一份全量: r.entities = { eid: {state, attributes, ...} }
          if (r && r.entities) {
            for (const [eid, st] of Object.entries(r.entities)) {
              this.entities.set(eid, this.norm(st, eid));
            }
            this.emit('change', { full: true });
          }
        }).catch(() => {
          /* 老版本 HA 没有 subscribe_entities: 退回一次性 get_states。
           * 二者不能并发——都是全量快照，晚到的旧快照会盖掉增量刚更新的实体 */
          this.send({ type: 'get_states' }).then((r) => {
            if (!Array.isArray(r.result)) return;
            r.result.forEach((s) => this.entities.set(s.entity_id, this.norm(s, s.entity_id)));
            this.emit('change', { full: true });
          }).catch(() => {});
        });
        this.setStatus('connected');
      } else if (msg.type === 'auth_invalid') {
        clearTimeout(failTimer);
        this._authInvalid = true;
        this.setStatus('error', '令牌无效，请检查长期访问令牌');
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
        if (msg.type === 'result' && !msg.success) p.reject(new Error(msg.error ? (msg.error.message || JSON.stringify(msg.error)) : '调用失败'));
        else p.resolve(msg);
      }
    };
    ws.onclose = () => {
      clearTimeout(failTimer);
      if (this.ws === ws) {
        this.ws = null; this.connected = false;
        if (this.url && this.token) { this.scheduleRetry(); }
        else if (!this.demo) { this.setStatus('disconnected'); this.startDemo(); }
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
    if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) {} this.ws = null; }
    this.connected = false;
    this.stopDemo();
  },

  /* 断线自动重连（4s），令牌无效时不重试 */
  scheduleRetry() {
    if (this._authInvalid) return;
    this.setStatus('connecting', '重连中…');
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this.connect(), 4000);
  },

  send(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('WebSocket 未连接'));
      const id = ++this.msgId;
      this.pending[id] = { resolve, reject };
      this.ws.send(JSON.stringify(Object.assign({ id }, payload)));
      setTimeout(() => { if (this.pending[id]) { delete this.pending[id]; reject(new Error('请求超时')); } }, 15000);
    });
  },

  async callService(domain, service, target) {
    if (this.demo) return this.demoCall(domain, service, target);
    return this.send({ type: 'call_service', domain, service, target: target || {} });
  },

  /* ---------------- 演示模式（未配置 HA 时可用） ---------------- */
  demoTimer: null,
  startDemo() {
    if (this.demo) return;
    this.demo = true;
    this.setStatus('demo');
    const mk = (eid, state, attrs, domain) => ({ entity_id: eid, state, attributes: Object.assign({ friendly_name: eid.split('.')[1].replace(/_/g, ' ') }, attrs), demo: true, domain });
    const demoEntities = [
      mk('light.living', 'on', { friendly_name: '客厅 吸顶灯' }, 'light'),
      mk('light.living_ambient', 'off', { friendly_name: '客厅 氛围灯' }, 'light'),
      mk('light.master', 'on', { friendly_name: '卧室 主灯' }, 'light'),
      mk('light.kitchen', 'off', { friendly_name: '厨房 灯' }, 'light'),
      mk('light.study', 'off', { friendly_name: '书房 灯' }, 'light'),
      mk('light.hall', 'on', { friendly_name: '楼道 灯' }, 'light'),
      mk('switch.ac_plug', 'on', { friendly_name: '空调插座' }, 'switch'),
      mk('switch.tv_plug', 'off', { friendly_name: '电视插座' }, 'switch'),
      mk('sensor.living_temp', '24.5', { friendly_name: '客厅 温度', unit_of_measurement: '°C' }, 'sensor'),
      mk('sensor.living_hum', '56', { friendly_name: '客厅 湿度', unit_of_measurement: '%' }, 'sensor'),
      mk('sensor.outdoor_temp', '18.2', { friendly_name: '室外 温度', unit_of_measurement: '°C' }, 'sensor'),
      mk('sensor.outdoor_hum', '62', { friendly_name: '室外 湿度', unit_of_measurement: '%' }, 'sensor'),
      mk('sensor.power', '860', { friendly_name: '全家 功率', unit_of_measurement: 'W' }, 'sensor'),
      mk('sensor.pm25', '23', { friendly_name: 'PM2.5', unit_of_measurement: 'µg/m³' }, 'sensor'),
      mk('weather.home', 'partlycloudy', { friendly_name: '天气', temperature: 18, humidity: 62 }, 'weather'),
      mk('cover.curtain_living', 'open', { friendly_name: '客厅 窗帘' }, 'cover'),
      mk('vacuum.robot', 'docked', { friendly_name: '扫地机器人' }, 'vacuum'),
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
  demoCall(domain, service, target) {
    const eid = target && target.entity_id;
    if (eid && this.entities.has(eid)) {
      const e = this.entities.get(eid);
      if (domain === 'light' || domain === 'switch' || domain === 'cover' || domain === 'fan') {
        e.state = (service === 'toggle') ? (e.state === 'on' ? 'off' : 'on') : (service === 'turn_on' || service === 'open_cover') ? 'on' : 'off';
        this.emit('change', { entity_id: eid, state: e });
      } else if (domain === 'scene') {
        // 演示: 执行"离家/睡眠"关掉所有灯，其它场景全开
        const off = /away|sleep|night/.test(eid);
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
    }
    return Promise.resolve({ demo: true });
  },

  setStatus(s, msg) { this.emit('status', { status: s, message: msg || '' }); },

  /* 工具 */
  getState(eid) { return eid ? this.entities.get(eid) : undefined; },
  isOn(eid) { const s = this.getState(eid); return s && (s.state === 'on' || (s.state !== 'off' && s.state !== 'unavailable' && s.state !== 'closed' && ['light', 'switch', 'fan'].includes((eid || '').split('.')[0]))); },
  friendly(eid) { const s = this.getState(eid); return (s && s.attributes && s.attributes.friendly_name) || (eid || '').split('.').pop(); },
  all() { return Array.from(this.entities.values()); },
  /* 单位拼接: ' °C' / ' %'（带前导空格，直接拼在 state 后面）；无单位 → '' */
  unitOf(st) {
    const u = st && st.attributes && st.attributes.unit_of_measurement;
    return u ? ' ' + u : '';
  },
  /* 「已开启」判定统一入口: 插件 click 规格（spec.isOn）优先，未声明回退 isOn()。
   * 2D 平面填色、3D 标签高亮、设备列表 on 标记共用这一套，别再各写三元。 */
  isOnOf(eid, spec) {
    if (spec && spec.isOn) return !!spec.isOn(this.getState(eid));
    return !!this.isOn(eid);
  },
};

/* 暴露到 window: 其它模块（插件引擎/实体搜索组件）用 window.HA 做特性检测 */
window.HA = HA;
