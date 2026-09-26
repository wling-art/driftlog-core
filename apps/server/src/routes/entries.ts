import { Elysia } from "elysia"
import { z } from "zod"
import { and, arrayContains, count, desc, eq, getTableColumns, gt, lt, sql } from "drizzle-orm"
import { categories, entries, translations } from "@driftlog/db"
import { entryInput, entryPatch, entryType, listQuery } from "@driftlog/schema"
import { renderMarkdown } from "@driftlog/markdown"
import { db } from "../lib/db"
import { cached, invalidate } from "../lib/redis"
import { fetchLinkMeta } from "../lib/linkcard"
import { extractFileHashes, syncRefs } from "../lib/files"
import { broadcast } from "../lib/realtime"
import { enqueue } from "../jobs/queue"
import { authPlugin } from "../auth"

const { body: _body, ...listColumns } = getTableColumns(entries)
const { html: _html, toc: _toc, ...cardColumns } = listColumns
const card = { ...cardColumns, category: { name: categories.name, slug: categories.slug } }

const idParam = z.object({ id: z.coerce.number().int() })

async function render(body: string) {
  return renderMarkdown(body, { resolveLinkCard: fetchLinkMeta })
}

async function list({ page = 1, size = 10, ...q }: z.infer<typeof listQuery>, onlyPublished: boolean) {
  const where = and(
    onlyPublished ? eq(entries.published, true) : undefined,
    q.type ? eq(entries.type, q.type) : undefined,
    q.tag ? arrayContains(entries.tags, [q.tag]) : undefined,
    q.category ? eq(categories.slug, q.category) : undefined,
  )
  const base = db
    .select(card)
    .from(entries)
    .leftJoin(categories, eq(entries.categoryId, categories.id))
    .where(where)
  const [items, [total]] = await Promise.all([
    base
      .orderBy(desc(entries.pinned), desc(sql`coalesce(${entries.publishedAt}, ${entries.createdAt})`))
      .limit(size)
      .offset((page - 1) * size),
    db
      .select({ n: count() })
      .from(entries)
      .leftJoin(categories, eq(entries.categoryId, categories.id))
      .where(where),
  ])
  return { items, total: total?.n ?? 0, page, size }
}

/** 公开接口：只看已发布的 */
export const publicEntries = new Elysia({ prefix: "/entries", tags: ["entries"] })
  .get("/", ({ query }) => cached(`list:${JSON.stringify(query)}`, 300, () => list(query, true)), {
    query: listQuery,
  })
  // 类型放在 query 里：Eden 会把值为 "post" 的路径段当成 HTTP 方法
  .get(
    "/slug/:slug",
    async ({ params, query, status }) => {
      const e = await cached(`entry:${query.type}:${params.slug}:${query.lang ?? ""}`, 300, async () => {
        const [row] = await db
          .select({ ...listColumns, category: { name: categories.name, slug: categories.slug } })
          .from(entries)
          .leftJoin(categories, eq(entries.categoryId, categories.id))
          .where(
            and(eq(entries.type, query.type), eq(entries.slug, params.slug), eq(entries.published, true)),
          )
        if (!row) return null
        const at = row.publishedAt ?? row.createdAt
        const sibling = (dir: "prev" | "next") =>
          db
            .select({ slug: entries.slug, title: entries.title })
            .from(entries)
            .where(
              and(
                eq(entries.type, row.type),
                eq(entries.published, true),
                dir === "prev" ? lt(entries.publishedAt, at) : gt(entries.publishedAt, at),
              ),
            )
            .orderBy(dir === "prev" ? desc(entries.publishedAt) : entries.publishedAt)
            .limit(1)
        const [[prev], [next], langs] = await Promise.all([
          sibling("prev"),
          sibling("next"),
          db
            .select({ lang: translations.lang, title: translations.title, html: translations.html })
            .from(translations)
            .where(eq(translations.entryId, row.id)),
        ])
        const t = query.lang ? langs.find((l) => l.lang === query.lang) : undefined
        return {
          ...row,
          ...(t ? { title: t.title, html: t.html, lang: t.lang } : {}),
          languages: langs.map((l) => l.lang),
          prev: prev ?? null,
          next: next ?? null,
        }
      })
      if (!e) return status(404, "这页走丢了")
      // 阅读数不走缓存
      void db
        .update(entries)
        .set({ views: sql`${entries.views} + 1` })
        .where(eq(entries.id, e.id))
        .execute()
      return e
    },
    {
      params: z.object({ slug: z.string() }),
      query: z.object({ type: entryType.default("post"), lang: z.string().optional() }),
    },
  )
  // sitemap / RSS 用：全部已发布的
  .get("/feed", () =>
    cached("feed", 600, () =>
      db
        .select({
          id: entries.id,
          type: entries.type,
          slug: entries.slug,
          title: entries.title,
          excerpt: entries.excerpt,
          summary: entries.summary,
          html: entries.html,
          publishedAt: entries.publishedAt,
          updatedAt: entries.updatedAt,
        })
        .from(entries)
        .where(eq(entries.published, true))
        .orderBy(desc(entries.publishedAt)),
    ),
  )
  .get("/tags", () =>
    cached("tags", 600, async () => {
      const rows = await db.execute<{ tag: string; n: number }>(
        sql`select tag, count(*)::int as n from ${entries}, unnest(${entries.tags}) tag where ${entries.published} group by tag order by n desc`,
      )
      return [...rows]
    }),
  )

