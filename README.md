# driftlog-core

Driftlog 的服务端和共享包。前台和后台在 [driftlog-web](../web)。结构参考 [mx-space/core](https://github.com/mx-space/core)。

```
apps/server         Elysia API（Better Auth、BullMQ、Meilisearch、WebSocket、文件、备份）
packages/schema     Zod 4 schema：服务端校验、OpenAPI、前台 / 后台表单共用
packages/db         Drizzle 表结构与迁移（bun-sql 驱动）
packages/markdown   unified 渲染管线 + 自定义 micromark 语法
packages/client     Eden Treaty 客户端（给 web 用）
```

## 本地开发

需要 PostgreSQL 18、Valkey / Redis、Meilisearch。

```bash
cp .env.example .env
bun install
bun run db:migrate
bun run dev              # http://localhost:3900 · 文档 /openapi
```

第一个用邮箱注册的人是站长，之后邮箱注册关闭，读者用 GitHub / Google 登录评论。

```bash
curl -X POST localhost:3900/api/auth/sign-up/email -H 'content-type: application/json' \
  -H 'origin: http://localhost:5174' -d '{"email":"me@example.com","password":"…","name":"我"}'
```

## 检查

```bash
bun run typecheck   # tsgo
bun run lint        # oxlint
bun run fmt         # oxfmt
bun test
```

## 部署

`bun run build` 编译成单个可执行文件 `apps/server/dist/driftlog-server`。容器：

```bash
docker compose up -d   # api + postgres 18 + valkey + meilisearch，/data 卷放文件和备份
```

容器启动时自动跑迁移。前面挂 Cloudflare：`/files/*` 按内容哈希命名，响应头是 `immutable`，可以永久缓存。

## Markdown 扩展语法

| 写法                                  | 效果                                         |
| ------------------------------------- | -------------------------------------------- |
| `\|\|剧透\|\|` `==标记==` `++插入++`  | 剧透 / 高亮 / 插入                           |
| `{GH@user}` `{TW@user}` `{TG@user}`   | 提及                                         |
| `:::banner{type=warning}` … `:::`     | 横幅：info / warning / error / success       |
| `:::details[标题]` … `:::`            | 折叠                                         |
| `:::grid{cols=3}` / `:::gallery`      | 网格 / 画廊                                  |
| `::link-card{url="https://…"}`        | 链接卡片（服务端用 HTMLRewriter 抓 og 信息） |
| `::video{src=…}` `::bilibili{bv=BV…}` | 白名单组件，其他 `::name` 显示为「不支持」   |
| `$…$` / `$$…$$`                       | KaTeX                                        |
| ` ```mermaid `                        | 前台按需加载 Mermaid                         |

评论只开行内语法，并经过 rehype-sanitize。

## 可选功能

填了环境变量才开：`AI_MODEL` + `AI_GATEWAY_API_KEY`（摘要、翻译、评论审核）、`RESEND_API_KEY`（评论邮件）、`SENTRY_DSN`、`STORAGE=s3`。

## 许可证

双重授权：开源部分采用 [AGPL-3.0](LICENSE)；需要闭源或商用授权时见 [商业授权](COMMERCIAL.md)。
