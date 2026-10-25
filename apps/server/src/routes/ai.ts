import { Elysia } from "elysia"
import { z } from "zod"
import { and, eq, inArray } from "drizzle-orm"
import { aiSettings, entries, translations, type AiSettings } from "@driftlog/db"
import { aiSettingsInput, translationInput } from "@driftlog/schema"
import { renderMarkdown } from "@driftlog/markdown"
import { authPlugin } from "../auth"
import { db } from "../lib/db"
import { getAiSettings, testModel } from "../lib/ai"
import { fetchLinkMeta } from "../lib/linkcard"
import { invalidate } from "../lib/redis"
import { enqueueTranslate, queue } from "../jobs/queue"

/** 给前台设置页看的版本：不带 apiKey，只说有没有 */
const publicSettings = (s: AiSettings) => ({
  ...s,
  providers: s.providers.map(({ apiKey, ...p }) => ({ ...p, hasKey: Boolean(apiKey) })),
})

const idLang = z.object({ id: z.coerce.number().int(), lang: z.string().min(2).max(10) })

export const aiRoutes = new Elysia({ prefix: "/admin", tags: ["ai"] })
  .use(authPlugin)
  .guard({ owner: true })
  .get("/ai", async () => publicSettings(await getAiSettings()))
  .put(
    "/ai",
    async ({ body }) => {
      const old = await getAiSettings()
      const value: AiSettings = {
        ...body,
        providers: body.providers.map((p) => ({
          ...p,
          apiKey: p.apiKey || old.providers.find((o) => o.id === p.id)?.apiKey || "",
        })),
      }
      await db
        .insert(aiSettings)
        .values({ id: 1, value })
        .onConflictDoUpdate({ target: aiSettings.id, set: { value } })
      return publicSettings(value)
    },
    { body: aiSettingsInput },
  )
  .post(
    "/ai/test",
    async ({ body, status }) => {
      const p = (await getAiSettings()).providers.find((p) => p.id === body.providerId)
      if (!p) return status(404, "没有这个供应商")
      try {
        return { ok: true, reply: await testModel(p, body.model) }
      } catch (e) {
        return { ok: false, reply: (e as Error).message.slice(0, 300) }
      }
    },
    { body: z.object({ providerId: z.string(), model: z.string() }) },
  )

  // 翻译页：每篇内容 × 每种语言的状态
  .get("/translations", async () => {
    const [ai, list, rows, waiting, active, failed] = await Promise.all([
      getAiSettings(),
      db
        .select({
          id: entries.id,
          type: entries.type,
          slug: entries.slug,
          title: entries.title,
          published: entries.published,
          updatedAt: entries.updatedAt,
        })
        .from(entries)
        .orderBy(entries.type, entries.id),
      db
        .select({
          entryId: translations.entryId,
          lang: translations.lang,
          updatedAt: translations.updatedAt,
          model: translations.model,
          editable: translations.body,
        })
        .from(translations),
      queue.getJobs(["waiting", "delayed"]),
      queue.getJobs(["active"]),
      queue.getJobs(["failed"]),
    ])
    const state: Record<string, { state: "waiting" | "active" | "failed"; error?: string }> = {}
    const mark = (jobs: typeof waiting, s: "waiting" | "active" | "failed") => {
      for (const j of jobs) {
        if (j.name !== "translate") continue
        const d = j.data as { id: number; lang: string }
        state[`${d.id}:${d.lang}`] = s === "failed" ? { state: s, error: j.failedReason } : { state: s }
      }
    }
    mark(failed, "failed")
    mark(waiting, "waiting")
    mark(active, "active")
    const langs = new Set(ai.translation.languages)
    for (const r of rows) langs.add(r.lang)
    return {
      enabled: ai.translation.enabled,
      languages: [...langs],
      items: list.map((e) => ({
        ...e,
        translations: Object.fromEntries(
          rows
            .filter((r) => r.entryId === e.id)
            .map((r) => [
              r.lang,
              {
                updatedAt: r.updatedAt,
                model: r.model,
                editable: r.editable !== "",
                stale: e.updatedAt > r.updatedAt,
              },
            ]),
        ),
        jobs: Object.fromEntries(
          [...langs].flatMap((l) => (state[`${e.id}:${l}`] ? [[l, state[`${e.id}:${l}`]]] : [])),
        ),
      })),
    }
  })
  .get(
    "/translations/:id/:lang",
    async ({ params, status }) => {
      const [t] = await db
        .select()
        .from(translations)
        .where(and(eq(translations.entryId, params.id), eq(translations.lang, params.lang)))
      if (!t) return status(404, "还没有这个译文")
      return { title: t.title, body: t.body, html: t.html, editable: t.body !== "", model: t.model }
    },
    { params: idLang },
  )
  .put(
    "/translations/:id/:lang",
    async ({ params, body }) => {
      const { html } = await renderMarkdown(body.body, { resolveLinkCard: fetchLinkMeta })
      const row = { title: body.title, body: body.body, html, model: null }
      await db
        .insert(translations)
        .values({ entryId: params.id, lang: params.lang, ...row })
        .onConflictDoUpdate({ target: [translations.entryId, translations.lang], set: row })
      await invalidate()
      return { ok: true }
    },
    { params: idLang, body: translationInput },
  )
  .delete(
    "/translations/:id/:lang",
    async ({ params }) => {
      await db
        .delete(translations)
        .where(and(eq(translations.entryId, params.id), eq(translations.lang, params.lang)))
      await invalidate()
      return { ok: true }
    },
    { params: idLang },
  )
  .post(
    "/translations/:id/:lang/run",
    async ({ params }) => {
      await enqueueTranslate(params.id, params.lang)
      return { queued: 1 }
    },
    { params: idLang },
  )
  // 把已发布内容里还没有译文的全部排上
  .post("/translations/run-missing", async () => {
    const ai = await getAiSettings()
    const [list, rows] = await Promise.all([
      db.select({ id: entries.id }).from(entries).where(eq(entries.published, true)),
      db.select({ id: translations.entryId, lang: translations.lang }).from(translations),
    ])
    const have = new Set(rows.map((r) => `${r.id}:${r.lang}`))
    let queued = 0
    for (const { id } of list)
      for (const lang of ai.translation.languages)
        if (!have.has(`${id}:${lang}`)) {
          await enqueueTranslate(id, lang)
          queued++
        }
    return { queued }
  })

  // AI 队列：翻译任务的全部状态，其他任务只看进行中和失败的
  .get("/queue", async () => {
    const jobs = await queue.getJobs(["active", "waiting", "delayed", "failed", "completed"], 0, 60)
    const ids = new Set<number>()
    for (const j of jobs) {
      const d = j.data as { id?: number }
      if (typeof d.id === "number" && j.name !== "comment.created") ids.add(d.id)
    }
    const titles = new Map(
      ids.size
        ? (
            await db
              .select({ id: entries.id, title: entries.title })
              .from(entries)
              .where(inArray(entries.id, [...ids]))
          ).map((e) => [e.id, e.title])
        : [],
    )
    const rows = await Promise.all(
      jobs.map(async (j) => {
        const state = await j.getState()
        const d = j.data as { id?: number; lang?: string }
        return {
          id: String(j.id),
          name: j.name,
          state,
          entryId: d.id ?? null,
          title: d.id ? (titles.get(d.id) ?? null) : null,
          lang: d.lang ?? null,
          attempts: j.attemptsMade,
          error: j.failedReason || null,
          createdAt: j.timestamp,
          finishedAt: j.finishedOn ?? null,
        }
      }),
    )
    return {
      counts: await queue.getJobCounts("active", "waiting", "delayed", "failed", "completed"),
      jobs: rows
        .filter((r) => r.name === "translate" || r.state === "failed" || r.state === "active")
        .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt)),
    }
  })
  .post(
    "/queue/:id/retry",
    async ({ params, status }) => {
      const j = await queue.getJob(params.id)
      if (!j) return status(404, "任务不在了")
      if ((await j.getState()) === "failed") await j.retry()
      return { ok: true }
    },
    { params: z.object({ id: z.string() }) },
  )
  .delete(
    "/queue/:id",
    async ({ params }) => {
      const j = await queue.getJob(params.id)
      if (j && (await j.getState()) !== "active") await j.remove()
      return { ok: true }
    },
    { params: z.object({ id: z.string() }) },
  )