/** 后台接口 */
export const adminEntries = new Elysia({ prefix: "/admin/entries", tags: ["admin"] })
  .use(authPlugin)
  .guard({ owner: true })
  .get("/", ({ query }) => list(query, false), { query: listQuery })
  .get(
    "/:id",
    async ({ params, status }) => {
      const [e] = await db.select().from(entries).where(eq(entries.id, params.id))
      return e ?? status(404, "没有这篇")
    },
    { params: idParam },
  )
  .post(
    "/",
    async ({ body }) => {
      const r = await render(body.body)
      const [e] = await db
        .insert(entries)
        .values({ ...body, ...r, publishedAt: body.published ? new Date() : null })
        .returning()
      await afterSave(e!, true, false)
      return e!
    },
    { body: entryInput },
  )
  .patch(
    "/:id",
    async ({ params, body, status }) => {
      const [old] = await db.select().from(entries).where(eq(entries.id, params.id))
      if (!old) return status(404, "没有这篇")
      const bodyChanged = body.body !== undefined && body.body !== old.body
      const r = bodyChanged ? await render(body.body!) : {}
      const publishedAt = body.published && !old.publishedAt ? new Date() : old.publishedAt
      const [e] = await db
        .update(entries)
        .set({ ...body, ...r, publishedAt })
        .where(eq(entries.id, params.id))
        .returning()
      await afterSave(e!, bodyChanged, old.published)
      return e!
    },
    { params: idParam, body: entryPatch },
  )
  .delete(
    "/:id",
    async ({ params }) => {
      const [e] = await db.delete(entries).where(eq(entries.id, params.id)).returning({ id: entries.id })
      if (e) {
        await invalidate()
        await enqueue("entry.saved", { id: e.id, bodyChanged: false })
      }
      return { ok: Boolean(e) }
    },
    { params: idParam },
  )
  .post(
    "/:id/translate",
    async ({ params, body }) => {
      await enqueue("translate", { id: params.id, lang: body.lang })
      return { queued: true }
    },
    { params: idParam, body: z.object({ lang: z.string().min(2).max(10) }) },
  )
  // 编辑器实时预览也可以走服务端（带链接卡片）；后台默认在浏览器里渲染
  .post("/preview", ({ body }) => render(body.body), { body: z.object({ body: z.string() }) })

async function afterSave(e: typeof entries.$inferSelect, bodyChanged: boolean, wasPublished: boolean) {
  await syncRefs(e.id, extractFileHashes(e.body, e.cover))
  await invalidate()
  await enqueue("entry.saved", { id: e.id, bodyChanged })
  if (e.published && !wasPublished)
    await broadcast({
      type: "entry.published",
      entryId: e.id,
      entryType: e.type,
      slug: e.slug,
      title: e.title,
    })
}
