import { Elysia, t } from "elysia"
import { z } from "zod"
import { count, desc, eq, isNotNull } from "drizzle-orm"
import { fileRefs, files } from "@driftlog/db"
import { db } from "../lib/db"
import { acceptedTypes, deleteFile, publicFile, purgeOrphans, saveUpload, MAX_UPLOAD } from "../lib/files"
import { storage } from "../lib/storage"
import { rateLimit } from "../lib/redis"
import { authPlugin } from "../auth"
import { env } from "../env"

const idParam = z.object({ id: z.coerce.number().int() })

export const fileRoutes = new Elysia({ tags: ["files"] })
  // 本地存储的文件，按内容哈希命名，永久缓存
  .get("/files/*", async ({ params, status }) => {
    if (env.STORAGE !== "local") return status(404)
    const f = storage.get(params["*"])
    if (!f || !(await f.exists())) return status(404)
    return new Response(f, {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    })
  })
  .use(authPlugin)
  .group("/admin/files", { owner: true }, (app) =>
    app
      .get(
        "/",
        async ({ query }) => {
          const where = query.orphan ? isNotNull(files.orphanSince) : undefined
          const [rows, [total]] = await Promise.all([
            db
              .select({ file: files, refs: db.$count(fileRefs, eq(fileRefs.fileId, files.id)) })
              .from(files)
              .where(where)
              .orderBy(desc(files.createdAt))
              .limit(query.size)
              .offset((query.page - 1) * query.size),
            db.select({ n: count() }).from(files).where(where),
          ])
          return { items: rows.map((r) => ({ ...publicFile(r.file), refs: r.refs })), total: total?.n ?? 0 }
        },
        {
          query: z.object({
            orphan: z.stringbool().optional(),
            page: z.coerce.number().int().min(1).default(1),
            size: z.coerce.number().int().min(1).max(100).default(40),
          }),
        },
      )
      .post(
        "/",
        async ({ body, user, status }) => {
          if (!(await rateLimit(`upload:${user.id}`, 60, 60))) return status(429, "传得太快了，等一分钟")
          try {
            return publicFile(await saveUpload(body.file))
          } catch (e) {
            return status(400, (e as Error).message)
          }
        },
        { body: t.Object({ file: t.File({ type: acceptedTypes, maxSize: MAX_UPLOAD }) }) },
      )
      .delete("/:id", async ({ params }) => ({ ok: await deleteFile(params.id) }), { params: idParam })
      .post("/purge-orphans", async () => ({ deleted: await purgeOrphans() })),
  )
