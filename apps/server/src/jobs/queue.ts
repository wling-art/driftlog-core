import { Queue, Worker, createBunRedisClient, type Job } from "bullmq"
import { RedisClient } from "bun"
import { eq } from "drizzle-orm"
import { comments, entries, translations, user } from "@driftlog/db"
import { renderMarkdown } from "@driftlog/markdown"
import { env } from "../env"
import { db } from "../lib/db"
import { log } from "../lib/log"
import { aiEnabled, moderate, summarize, translate } from "../lib/ai"
import { syncSearch } from "../lib/search"
import { scanOrphans } from "../lib/files"
import { createBackup } from "../lib/backup"
import { sendCommentMail } from "../lib/mail"
import { broadcast } from "../lib/realtime"
import { fetchLinkMeta } from "../lib/linkcard"
import { invalidate } from "../lib/redis"

// BullMQ 用 Bun 内置的 Redis 客户端
const connection = () => createBunRedisClient(new RedisClient(env.REDIS_URL))

type Jobs = {
  "entry.saved": { id: number; bodyChanged: boolean }
  "comment.created": { id: number }
  translate: { id: number; lang: string }
  "orphan.scan": Record<string, never>
  backup: Record<string, never>
}
type Name = keyof Jobs

export const queue = new Queue<Jobs[Name], unknown, Name>("driftlog", {
  connection: connection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 200,
    removeOnFail: 500,
  },
})

export const enqueue = <N extends Name>(name: N, data: Jobs[N]) => queue.add(name, data)

const handlers: { [N in Name]: (data: Jobs[N]) => Promise<unknown> } = {
  async "entry.saved"({ id, bodyChanged }) {
    await syncSearch(id)
    const [e] = await db.select().from(entries).where(eq(entries.id, id))
    if (!aiEnabled || !e?.published || e.type === "page" || (e.summary && !bodyChanged)) return
    await db
      .update(entries)
      .set({ summary: await summarize(e.title, e.body) })
      .where(eq(entries.id, id))
    await invalidate()
  },

  async "comment.created"({ id }) {
    const [c] = await db.select().from(comments).where(eq(comments.id, id))
    if (!c) return
    if (c.status === "pending") {
      const status = aiEnabled ? (await moderate(c.body, c.author)).verdict : "approved"
      await db.update(comments).set({ status }).where(eq(comments.id, id))
      c.status = status
    }
    if (c.status !== "approved") return
    await invalidate()
    await broadcast({ type: "comment.created", entryId: c.entryId, commentId: c.id })

    const [e] = await db.select().from(entries).where(eq(entries.id, c.entryId))
    if (!e) return
    const url = `${env.BLOG_URL}/${e.type === "page" ? "" : `${e.type}s/`}${e.slug}#comment-${c.id}`
    const base = { title: e.title, author: c.author, body: c.body, url }
    const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.role, "owner"))
    const ownerEmail = env.OWNER_EMAIL ?? owner?.email
    if (c.parentId) {
      const [parent] = await db.select().from(comments).where(eq(comments.id, c.parentId))
      if (parent && parent.email !== c.email) await sendCommentMail(parent.email, { ...base, reply: true })
    }
    if (ownerEmail && ownerEmail !== c.email) await sendCommentMail(ownerEmail, { ...base, reply: false })
  },

  async translate({ id, lang }) {
    const [e] = await db.select().from(entries).where(eq(entries.id, id))
    if (!e || !aiEnabled) return
    const t = await translate(e.title, e.body, lang)
    const { html } = await renderMarkdown(t.body, { resolveLinkCard: fetchLinkMeta })
    await db
      .insert(translations)
      .values({ entryId: id, lang, title: t.title, html })
      .onConflictDoUpdate({
        target: [translations.entryId, translations.lang],
        set: { title: t.title, html },
      })
    await invalidate()
  },

  "orphan.scan": () => scanOrphans(),
  backup: () => createBackup(),
}

export async function startWorker() {
  const worker = new Worker<Jobs[Name], unknown, Name>(
    "driftlog",
    (job: Job<Jobs[Name], unknown, Name>) =>
      (handlers[job.name] as (d: Jobs[Name]) => Promise<unknown>)(job.data),
    { connection: connection(), concurrency: 4 },
  )
  worker.on("failed", (job, err) => log.error({ job: job?.name, id: job?.id, err }, "job failed"))
  await queue.upsertJobScheduler("orphan.scan", { pattern: "0 3 * * *" }, { name: "orphan.scan", data: {} })
  await queue.upsertJobScheduler("backup", { pattern: "0 4 * * *" }, { name: "backup", data: {} })
  log.info("worker ready")
  return worker
}
