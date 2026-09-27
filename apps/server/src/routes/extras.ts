import { Elysia } from "elysia"
import { z } from "zod"
import { asc, count, desc, eq, sql } from "drizzle-orm"
import {
  entries,
  links,
  projects,
  says,
  siteSettings,
  thoughts,
  topics,
  type SiteSettings,
} from "@driftlog/db"
import {
  linkApplyInput,
  linkInput,
  projectInput,
  reaction,
  sayInput,
  siteSettingsInput,
  thoughtInput,
  topicInput,
} from "@driftlog/schema"
import { renderComment, renderMarkdown } from "@driftlog/markdown"
import { db } from "../lib/db"
import { cached, invalidate, rateLimit, redis } from "../lib/redis"
import { authPlugin, oauthProviders } from "../auth"
import { clientIp } from "./comments"

/*
 * 从 mx-space 带过来的功能：手记专栏、一言、动态、友链、项目、站点设置。
 * 公开接口只读（加缓存）；写接口只给站长。动态、项目的正文是 Markdown，存的时候渲染好。
 */

const idParam = z.object({ id: z.coerce.number().int() })

export const defaultSettings: SiteSettings = {
  title: "Driftlog",
  description: "一个无聊的博客",
  keywords: [],
  owner: { name: "wling", introduce: "", avatar: null, socials: {} },
}
export const getSettings = () =>
  cached(
    "site",
    600,
    async () =>
      (await db.select().from(siteSettings).where(eq(siteSettings.id, 1)))[0]?.value ?? defaultSettings,
  )

const ipOf = (request: Request, server: { requestIP(r: Request): { address: string } | null } | null) =>
  clientIp(request, server?.requestIP(request)?.address)

