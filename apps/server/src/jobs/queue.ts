import { Queue, Worker, createBunRedisClient, type Job } from "bullmq"
import { RedisClient } from "bun"
import { eq, sql } from "drizzle-orm"
import { comments, entries, translations, user } from "@driftlog/db"
import { renderMarkdown } from "@driftlog/markdown"
import { env } from "../env"
import { db } from "../lib/db"
import { log } from "../lib/log"
import { getAiSettings, moderate, summarize } from "../lib/ai"
import { translateEntry } from "../lib/translate"
import { syncSearch } from "../lib/search"
import { scanOrphans } from "../lib/files"
import { createBackup } from "../lib/backup"
import { sendCommentMail } from "../lib/mail"
import { broadcast } from "../lib/realtime"
import { fetchLinkMeta } from "../lib/linkcard"
import { invalidate } from "../lib/redis"

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

export const translateJobId = (id: number, lang: string) => `translate-${id}-${lang}`

/** 排一个翻译任务；同一篇同一语言排队中或翻译中的不重复，已结束的先清掉 */
export async function enqueueTranslate(id: number, lang: string) {
  const jobId = translateJobId(id, lang)
  const old = await queue.getJob(jobId)
  if (old) {
    const state = await old.getState()
    if (state === "waiting" || state === "active" || state === "delayed") return
    await old.remove()
  }
  await queue.add("translate", { id, lang }, { jobId, removeOnComplete: 50 })
}

const handlers: { [N in Name]: (data: Jobs[N]) => Promise<unknown> } = {
  async "entry.saved"({ id, bodyChanged }) {
    await syncSearch(id)
    const [e] = await db.select().from(entries).where(eq(entries.id, id))
    if (!e?.published) return
    const ai = await getAiSettings()
    if (ai.summary.enabled && e.type !== "page" && (!e.summary || bodyChanged)) {
      const summary = await summarize(e.title, e.body)
      if (summary) {
        await db
          .update(entries)
          .set({ summary, updatedAt: sql`${entries.updatedAt}` })
          .where(eq(entries.id, id))
        await invalidate()
      }
    }
    if (ai.translation.enabled) {
      const rows = await db
        .select({ lang: translations.lang })
        .from(translations)
        .where(eq(translations.entryId, id))
      const have = new Set(rows.map((t) => t.lang))
      for (const lang of ai.translation.languages)
        if (bodyChanged || !have.has(lang)) await enqueueTranslate(id, lang)
    }
  },

  async "comment.created"({ id }) {
    const [c] = await db.select().from(comments).where(eq(comments.id, id))
    if (!c) return
    if (c.status === "pending") {
      const status = (await moderate(c.body, c.author))?.verdict ?? "approved"
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
    const [parent] = c.parentId ? await db.select().from(comments).where(eq(comments.id, c.parentId)) : []
    if (parent && parent.email !== c.email) await sendCommentMail(parent.email, { ...base, reply: true })
    if (ownerEmail && ownerEmail !== c.email && ownerEmail !== parent?.email)
      await sendCommentMail(ownerEmail, { ...base, reply: false })
  },

  async translate({ id, lang }) {
    const [e] = await db.select().from(entries).where(eq(entries.id, id))
    if (!e) return
    const t = await translateEntry(e.title, e.body, lang)
    const { html } = await renderMarkdown(t.body, { resolveLinkCard: fetchLinkMeta })
    const row = { title: t.title, body: t.body, html, model: t.model }
    await db
      .insert(translations)
      .values({ entryId: id, lang, ...row })
      .onConflictDoUpdate({ target: [translations.entryId, translations.lang], set: row })
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
