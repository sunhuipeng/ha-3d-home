# HA 3D Home — 轻量全屋智能 3D 可视化
#
# 镜像即全部内置资产：assets（模型 + 插件）直接打进镜像，升级镜像 = 升级内置资产。
# 用户数据全部走挂载卷：
#   /data           连接配置 + 户型项目 + 贴图（首启缺什么补什么，已有不动）
#   /custom         用户自定义模型与插件（结构同 assets: models/ plugins/ catalog.json），
#                   镜像只建目录，永不写入，升级/重启不丢
#
# 前端构建：web/ 用 Vite 打包，产物（index.html / display.html / 资源）落到镜像的 public/，
# 由后端 serveStatic 的 PUBLIC_DIR 默认根托管。bundle 资源目录改名为 public，
# 与数据目录 /assets/、/custom/ 不冲突（serveStatic 只对这两个前缀走特殊根目录，其余都回
# PUBLIC_DIR 根查找，所以 /public/*.js 会命中 /app/public/public/*，功能正常，只是镜像里多一层
# 嵌套）。vite.config.js 不改，只在构建命令里传 --assetsDir public，前端默认 base 仍是 /，
# dev 不受影响。

# ---------- Stage 1: 前端构建 ----------
FROM node:22-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# bundle 资源目录改为 public，不与数据目录 /assets/、/custom/ 冲突（不改 vite.config.js）
RUN npm run build -- --assetsDir static

# ---------- Stage 2: 运行层 ----------
FROM node:22-alpine
WORKDIR /app

# 生产模式: 默认不打印任何日志（排查时 docker run -e HA3D_LOG=1 打开）
ENV NODE_ENV=production \
    PORT=8099 \
    HA3D_DATA_DIR=/data

# 服务端入口 server/ 与各模块；express 是唯一生产依赖
COPY server ./server
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 前端构建产物 → public/（后端以 PUBLIC_DIR 为默认根托管；
# 资源在 /public/ 下，不与数据目录 /assets/、/custom/ 冲突，也不会覆盖内置资产）
COPY --from=web-build /web/dist ./public

# 内置数据资产（模型 + 插件 + catalog）：直接打进镜像，升级镜像即升级资产
COPY assets ./assets

# 默认数据种子（config.json / project.json）
COPY deploy/seed/data ./seed/data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data /custom

VOLUME ["/data", "/custom"]
EXPOSE 8099

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
