// 必须是第一行，见 CLAUDE.md
import "reflect-metadata"
import * as Sentry from "@sentry/bun"
import { env } from "./env"

if (env.SENTRY_DSN) Sentry.init({ dsn: env.SENTRY_DSN, tracesSampleRate: 0.1, environment: env.NODE_ENV })

// 设了 MIGRATIONS_DIR 就先跑迁移
if (process.env.MIGRATIONS_DIR) {
  const { migrate } = await import("drizzle-orm/bun-sql/migrator")
  const { db } = await import("./lib/db")
  await migrate(db, { migrationsFolder: process.env.MIGRATIONS_DIR })
}

const { app } = await import("./app")
const { log } = await import("./lib/log")
const { startRealtime } = await import("./lib/realtime")
const { startWorker } = await import("./jobs/queue")
const { setupSearch } = await import("./lib/search")

app.listen(env.PORT)
await startRealtime(app.server!)
await setupSearch().catch((err) => log.warn({ err }, "Meilisearch 没连上，搜索先不可用"))
if (process.env.WORKER !== "off") await startWorker()
log.info(`api on ${app.server!.url} · docs ${app.server!.url}openapi`)
