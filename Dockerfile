# HA 3D Home — 轻量全屋智能 3D 可视化
#
# 镜像即全部内置资产：assets（模型 + 插件）直接打进镜像，升级镜像 = 升级内置资产。
# 用户数据全部走挂载卷：
#   /data           连接配置 + 户型项目 + 贴图（首启缺什么补什么，已有不动）
#   /custom         用户自定义模型与插件（结构同 assets: models/ plugins/ catalog.json），
#                   镜像只建目录，永不写入，升级/重启不丢
#
# 内置 assets/seed 是镜像内部路径（/app 内相对路径默认值）；用户可见的挂载点用简洁的 /data /custom。

# ---------- Stage 1: 静态资源压缩（css / js / json / html）----------
# 压缩工具只装在这个构建阶段，运行时镜像仍是「零 npm 依赖」的纯 Node + 静态文件。
# 只做语法级压缩、不改文件名，所以 index.html 里的 ?v=N 不用动。
# 注意：脚本是「读 public/assets → 写 /out」，不原地覆盖；本地跑也一样只写 dist-min/。
FROM node:22-alpine AS minify
WORKDIR /src
RUN npm init -y >/dev/null 2>&1 \
 && npm i --no-audit --no-fund --silent \
      terser@5.36.0 html-minifier-terser@7.2.0 clean-css@5.3.3
COPY scripts/minify-static.mjs ./scripts/
COPY public ./public
COPY assets ./assets
RUN node scripts/minify-static.mjs --out /out public assets

# ---------- Stage 2: 运行层 ----------
FROM node:22-alpine
WORKDIR /app

# 生产模式: 默认不打印任何日志（排查时 docker run -e HA3D_LOG=1 打开）
ENV NODE_ENV=production \
    PORT=8099 \
    HA3D_DATA_DIR=/data

# 零 npm 依赖: 直接拷贝源码（服务端入口 server/index.js 与 server/ 各模块）+ 压缩过的内置资产
COPY server ./server
COPY package.json ./
COPY --from=minify /out/public ./public
COPY --from=minify /out/assets ./assets
COPY deploy/seed/data ./seed/data
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data /custom

VOLUME ["/data", "/custom"]
EXPOSE 8099

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
