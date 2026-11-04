#!/usr/bin/env bash
# 离线打包镜像：构建 → 导出单个 tar（不依赖任何镜像仓库）
#
# 用法:
#   ./scripts/pack-image.sh                  # 目标平台默认取本机架构
#   ./scripts/pack-image.sh linux/amd64      # Apple Silicon 上给 x86 服务器打包
#   ./scripts/pack-image.sh linux/arm64      # 给 ARM 服务器 / NAS / 树莓派打包
#
# 产物: dist/ha-3d-home-<version>-<arch>.tar
# 目标机: docker load -i <tar> 然后按 README 的 compose 方式起容器
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="ha-3d-home"
VERSION=latest

# 本机架构 → Docker 平台名
case "$(uname -m)" in
  x86_64|amd64)  LOCAL_ARCH="amd64" ;;
  arm64|aarch64) LOCAL_ARCH="arm64" ;;
  *)             LOCAL_ARCH="$(uname -m)" ;;
esac
PLATFORM="${1:-linux/$LOCAL_ARCH}"
ARCH="${PLATFORM##*/}"

TAG="${IMAGE}:${VERSION}"
OUT="dist/${IMAGE}-${VERSION}-${ARCH}.tar"

mkdir -p dist
rm -f "$OUT"

echo "==> 构建 ${TAG} (${PLATFORM})"
docker buildx build --platform "$PLATFORM" -t "$TAG" --load .

echo "==> 导出 ${OUT}"
docker save "$TAG" -o "$OUT"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "==> 完成: ${OUT} (${SIZE})"
echo
echo "拷到目标机后执行:"
echo "  docker load -i $(basename "$OUT")"
echo "  docker images | grep ${IMAGE}"
