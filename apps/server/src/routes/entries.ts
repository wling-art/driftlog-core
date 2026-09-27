import { Elysia } from "elysia"
import { z } from "zod"
import { and, arrayContains, count, desc, eq, getTableColumns, gt, lt, sql } from "drizzle-orm"
import { categories, entries, slugRedirects, topics, translations } from "@driftlog/db"
import { entryInput, entryPatch, entryType, listQuery } from "@driftlog/schema"
import { renderMarkdown } from "@driftlog/markdown"
import { db } from "../lib/db"
import { cached, invalidate, redis } from "../lib/redis"
import { fetchLinkMeta } from "../lib/linkcard"
import { extractFileHashes, syncRefs } from "../lib/files"
import { broadcast } from "../lib/realtime"
import { enqueue } from "../jobs/queue"
import { authPlugin } from "../auth"
import { clientIp } from "./comments"

const { body: _body, legacyId: _legacyId, ...listColumns } = getTableColumns(entries)
const { html: _html, toc: _toc, ...cardColumns } = listColumns
const card = {
  ...cardColumns,
  category: { name: categories.name, slug: categories.slug },
  topic: { name: topics.name, slug: topics.slug },
}

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
    q.topic ? eq(topics.slug, q.topic) : undefined,
  )
  const base = db
    .select(card)
    .from(entries)
    .leftJoin(categories, eq(entries.categoryId, categories.id))
    .leftJoin(topics, eq(entries.topicId, topics.id))
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
      .leftJoin(topics, eq(entries.topicId, topics.id))
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
          .select({
            ...listColumns,
            category: { name: categories.name, slug: categories.slug },
            topic: { name: topics.name, slug: topics.slug, introduce: topics.introduce },
          })
          .from(entries)
          .leftJoin(categories, eq(entries.categoryId, categories.id))
          .leftJoin(topics, eq(entries.topicId, topics.id))
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
        .set({ views: sql`${entries.views} + 1`, updatedAt: sql`${entries.updatedAt}` }) // 计数不算「更新」
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
  // 归档：某一类的全部已发布条目，只要标题、slug、日期，按时间从新到旧；可按分类 / 标签筛
  // ponytail: 一次全给，几千篇以内够用；再多了改成按年份分段取
  .get(
    "/index",
    ({ query }) =>
      cached(`index:${JSON.stringify(query)}`, 600, () =>
        db
          .select({
            slug: entries.slug,
            title: entries.title,
            publishedAt: entries.publishedAt,
            // 手记时间线上那行小字：专栏 · 心情 · 天气
            mood: entries.mood,
            weather: entries.weather,
            topic: topics.name,
          })
          .from(entries)
          .leftJoin(categories, eq(entries.categoryId, categories.id))
          .leftJoin(topics, eq(entries.topicId, topics.id))
          .where(
            and(
              eq(entries.published, true),
              eq(entries.type, query.type),
              query.category ? eq(categories.slug, query.category) : undefined,
              query.topic ? eq(topics.slug, query.topic) : undefined,
              query.tag ? arrayContains(entries.tags, [query.tag]) : undefined,
            ),
          )
          .orderBy(desc(entries.publishedAt), desc(entries.id)),
      ),
    {
      query: z.object({
        type: entryType,
        category: z.string().optional(),
        tag: z.string().optional(),
        topic: z.string().optional(),
      }),
    },
  )
  // 旧地址：改过 slug 的，查到现在的 slug（前台拿到就 301 过去）
  .get(
    "/resolve",
    async ({ query, status }) => {
      const [r] = await db
        .select({ slug: entries.slug })
        .from(slugRedirects)
        .innerJoin(entries, eq(entries.id, slugRedirects.entryId))
        .where(
          and(
            eq(slugRedirects.type, query.type),
            eq(slugRedirects.oldSlug, query.slug),
            eq(entries.published, true),
          ),
        )
      return r ?? status(404, "这页走丢了")
    },
    { query: z.object({ type: entryType, slug: z.string() }) },
  )
  // 喜欢：同一个 IP 一年内只算一次
  .post(
    "/:id/like",
    async ({ params, request, server }) => {
      const ip = clientIp(request, server?.requestIP(request)?.address)
      const fresh = await redis.set(`like:${params.id}:${ip}`, "1", "EX", String(365 * 86400), "NX")
      const [e] = fresh
        ? await db
            .update(entries)
            .set({ likes: sql`${entries.likes} + 1`, updatedAt: sql`${entries.updatedAt}` })
            .where(and(eq(entries.id, params.id), eq(entries.published, true)))
            .returning({ likes: entries.likes })
        : await db.select({ likes: entries.likes }).from(entries).where(eq(entries.id, params.id))
      if (fresh) await invalidate()
      return { likes: e?.likes ?? 0, counted: Boolean(fresh) }
    },
    { params: z.object({ id: z.coerce.number().int() }) },
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
