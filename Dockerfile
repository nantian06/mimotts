# 构建阶段：安装 React / esbuild 并打包前端
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm i --no-audit --no-fund
COPY tsconfig.json ./
COPY shared ./shared
COPY server ./server
COPY scripts ./scripts
COPY web ./web
RUN npm run build

# 运行阶段：服务端零运行时依赖，只需要 Node（原生剥离类型）和 ffmpeg
FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8788 \
    HOST=0.0.0.0
VOLUME /data
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
