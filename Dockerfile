# 多阶段构建：client 构建 → server 构建 → 运行镜像
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --workspaces --include-workspace-root
COPY server server
COPY client client
# 生产用 Postgres schema 生成 Prisma Client
RUN npm run db:generate:prod -w server
RUN npm run build -w client && npm run build -w server
# 运行镜像只留生产依赖（prisma CLI 已移到 dependencies：启动前要用它 db push 建表）
RUN npm prune --omit=dev --workspaces --include-workspace-root
# prune 可能清掉 node_modules/.prisma（generate 产物），在裁剪后的树上重新生成
RUN npm run db:generate:prod -w server

FROM node:22-alpine
WORKDIR /app
# Prisma 引擎在 alpine 上加载需要 openssl
RUN apk add --no-cache openssl
ENV NODE_ENV=production
# npm workspaces 把依赖提升到根 node_modules，必须复制根目录（server/node_modules 是空的）
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/prisma server/prisma
COPY --from=build /app/client/dist client/dist
EXPOSE 8080
# 首次启动把 Postgres schema 推到库（仓库不含迁移文件，migrate deploy 必失败）。
# 注意：schema 漂移时 db push 会交互式询问，非交互环境直接失败——届时手工进容器执行
CMD ["sh", "-c", "npx prisma db push --schema server/prisma/schema.postgres.prisma --skip-generate && node server/dist/index.js"]
