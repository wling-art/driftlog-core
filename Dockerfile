# 编译成单个可执行文件，放进带 pg_dump 18 的镜像
FROM oven/bun:1 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM postgres:18
WORKDIR /app
COPY --from=build /src/apps/server/dist/driftlog-server /app/driftlog-server
COPY --from=build /src/packages/db/drizzle /app/drizzle
ENV NODE_ENV=production DATA_DIR=/data MIGRATIONS_DIR=/app/drizzle PORT=3900
# 文件和备份目录，需要挂载
RUN mkdir -p /data && chown postgres:postgres /data
VOLUME /data
EXPOSE 3900
USER postgres
ENTRYPOINT ["/app/driftlog-server"]
