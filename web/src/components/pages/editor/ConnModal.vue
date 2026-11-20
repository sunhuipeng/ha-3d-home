<template>
  <div id="connModal" class="modal" v-show="open">
    <div class="modal-box">
      <div class="modal-head"><div><div class="modal-sub">家庭中心</div><h2>连接与服务</h2></div><button class="close" @click="$emit('close')">×</button></div>
      <div class="conn-card">
        <div class="conn-ic">📶</div>
        <div><div class="conn-t">HOME ASSISTANT</div><div class="conn-s" :class="status.status === 'connected' ? 'ok' : 'bad'">{{ connStateText }}</div></div>
      </div>
      <div class="form">
        <label>Home Assistant 地址</label>
        <input v-model="inHaUrl" placeholder="http://homeassistant.local:8123">
        <label>API Key / 长期访问令牌</label>
        <textarea v-model="inToken" rows="4"
          :placeholder="hasToken ? '已配置（输入新值可更换，留空保持不变）' : '粘贴 Home Assistant 长期访问令牌（用户头像 → 安全 → 长期访问令牌）'"></textarea>
        <div class="tip">🔒 令牌只保存在服务端、不再下发浏览器（HA 连接全部经服务端代理），留空即保持已配置令牌不变。</div>
        <div class="form-row">
          <button class="tb-btn primary" @click="saveConn">保存并连接</button>
          <button class="tb-btn" @click="testConn">测试</button>
        </div>
        <div class="conn-msg" :class="connMsgOk ? 'ok' : 'err'" v-if="connMsg">{{ connMsg }}</div>
        <div class="conn-msg err" v-if="!connMsg && cfgError">{{ cfgError }}</div>
      </div>
      <div class="conn-info">
        <div class="r"><span>运行模式</span><b>独立部署 (Docker)</b></div>
        <div class="r"><span>地址</span><b>{{ haUrlText }}</b></div>
        <div class="r"><span>令牌</span><b>{{ hasToken ? '已配置（仅服务端持有）' : '未配置' }}</b></div>
        <div class="r"><span>实体</span><b>{{ entityCount }}</b></div>
        <div class="r"><span>实时通道</span><b>服务端代理 WebSocket</b></div>
      </div>
    </div>
  </div>
</template>

<script>
/*
 * ConnModal — 连接与服务弹窗，批次 1 从 App.vue 拆出，零 props。
 *
 * 已完全 Pinia 化：状态与动作全部走 stores/ha.js，本组件不再直接碰 window.HA。
 *   - haStatus / haUrl / hasToken / cfgError / haUrlText / entityCount
 *     都是 ha store 的响应式 state/getter（entityCount 由 installHaBridge 在
 *     HA change 事件边界写入，不再需要 `void version` 手动触发重算）；
 *   - loadConfig / saveConfig / connect / applyHaConfig / setHaCfgError 都是 Action，
 *     内部统一以服务端 /api/config 的权威结果回写 store。
 * services/ha.js 是 WebSocket 传输客户端，只被本 store 的 Action 与引擎内部调用。
 *
 * 2026-11-19：/api/config 全项目只在「本弹窗打开」时请求（watch open → reloadConfig），
 * 展示页 / 编辑页启动序列都不请求。令牌不再下发浏览器（GET 只回 haUrl / hasToken），
 * 输入框是「只写」语义：留空 = 保持服务端已配置令牌不变，输入新值 = 更换。
 *
 * emits: close
 */
import { mapState, mapActions } from 'pinia';
import { useUiStore } from '../../../stores/ui';
import { useHaStore } from '../../../stores/ha';

export default {
  name: 'ConnModal',
  emits: ['close'],
  data() {
    return { inHaUrl: '', inToken: '', connMsg: '', connMsgOk: false };
  },
  computed: {
    ...mapState(useUiStore, { open: 'connOpen' }),
    ...mapState(useHaStore, {
      status: 'haStatus',
      haUrl: 'haUrl', hasToken: 'haHasToken',
      cfgError: 'haCfgError', entityCount: 'entityCount',
    }),
    ...mapState(useHaStore, ['haUrlText']),
    connStateText() {
      const s = this.status.status;
      if (s === 'connected') return '已连接 · 设备状态正在实时同步';
      if (s === 'demo') return '演示模式（未配置 Home Assistant）';
      /* connecting 会持续很久（8s 握手超时 + 4s 重连），要带上服务端给出的
       * message（如「重连中…」），否则用户只看到含糊的「正在连接…」。 */
      if (s === 'connecting') return this.status.message || '正在连接…';
      return this.status.message || '未连接';
    },
  },
  watch: {
    open(v) {
      if (!v) return;
      this.reloadConfig();
    },
  },
  methods: {
    ...mapActions(useHaStore, ['loadConfig', 'saveConfig', 'connect', 'setHaCfgError']),
    /* 每次打开都从服务端拉一次（全项目唯一的 /api/config 读取点）。
     * 令牌不下发：输入框保持只写语义，已配置时显示占位提示而非明文。 */
    async reloadConfig() {
      this.connMsg = '';
      try {
        const c = await this.loadConfig();
        this.inHaUrl = c.haUrl || '';
        this.inToken = '';
      } catch (e) {
        this.setHaCfgError('读取服务端配置失败: ' + (e.message || e));
        this.inHaUrl = this.haUrl || '';
        this.inToken = '';
      }
    },
    async saveConn() {
      this.connMsg = '保存中…'; this.connMsgOk = true;
      try {
        const r = await this.saveConfig(this.inHaUrl, this.inToken);
        /* 保存后服务端保留未填字段（空令牌回退旧值）；镜像已由 saveConfig 回读刷新，
           这里只清空只写输入框，回显交给 hasToken 徽标与占位提示。 */
        this.inHaUrl = this.haUrl || '';
        this.inToken = '';
        if (r.test && r.test.ok) { this.connMsg = '已保存 · HA 连接成功 (v' + (r.test.version || '?') + ')'; this.connMsgOk = true; }
        else if (r.test && !r.test.ok) { this.connMsg = '已保存，但测试失败: ' + r.test.error; this.connMsgOk = false; }
        else { this.connMsg = '已保存'; this.connMsgOk = true; }
        this.connect();
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
  },
};
</script>
