/*
 * 应用版本号 —— Vite 编译期直接导入根 package.json。
 *
 * 为什么不是 './package.json' 或 '../package.json'：
 *   web/package.json 是前端子工程自己的版本（当前 1.0.0），而应用版本号的唯一出处是
 *   仓库根 ha-3d-home/package.json（当前 1.0.12，npm run push:image 会升它）。
 *   本文件位于 web/src/，因此 '../../package.json' 才是根文件。
 *
 * 相比旧的 engine/version.js：不再运行时 fetch('/api/version')、不再挂
 * MutationObserver 等异步标题节点、不再有 8s 兜底定时器 —— 两个页面的占位本来就在
 * Vue 模板里，直接绑定即可。升版后 dev 下改 package.json 会走 HMR；生产镜像由
 * Dockerfile 多阶段构建重新 build 时内联，不需要重启 8077 服务。
 *
 * 服务端 GET /api/version 仍保留（core.appVersion 实时读文件），供外部脚本/集成查询，
 * 前端不再依赖它。
 */
import { name, version } from '../../package.json';

export const APP_NAME = String(name || 'HA 3D Home');
export const APP_VERSION = String(version || '');
