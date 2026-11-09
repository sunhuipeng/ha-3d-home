#!/usr/bin/env bash
# 构建镜像并推送到内网 Docker 仓库
# 默认地址: 192.168.31.16:4000/sunhuipeng/ha-3d-home
# 每次推送自动把 package.json 的 version 递增 patch（如 1.0.0 → 1.0.1），
# 只推两个 tag：:<新版本> 与 :latest（latest 一定推）；BUMP=none 可关闭自动升版
# 发布口径: 只推 linux/arm64（默认），其它架构必须显式传参
#
# 用法（第 1 个参数是平台，第 2 个参数是版本号，可都不填）:
#   ./scripts/push-image.sh                         # 自动升版 → 只推 :<新版本> 和 :latest
#   BUMP=minor ./scripts/push-image.sh              # 升 minor（1.0.1 → 1.1.0）
#   BUMP=none ./scripts/push-image.sh               # 不升版，沿用当前 version 再推一次
#   ./scripts/push-image.sh linux/arm64 2.0.0       # 手动指定版本号（不自动升版）
#   ./scripts/push-image.sh linux/amd64             # 仅特殊需要时才用
#
# 可用环境变量覆盖: REGISTRY / NAMESPACE / IMAGE / PLATFORM / VERSION / BUMP
#
# 前置条件（换一台机器跑脚本时最容易踩）:
#   1) 内网仓库是 HTTP，Docker 必须把 <host:port> 加进 insecure-registries:
#      Docker Desktop / OrbStack → Settings → Docker Engine →
#      "insecure-registries": ["192.168.31.16:4000"] → 重启 Docker
#   2) 推送需要登录: docker login 192.168.31.16:4000（凭据存 ~/.docker/config.json）
#
# 目标机: docker pull <完整镜像名>:latest；或把 docker-compose.yml 的 build: .
#         换成 image: <完整镜像名>:latest，再 docker compose up -d
set -euo pipefail

cd "$(dirname "$0")/.."

REGISTRY="${REGISTRY:-192.168.31.16:4000}"
NAMESPACE="${NAMESPACE:-sunhuipeng}"
IMAGE="${IMAGE:-ha-3d-home}"

# 发布口径固定 arm64；需要别的架构显式传第 1 个参数或 PLATFORM 环境变量
PLATFORM="${1:-${PLATFORM:-linux/arm64}}"

# 每次推送自动升 package.json 的版本号（默认 patch: 1.0.0 → 1.0.1），
# 版本 tag 用升完后的值，并一定同时推 latest。
# BUMP=none 关闭自动升版；BUMP=minor / major 换递增位；
# 显式传第 2 个参数或 VERSION 环境变量时按指定的来，不自动升版。
export BUMP="${BUMP:-patch}"
if [ -z "${2:-}" ] && [ -z "${VERSION:-}" ] && [ "$BUMP" != "none" ]; then
  node <<'NODE'
const fs = require('fs');
const bump = process.env.BUMP || 'patch';
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
VERSION="${2:-${VERSION:-${PKG_VERSION:-dev}}}"

REMOTE="${REGISTRY}/${NAMESPACE}/${IMAGE}"
HOSTPORT="${REGISTRY%%/*}"

# 前置检查只提示、不阻断（不同 Docker 发行版的 info 输出略有差异）
if ! docker info --format '{{json .RegistryConfig.IndexConfigs}}' 2>/dev/null | grep -q "\"${HOSTPORT}\""; then
  echo "[提示] ${HOSTPORT} 未出现在 Docker 的 insecure-registries，HTTP 仓库推送可能被拒绝。"
  echo "       Docker Desktop → Settings → Docker Engine 加 \"insecure-registries\": [\"${HOSTPORT}\"] 后重启。"
fi
if [ -f "${HOME}/.docker/config.json" ] && ! grep -q "${HOSTPORT}" "${HOME}/.docker/config.json"; then
  echo "[提示] 未找到 ${HOSTPORT} 的登录信息，若推送报 unauthorized 先执行: docker login ${HOSTPORT}"
  echo
fi

# 只推两个 tag：版本 tag + 必推的 latest。
# 发布口径固定 arm64，不再加 -arm64 后缀 —— 只发一种架构时后缀没有意义，
# 反而会在仓库里留下永不更新、容易与 latest 不一致的陈旧 tag。
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
echo "确认上传: docker pull ${REMOTE}:${VERSION}（不带登录态 curl 查 tags/list 会返回 401）"