export const extrasRoutes = new Elysia({ tags: ["extras"] })
  .get("/site", async () => ({ ...(await getSettings()), oauth: oauthProviders }))
  .get("/topics", () =>
    cached("topics", 600, () =>
      db
        .select({
          id: topics.id,
          name: topics.name,
          slug: topics.slug,
          description: topics.description,
          introduce: topics.introduce,
          count: sql<number>`count(${entries.id}) filter (where ${entries.published})::int`,
        })
        .from(topics)
        .leftJoin(entries, eq(entries.topicId, topics.id))
        .groupBy(topics.id)
        .orderBy(asc(topics.sort), asc(topics.id)),
    ),
  )
  .get("/says", () => cached("says", 600, () => db.select().from(says).orderBy(desc(says.createdAt))))
  .get("/thoughts", () =>
    cached("thoughts", 300, () =>
      db
        .select({
          id: thoughts.id,
          html: thoughts.html,
          up: thoughts.up,
          down: thoughts.down,
          createdAt: thoughts.createdAt,
        })
        .from(thoughts)
        .orderBy(desc(thoughts.createdAt)),
    ),
  )
  // 顶 / 踩：同一个 IP 对同一条只算一次
  .post(
    "/thoughts/:id/react",
    async ({ params, body, request, server }) => {
      const fresh = await redis.set(
        `react:${params.id}:${ipOf(request, server)}`,
        body.kind,
        "EX",
        String(365 * 86400),
        "NX",
      )
      const col = body.kind === "up" ? thoughts.up : thoughts.down
      const [t] = fresh
        ? await db
            .update(thoughts)
            .set({ [body.kind]: sql`${col} + 1` })
            .where(eq(thoughts.id, params.id))
            .returning({ up: thoughts.up, down: thoughts.down })
        : await db
            .select({ up: thoughts.up, down: thoughts.down })
            .from(thoughts)
            .where(eq(thoughts.id, params.id))
      if (fresh) await invalidate()
      return { up: t?.up ?? 0, down: t?.down ?? 0, counted: Boolean(fresh) }
    },
    { params: idParam, body: z.object({ kind: reaction }) },
  )
  // 友链不分先后：缓存里是固定顺序，每次响应再洗一遍（Fisher–Yates）
  .get("/links", async () => {
    const rows = await cached("links", 600, () =>
      db
        .select({
          id: links.id,
          name: links.name,
          url: links.url,
          avatar: links.avatar,
          description: links.description,
          type: links.type,
        })
        .from(links)
        .where(eq(links.state, "approved"))
        .orderBy(asc(links.id)),
    )
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[rows[i], rows[j]] = [rows[j]!, rows[i]!]
    }
    return rows
  })
  // 申请友链：进后台待审核
  .post(
    "/links/apply",
    async ({ body, request, server, status }) => {
      if (!(await rateLimit(`link-apply:${ipOf(request, server)}`, 3, 3600)))
        return status(429, "申请太频繁了，一小时后再来")
      const [dup] = await db.select({ id: links.id }).from(links).where(eq(links.url, body.url))
      if (dup) return status(409, "这个网址已经申请过了，等站长审核就好")
      await db.insert(links).values({ ...body, type: "friend", state: "pending" })
      return { ok: true }
    },
    { body: linkApplyInput },
  )
  .get("/projects", () =>
    cached("projects", 600, () =>
      db.select(publicProject).from(projects).orderBy(asc(projects.sort), asc(projects.id)),
    ),
  )
  .use(authPlugin)
  .group("/admin", { owner: true }, (app) =>
    app
      .put(
        "/site",
        async ({ body }) => {
          await db
            .insert(siteSettings)
            .values({ id: 1, value: body })
            .onConflictDoUpdate({ target: siteSettings.id, set: { value: body } })
          await invalidate()
          return body
        },
        { body: siteSettingsInput },
      )
      // 专栏
      .get("/topics", () => db.select().from(topics).orderBy(asc(topics.sort), asc(topics.id)))
      .post("/topics", async ({ body }) => done((await db.insert(topics).values(body).returning())[0]!), {
        body: topicInput,
      })
      .patch(
        "/topics/:id",
        async ({ params, body }) =>
          done((await db.update(topics).set(body).where(eq(topics.id, params.id)).returning())[0]),
        { params: idParam, body: topicInput.partial() },
      )
      .delete(
        "/topics/:id",
        async ({ params }) => done(await db.delete(topics).where(eq(topics.id, params.id))),
        { params: idParam },
      )
      // 一言
      .get("/says", () => db.select().from(says).orderBy(desc(says.createdAt)))
      .post("/says", async ({ body }) => done((await db.insert(says).values(body).returning())[0]!), {
        body: sayInput,
      })
      .delete("/says/:id", async ({ params }) => done(await db.delete(says).where(eq(says.id, params.id))), {
        params: idParam,
      })
      // 动态
      .get("/thoughts", () => db.select().from(thoughts).orderBy(desc(thoughts.createdAt)))
      .post(
        "/thoughts",
        async ({ body }) =>
          done(
            (
              await db
                .insert(thoughts)
                .values({ ...body, html: await renderComment(body.content) })
                .returning()
            )[0]!,
          ),
        { body: thoughtInput },
      )
      .delete(
        "/thoughts/:id",
        async ({ params }) => done(await db.delete(thoughts).where(eq(thoughts.id, params.id))),
        {
          params: idParam,
        },
      )
      // 友链：列表带待审核的；审核就是改 state
      .get("/links", async () => {
        const rows = await db.select().from(links).orderBy(desc(links.createdAt))
        const [pending] = await db.select({ n: count() }).from(links).where(eq(links.state, "pending"))
        return { items: rows, pending: pending?.n ?? 0 }
      })
      .post("/links", async ({ body }) => done((await db.insert(links).values(body).returning())[0]!), {
        body: linkInput,
      })
      .patch(
        "/links/:id",
        async ({ params, body }) =>
          done((await db.update(links).set(body).where(eq(links.id, params.id)).returning())[0]),
        { params: idParam, body: linkInput.partial() },
      )
      .delete(
        "/links/:id",
        async ({ params }) => done(await db.delete(links).where(eq(links.id, params.id))),
        { params: idParam },
      )
      // 项目
      .get("/projects", () => db.select().from(projects).orderBy(asc(projects.sort), asc(projects.id)))
      .post(
        "/projects",
        async ({ body }) =>
          done(
            (
              await db
                .insert(projects)
                .values({ ...body, html: (await renderMarkdown(body.body)).html })
                .returning()
            )[0]!,
          ),
        { body: projectInput },
      )
      .patch(
        "/projects/:id",
        async ({ params, body }) => {
          const html = body.body === undefined ? undefined : (await renderMarkdown(body.body)).html
          return done(
            (
              await db
                .update(projects)
                .set({ ...body, html })
                .where(eq(projects.id, params.id))
                .returning()
            )[0],
          )
        },
        { params: idParam, body: projectInput.partial() },
      )
      .delete(
        "/projects/:id",
        async ({ params }) => done(await db.delete(projects).where(eq(projects.id, params.id))),
        {
          params: idParam,
        },
      ),
  )

const publicProject = {
  id: projects.id,
  name: projects.name,
  description: projects.description,
  avatar: projects.avatar,
  previewUrl: projects.previewUrl,
  projectUrl: projects.projectUrl,
  docUrl: projects.docUrl,
  html: projects.html,
}

/** 写完清缓存，把结果原样返回 */
async function done<T>(result: T) {
  await invalidate()
  return result
}
