import { Elysia } from "elysia"
import { z } from "zod"
import { and, asc, count, desc, eq } from "drizzle-orm"
import { comments, entries } from "@driftlog/db"
import { commentInput, commentStatus } from "@driftlog/schema"
import { renderComment } from "@driftlog/markdown"
import { db } from "../lib/db"
import { cached, invalidate, rateLimit } from "../lib/redis"
import { enqueue } from "../jobs/queue"
import { authPlugin } from "../auth"

// Gravatar 头像（SHA-256），没有头像时返回 404
const gravatar = (email: string) =>
  `https://gravatar.com/avatar/${new Bun.CryptoHasher("sha256").update(email.trim().toLowerCase()).digest("hex")}?d=404&s=80`

// 公开字段，不含邮箱和 IP
const publicComment = (c: typeof comments.$inferSelect) => ({
  id: c.id,
  parentId: c.parentId,
  author: c.author,
  url: c.url,
  html: c.html,
  avatar: c.avatar ?? gravatar(c.email),
  createdAt: c.createdAt,
})

export const clientIp = (
  request: Request,
  server: { requestIP(r: Request): { address: string } | null } | null,
) =>
  request.headers.get("cf-connecting-ip") ??
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  server?.requestIP(request)?.address ??
  "unknown"

const idParam = z.object({ id: z.coerce.number().int() })

export const commentRoutes = new Elysia({ tags: ["comments"] })
  .use(authPlugin)
  .get(
    "/comments",
    ({ query }) =>
      cached(`comments:${query.entryId}`, 120, async () =>
        (
          await db
            .select()
            .from(comments)
            // 不含悄悄话
            .where(
              and(
                eq(comments.entryId, query.entryId),
                eq(comments.status, "approved"),
                eq(comments.private, false),
              ),
            )
            .orderBy(asc(comments.createdAt))
        ).map(publicComment),
      ),
    { query: z.object({ entryId: z.coerce.number().int() }) },
  )
  .post(
    "/comments",
    async ({ body, user, request, server, status }) => {
      const ip = clientIp(request, server)
      if (!(await rateLimit(`comment:${ip}`, 5, 60))) return status(429, "评论太快了，歇一分钟再来")
      const [e] = await db
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, body.entryId), eq(entries.published, true)))
      if (!e) return status(404, "这篇文章不存在")
      if (body.parentId) {
        const [p] = await db
          .select({ entryId: comments.entryId })
          .from(comments)
          .where(eq(comments.id, body.parentId))
        if (p?.entryId !== body.entryId) return status(400, "回复的评论不在这篇文章下")
      }
      const isOwner = user?.role === "owner"
      const [c] = await db
        .insert(comments)
        .values({
          ...body,
          author: user?.name ?? body.author,
          email: user?.email ?? body.email,
          userId: user?.id ?? null,
          avatar: user?.image ?? null,
          html: await renderComment(body.body),
          status: isOwner ? "approved" : "pending",
          ip,
          userAgent: request.headers.get("user-agent"),
        })
        .returning()
      await enqueue("comment.created", { id: c!.id })
      return { ...publicComment(c!), status: c!.status }
    },
    { session: true, body: commentInput },
  )
  .group("/admin/comments", { owner: true }, (app) =>
    app
      .get(
        "/",
        async ({ query }) => {
          const where = query.status ? eq(comments.status, query.status) : undefined
          const [items, [total]] = await Promise.all([
            db
              .select({
                comment: comments,
                entry: { title: entries.title, slug: entries.slug, type: entries.type },
              })
              .from(comments)
              .innerJoin(entries, eq(entries.id, comments.entryId))
              .where(where)
              .orderBy(desc(comments.createdAt))
              .limit(query.size)
              .offset((query.page - 1) * query.size),
            db.select({ n: count() }).from(comments).where(where),
          ])
          return {
            items: items.map((r) => ({
              ...r.comment,
              avatar: r.comment.avatar ?? gravatar(r.comment.email),
              entry: r.entry,
            })),
            total: total?.n ?? 0,
          }
        },
        {
          query: z.object({
            status: commentStatus.optional(),
            page: z.coerce.number().int().min(1).default(1),
            size: z.coerce.number().int().min(1).max(100).default(20),
          }),
        },
      )
      .patch(
        "/:id",
        async ({ params, body }) => {
          const [c] = await db.update(comments).set(body).where(eq(comments.id, params.id)).returning()
          if (c?.status === "approved") await enqueue("comment.created", { id: c.id })
          await invalidate()
          return c
        },
        { params: idParam, body: z.object({ status: commentStatus }) },
      )
      .delete(
        "/:id",
        async ({ params }) => {
          await db.delete(comments).where(eq(comments.id, params.id))
          await invalidate()
          return { ok: true }
        },
        { params: idParam },
      ),
  )
