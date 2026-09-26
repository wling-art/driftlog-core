import { Elysia } from "elysia"
import { z } from "zod"
import { count, desc, eq, gte, sql } from "drizzle-orm"
import { comments, entries, files } from "@driftlog/db"
import { db } from "../lib/db"
import { backupFile, listBackups } from "../lib/backup"
import { aiEnabled } from "../lib/ai"
import { enqueue, queue } from "../jobs/queue"
import { authPlugin } from "../auth"

export const adminRoutes = new Elysia({ prefix: "/admin", tags: ["admin"] })
  .use(authPlugin)
  .guard({ owner: true })
  .get("/me", ({ user }) => user)
  .get("/stats", async () => {
    const since = new Date(Date.now() - 30 * 86400_000)
    const [byType, [pending], [fileStats], daily, top] = await Promise.all([
      db
        .select({
          type: entries.type,
          n: count(),
          views: sql<number>`coalesce(sum(${entries.views}), 0)::int`,
        })
        .from(entries)
        .groupBy(entries.type),
      db.select({ n: count() }).from(comments).where(eq(comments.status, "pending")),
      db.select({ n: count(), bytes: sql<number>`coalesce(sum(${files.size}), 0)::bigint` }).from(files),
      db
        .select({ day: sql<string>`to_char(${comments.createdAt}, 'YYYY-MM-DD')`, n: count() })
        .from(comments)
        .where(gte(comments.createdAt, since))
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      db
        .select({ id: entries.id, title: entries.title, views: entries.views, type: entries.type })
        .from(entries)
        .orderBy(desc(entries.views))
        .limit(5),
    ])
    return {
      byType,
      pendingComments: pending?.n ?? 0,
      files: { count: fileStats?.n ?? 0, bytes: Number(fileStats?.bytes ?? 0) },
      daily,
      top,
      aiEnabled,
    }
  })
  .get("/backups", () => listBackups())
  .post("/backups", async () => {
    const job = await enqueue("backup", {})
    return { queued: job.id }
  })
  .get(
    "/backups/:name",
    ({ params, status }) => {
      const f = backupFile(params.name)
      return f
        ? new Response(f, { headers: { "content-disposition": `attachment; filename="${params.name}"` } })
        : status(404)
    },
    { params: z.object({ name: z.string() }) },
  )
  .get("/jobs", async () => queue.getJobCounts("active", "waiting", "failed", "completed", "delayed"))
