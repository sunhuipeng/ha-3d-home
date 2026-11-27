#!/usr/bin/env bash
# 构建镜像并推送到 Docker 仓库（内网 / 公网通用执行器）。
#
# 本脚本不含任何默认值：所有发布配置必须由环境变量显式传入，缺任一项即报错退出。
# 配置集中在 package.json 的 npm scripts 里，一眼能看清推到哪里 / 什么架构 / 是否升版。
# 正常入口：
#   npm run push:image:arm64   # 内网 arm64 + 自动升 patch
#   npm run push:image:public  # 公网 CNB 多架构 + 不升版本
#
# 必需环境变量（缺一报错）:
#   REGISTRY   仓库域名，如 192.168.31.16:4000 / docker.cnb.cool
#   NAMESPACE  命名空间或仓库路径，如 sunhuipeng / sunhuipeng/ha3d-images
#   IMAGE      镜像名，如 ha-3d-home
#   PLATFORM   构建平台，如 linux/arm64 或 linux/amd64,linux/arm64
#   BUMP       版本策略: patch / minor / major / none（none = 沿用当前版本不升）
#
# 可选环境变量:
#   VERSION    显式指定版本 tag；给了就不自动升版（缺省从 package.json 读）
#   PUBLIC     1 = 公网 HTTPS 仓库（跳过 insecure-registries 提示）；缺省 0
#
# 前置条件:
#   1) 内网 HTTP 仓库需把 <REGISTRY> 加入 Docker 的 insecure-registries 并重启
#   2) 推送前 docker login <REGISTRY>（公网 CNB: docker login docker.cnb.cool -u cnb）
set -euo pipefail

cd "$(dirname "$0")/.."

# ---- 必需环境变量校验：缺任一即报错退出 ----
required=(REGISTRY NAMESPACE IMAGE PLATFORM BUMP)
missing=()
for key in "${required[@]}"; do
  if [ -z "${!key:-}" ]; then missing+=("$key"); fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "[push-image] 缺少必需环境变量: ${missing[*]}" >&2
  echo "            脚本不含默认值，请通过 package.json 的 npm run push:image:* 调用，" >&2
  echo "            或显式传入: ${required[*]}" >&2
  exit 1
fi

# PUBLIC: 行为开关（跳过内网 insecure 提示），缺省 0
PUBLIC="${PUBLIC:-0}"

# 校验 BUMP 取值
case "$BUMP" in
  patch|minor|major|none) ;;
  *) echo "[push-image] BUMP 只能是 patch/minor/major/none，收到: ${BUMP}" >&2; exit 1 ;;
esac

# ---- 版本处理 ----
# 显式 VERSION 优先；否则按 BUMP 升 package.json 的版本（none 不升）。
if [ -z "${VERSION:-}" ] && [ "$BUMP" != "none" ]; then
  node <<'NODE'
const fs = require('fs');
const bump = process.env.BUMP;
const d = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(d.version || ''));
if (!m) { console.error('[push-image] package.json 的 version 不是 x.y.z，无法自动升版'); process.exit(1); }
let a = Number(m[1]), b = Number(m[2]), c = Number(m[3]);
if (bump === 'major')      { a++; b = 0; c = 0; }
else if (bump === 'minor') { b++; c = 0; }
else                       { c++; }
d.version = `${a}.${b}.${c}`;
fs.writeFileSync('package.json', JSON.stringify(d, null, 2) + '\n');
// 有 lock 文件时同步根包版本，避免 npm ci 看到两份不一致的版本号
if (fs.existsSync('package-lock.json')) {
  try {
    const l = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
    l.version = d.version;
    if (l.packages && l.packages['']) l.packages[''].version = d.version;
    fs.writeFileSync('package-lock.json', JSON.stringify(l, null, 2) + '\n');
  } catch (e) { /* lock 格式异常不该阻断发布 */ }
}
console.log(`[push-image] package.json version -> ${d.version}${bump !== 'patch' ? ' (' + bump + ')' : ''}`);
NODE
fi

PKG_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
if [ -z "${VERSION:-}" ]; then
  if [ -z "$PKG_VERSION" ]; then
    echo "[push-image] 无法从 package.json 读取 version，且未传 VERSION" >&2
    exit 1
  fi
  VERSION="$PKG_VERSION"
fi

REMOTE="${REGISTRY}/${NAMESPACE}/${IMAGE}"
HOSTPORT="${REGISTRY%%/*}"

# 前置检查只提示、不阻断
if [ "$PUBLIC" != "1" ] && ! docker info --format '{{json .RegistryConfig.IndexConfigs}}' 2>/dev/null | grep -q "\"${HOSTPORT}\""; then
  echo "[提示] ${HOSTPORT} 未出现在 Docker 的 insecure-registries，HTTP 仓库推送可能被拒绝。"
  echo "       Docker Desktop → Settings → Docker Engine 加 \"insecure-registries\": [\"${HOSTPORT}\"] 后重启。"
fi
if [ -f "${HOME}/.docker/config.json" ] && ! grep -q "${HOSTPORT}" "${HOME}/.docker/config.json"; then
  echo "[提示] 未找到 ${HOSTPORT} 的登录信息，若推送报 unauthorized 先执行: docker login ${HOSTPORT}"
  echo
fi

# 只推两个 tag：版本 tag + 必推的 latest
TAG_LIST=("${REMOTE}:${VERSION}")
if [ "$VERSION" != "latest" ]; then TAG_LIST+=("${REMOTE}:latest"); fi
TAGS=()
for t in "${TAG_LIST[@]}"; do TAGS+=(-t "$t"); done

echo "==> 构建并推送 ${IMAGE} (${PLATFORM}, version=${VERSION})"
for t in "${TAG_LIST[@]}"; do echo "    ${t}"; done
docker buildx build --platform "$PLATFORM" "${TAGS[@]}" --push .

echo
echo "==> 完成，已推送以下 tag:"
for t in "${TAG_LIST[@]}"; do echo "    ${t}"; done
echo
echo "目标机拉取（始终最新）: docker pull ${REMOTE}:latest"
echo "固定版本: docker pull ${REMOTE}:${VERSION}"
echo "公开仓库可在未登录环境验证: docker pull ${REMOTE}:${VERSION}"
