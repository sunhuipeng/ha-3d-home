/*
 * services/automation.js — 经 home 服务端代理访问「居控中枢」（2026-11-25 接管方案步骤 6）
 *
 * 浏览器只请求同源的 /api/automation/*，由 home 服务端转发到 automation：
 * 内网地址不出服务端，外网隧道 / 混合内容 / CORS 都不影响面板。
 * 纯 fetch 封装，零 Vue 依赖；fetch 可注入，便于 Node 单测。
 */
export const AUTOMATION_ACTIONS_URL = '/api/automation/actions';
export const automationTriggerUrl = (id) => '/api/automation/trigger/' + encodeURIComponent(String(id || ''));

function getFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') return window.fetch.bind(window);
  if (typeof fetch === 'function') return fetch.bind(globalThis);
  return null;
}

async function readJson(res, fallback) {
  try { return await res.json(); } catch (e) { return fallback; }
}

/* 展示项 SVG 图标的二次净化：automation 提交时已有 validIcon 校验，这里再挡一道
 * （project.json 是本地可编辑文件，配置源不应被无条件信任）。只放行 svg 根元素，
 * 剥掉事件属性 / script / foreignObject / image / use / javascript:。 */
export function safeSvgHtml(svg) {
  if (typeof svg !== 'string' || svg.length > 12000) return '';
  if (!/^\s*<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) return '';
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/<(image|use)\b[^>]*>/gi, '');
}

/* 编辑页候选：只读取 longRunning:false 的短脚本/场景（automation 侧过滤）。 */
export async function fetchAutomationActions(fetchImpl) {
  const f = getFetch(fetchImpl);
  if (!f) throw new Error('浏览器不支持 fetch');
  const res = await f(AUTOMATION_ACTIONS_URL, { headers: { Accept: 'application/json' } });
  const data = await readJson(res, null);
  if (!res.ok) throw new Error((data && data.error) || ('automation 返回 ' + res.status));
  return Array.isArray(data && data.items) ? data.items : [];
}

/* 展示页一次性触发：只认 automation 正式版，未发布会在服务端拿到明确错误。 */
export async function triggerAutomation(id, fetchImpl) {
  const f = getFetch(fetchImpl);
  if (!f) throw new Error('浏览器不支持 fetch');
  const res = await f(automationTriggerUrl(id), { method: 'POST', headers: { Accept: 'application/json' } });
  const data = await readJson(res, null);
  if (!res.ok) throw new Error((data && data.error) || ('automation 返回 ' + res.status));
  return data;
}
