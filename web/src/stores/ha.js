/*
 * stores/ha.js — Home Assistant 连接状态的全局响应式层（Pinia）
 *
 * 分工（重要）：
 *   services/ha.js 是「传输客户端」——WebSocket、pending Promise、8s 握手超时、
 *   退避重连与回前台立即恢复、ping 心跳、3s 演示定时器、subscribe_entities 增量协议解析、
 *   entities Map。这些都是非 Vue 的协议状态机，engine/editor.js / view3d.js / plugins.js 在绘制
 *   循环里每帧同步调 HA.getState()，必须保持「不依赖 Pinia 实例」的普通对象。
 *
 *   本 store 只持有「UI 真正需要的响应式投影」：状态、配置镜像、实体版本与数量。
 *   绝不把 ws / Map / 定时器放进 state（Proxy 会破坏对象身份，645 实体高频推送
 *   还会引爆依赖追踪）。数据变化由 bridge.js 的 installHaBridge() 在事件边界推入。
 *
 * 单一真相：以前 status / config / entVersion 散在 editor store 里当镜像，
 * 两页各自 HA.on('status') 注册、ConnModal 又读 window.HA.url，三份口径。
 * 现在统一到这里；editor store 那几个同名成员只留薄代理，供未迁移的调用点过渡。
 *
 * window.HA 桥接必须保留：plugins.js 有 5 处 window.HA 特性检测，运行时注入的
 * 第三方插件也不在构建图里。这里只是把「UI 状态」从桥接上摘下来。
 */
import { defineStore } from 'pinia';

export const useHaStore = defineStore('ha', {
  state: () => ({
    haStatus: { status: 'connecting' },
    entityVersion: 0,          // HA 推送计数，HUD / 实体列表的重算信号
    entityCount: 0,
    /* 服务端 data/config.json 的响应式镜像（令牌不下发，只有 haUrl 与 hasToken；
     * 本镜像仅在编辑页「连接与服务」弹窗打开时通过 loadConfig 刷新） */
    haUrl: '',
    haHasToken: false,
    haCfgError: '',
  }),

  getters: {
    haUrlText: (s) => (s.haCfgError ? '读取失败' : (s.haUrl || '未配置')),
    connClass: (s) => {
      const st = s.haStatus.status;
      return { on: st === 'connected', err: st === 'demo' || st === 'error' || st === 'disconnected' };
    },
    connText: (s) => {
      const st = s.haStatus.status;
      if (st === 'connected') return 'HA 已连接';
      if (st === 'demo') return '演示模式';
      if (st === 'connecting') return s.haStatus.message || '连接中…';
      if (st === 'error') return s.haStatus.message || '连接失败';
      return '未连接';
    },
  },

  actions: {
    setHaStatus(s) {
      this.haStatus = s || { status: 'connecting' };
    },
    /* HA 每次 change（全量快照 / 增量 / 演示波动）都只递增版本号，不复制实体。 */
    applyChange() {
      this.entityVersion++;
      this.entityCount = (typeof window !== 'undefined' && window.HA) ? window.HA.all().length : 0;
    },
    applyHaConfig(c) {
      this.haUrl = (c && c.haUrl) || '';
      this.haHasToken = !!(c && c.hasToken);
      this.haCfgError = '';
    },
    /* 读取失败保留上一次成功镜像，只标记错误，不把表单清空。 */
    setHaCfgError(msg) { this.haCfgError = msg || ''; },

    /* 下面三个 Action 是连接层门面：网络/WS 仍由 services/ha.js 执行，
     * 但结果一律回写本 store，组件不再自己读 window.HA.url / token。 */
    /* 「读服务端配置」入口：只有编辑页「连接与服务」弹窗打开时调用
     * （ConnModal.reloadConfig）。展示页 / 编辑页启动序列都不请求 /api/config
     * —— HA 连接直接开 WS，未配置由服务端关闭码 4400 告知（进演示模式）。
     * 失败不抛错 —— 保留上一次成功镜像、只标记错误。 */
    async loadConfig() {
      try {
        const c = await window.HA.loadConfig();
        this.applyHaConfig({ haUrl: c.haUrl, hasToken: c.hasToken });
        return c;
      } catch (e) {
        this.setHaCfgError('读取失败: ' + ((e && e.message) || e));
        this.setHaStatus({ status: 'error', message: '读取连接配置失败' });
        return null;
      }
    },
    async saveConfig(haUrl, token) {
      /* 令牌只写不读：POST 后回读一次服务端镜像（haUrl / hasToken，无令牌内容） */
      const c = await window.HA.saveConfig(haUrl, token);
      await this.loadConfig();
      return c;
    },
    connect() { if (typeof window !== 'undefined' && window.HA) window.HA.connect(); },
  },
});
