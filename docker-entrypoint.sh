#!/bin/sh
# HA 3D Home 容器初始化
#   内置资产(assets)直接打进镜像，无需解压；
#   本脚本只负责用户数据:
#   1) /custom 建目录结构（永不写入内容）
#   2) /data 缺 config.json / project.json → 补默认值（已有则不动）
# 重启/升级镜像都不会动用户数据。
set -e

DATA_DIR="${HA3D_DATA_DIR:-/data}"
CUSTOM_DIR="/custom"
SEED_DIR="/app/seed"

# 日志开关: 默认打印；要静默用 -e HA3D_LOG=0（或 false）
say() {
  if [ -z "${HA3D_LOG}" ] || { [ "${HA3D_LOG}" != "0" ] && [ "${HA3D_LOG}" != "false" ]; }; then
    echo "[init] $1"
  fi
}

mkdir -p "$DATA_DIR"

# ---- 1) 用户自定义资产目录（models/ plugins/；家具走 studio 发布的家具包）----
# 只创建目录，永不写入内容 —— 这里面全是用户自己的东西，升级镜像/重启都不动
mkdir -p "$CUSTOM_DIR/models" "$CUSTOM_DIR/plugins"

# ---- 2) 默认配置与示例户型（缺什么补什么，已有则不动） ----
if [ ! -f "$DATA_DIR/config.json" ] && [ -f "$SEED_DIR/data/config.json" ]; then
  cp "$SEED_DIR/data/config.json" "$DATA_DIR/config.json"
  say "写入默认 config.json"
fi
if [ ! -f "$DATA_DIR/project.json" ] && [ -f "$SEED_DIR/data/project.json" ]; then
  cp "$SEED_DIR/data/project.json" "$DATA_DIR/project.json"
  say "写入默认 project.json（空户型骨架，floors/walls 为空，等用户在编辑器里搭）"
fi

exec "$@"
