/* three-legacy — 统一渲染管线：拉回 three r147 legacy 观感（studio / home 共享）
 *
 * 背景：studio 与 home 都从「后端以 <script> 注入的 vendor three r147」升级到了
 * 通过 npm 安装的 three 0.160.1。0.160 的默认管线与 r147 恰好相反：
 *   · ColorManagement 开启      → new Color('#8cab68') 会做 sRGB→linear 转换
 *   · outputColorSpace = sRGB   → 渲染结果再做 linear→sRGB 编码
 *   · useLegacyLights = false   → 灯光强度不再自动 ×π（物理光照单位）
 *
 * 后果（实测）：CanvasTexture 的 colorSpace 默认是空 → 采样不解码、输出却编码，
 * 等于把画好的 sRGB 颜色「只编码不解码」→ 中间调抬高、饱和度掉一档；
 * 插件地面 #8cab68 在 0.160 默认下显示成 #b5cca6（r147 下仍是 #8cab68）。
 * 灯具 / 基础灯光的亮度也与 r147 差约 π 倍。
 *
 * 所以这里统一把管线拉回 r147 口径：同一份插件代码，
 * 「编辑页看到什么 = 大屏 / 展示页就是什么 = 重构前 r147 的观感」。
 *
 * ⚠ 升级 three 时优先检查本文件：_useLegacyLights 在 r165 已被移除，
 *   届时改用「灯光强度 ×PI」的方式补偿（LEGACY_LIGHT_SCALE）。
 */
import * as THREE from 'three';

/* 全局：颜色不再自动做色彩空间转换（r147 默认行为） */
THREE.ColorManagement.enabled = false;

/* 老口径灯光缩放（当前靠 renderer._useLegacyLights 自动生效，
 * 这里导出是给「私有字段没了」的将来兜底用） */
export const LEGACY_LIGHT_SCALE = Math.PI;

/**
 * 把渲染器切到 r147 legacy 观感：线性输出、无 tone mapping、老口径灯光。
 * 每个 new WebGLRenderer 之后都要调一次（全局单例 ColorManagement 只需模块引入一次）。
 */
export function applyLegacyRenderer(renderer) {
  if (!renderer) return renderer;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  /* 直接用内部字段：r160 的 useLegacyLights setter 会打弃用告警，
     会污染 studio 的运行时日志缓冲（studio_get_runtime 能看到一堆噪声） */
  if ('_useLegacyLights' in renderer) renderer._useLegacyLights = true;
  return renderer;
}
