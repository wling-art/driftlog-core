import { Elysia } from "elysia"
import { z } from "zod"
import { asc, count, eq, sql } from "drizzle-orm"
import { categories, entries } from "@driftlog/db"
import { categoryInput, patchOf, reorderInput } from "@driftlog/schema"
import { db } from "../lib/db"
import { cached, invalidate } from "../lib/redis"
import { authPlugin } from "../auth"

// 公开的只数已发布的
const all = (onlyPublished: boolean) =>
  db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      description: categories.description,
      sort: categories.sort,
      count: onlyPublished
        ? sql<number>`count(${entries.id}) filter (where ${entries.published})::int`
        : count(entries.id),
    })
    .from(categories)
    .leftJoin(entries, eq(entries.categoryId, categories.id))
    .groupBy(categories.id)
    .orderBy(asc(categories.sort), asc(categories.id))

const idParam = z.object({ id: z.coerce.number().int() })

export const categoryRoutes = new Elysia({ tags: ["categories"] })
  .get("/categories", () => cached("categories", 600, () => all(true)))
  .use(authPlugin)
  .group("/admin/categories", { owner: true }, (app) =>
    app
      .get("/", () => all(false))
      .post(
        "/",
        async ({ body }) => {
          const [c] = await db.insert(categories).values(body).returning()
          await invalidate()
          return c!
        },
        { body: categoryInput },
      )
      .patch(
        "/:id",
        async ({ params, body }) => {
          const [c] = await db.update(categories).set(body).where(eq(categories.id, params.id)).returning()
          await invalidate()
          return c
        },
        { params: idParam, body: patchOf(categoryInput) },
      )
      .delete(
        "/:id",
        async ({ params }) => {
          await db.delete(categories).where(eq(categories.id, params.id))
          await invalidate()
          return { ok: true }
        },
        { params: idParam },
      )
      // 按传入顺序写 sort
      .put(
        "/order",
        async ({ body }) => {
          await db.transaction(async (tx) => {
            for (const [sort, id] of body.ids.entries())
              await tx.update(categories).set({ sort }).where(eq(categories.id, id))
          })
          await invalidate()
          return { ok: true }
        },
        { body: reorderInput },
      ),
  )
