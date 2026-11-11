<template>
  <div id="importModal" class="modal" v-show="open" @dragover.prevent @drop.prevent>
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
</template>

<script>
/*
 * ImportModal — 插件 / 家具包导入弹窗，批次 1 从 App.vue 拆出。
 *
 * 整条链路自包含：拖拽/点选 → POST /api/plugins/import → 成功后刷新页面；
 * 顺带管理安装密钥的读取 / 生成 / 复制。这些状态过去全堆在根组件 data 里，
 * 实际上只服务这一个弹窗，因此连同 open 时的重置一起搬入。
 *
 * 注意：成功后仍用 location.reload() 让插件引擎重新拉清单（与重构前一致）。
 *
 * emits: close（导入进行中不允许关闭）
 */
import { mapState } from 'pinia';
import { useUiStore } from '../../../stores/ui';

export default {
  name: 'ImportModal',
  /* open 从 ui store 的 importOpen 直读，watch open 仍然可用（computed 可被 watch）。 */
  computed: {
    ...mapState(useUiStore, { open: 'importOpen' }),
  },
  emits: ['close'],
  data() {
    return {
      importDrag: false,
      importing: false,
      importFile: null,
      importMsg: '',
      importMsgOk: true,
      keyTail: '',
      keyLocked: false,
      keyValue: '',
      keyBusy: false,
      keyCopied: false,
    };
  },
  watch: {
    open(v) { if (v) this.reset(); },
  },
  methods: {
    reset() {
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
    closeImport() { if (!this.importing) this.$emit('close'); },
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
        setTimeout(() => location.reload(), 900);
      } catch (err) {
        this.importMsg = '导入失败: ' + err.message;
        this.importMsgOk = false;
        this.importing = false;
        this.importFile = null;
      }
    },
  },
};
</script>
