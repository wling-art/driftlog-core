import { Elysia } from "elysia"
import { cors } from "@elysiajs/cors"
import { openapi } from "@elysiajs/openapi"
import { z } from "zod"
import { env } from "./env"
import { log } from "./lib/log"
import { rateLimit } from "./lib/redis"
import { search } from "./lib/search"
import { clientWsEvent } from "@driftlog/schema"
import { connected, disconnected, setPage, TOPIC } from "./lib/realtime"
import { authPlugin } from "./auth"
import { adminEntries, publicEntries } from "./routes/entries"
import { categoryRoutes } from "./routes/categories"
import { clientIp, commentRoutes } from "./routes/comments"
import { fileRoutes } from "./routes/files"
import { adminRoutes } from "./routes/admin"
import { extrasRoutes } from "./routes/extras"

const origins = [env.BLOG_URL, env.ADMIN_URL]
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

export const app = new Elysia()
  .use(cors({ origin: origins, credentials: true }))
  // 拒绝其他站点发来的写请求
  .onRequest(({ request, status }) => {
    const origin = request.headers.get("origin")
    if (origin && !safeMethods.has(request.method) && origin !== env.PUBLIC_URL && !origins.includes(origin))
      return status(403, "来源不对")
  })
  .use(
    openapi({
      path: "/openapi",
      provider: "scalar",
      mapJsonSchema: { zod: z.toJSONSchema },
      documentation: { info: { title: "Driftlog API", version: "0.1.0" } },
    }),
  )
  .onError(({ code, error, path }) => {
    if (code === "VALIDATION" || code === "NOT_FOUND") return
    log.error({ err: error, path }, "request failed")
  })
  .get("/health", () => ({ ok: true }))
  .use(authPlugin)
  .use(publicEntries)
  .use(adminEntries)
  .use(categoryRoutes)
  .use(commentRoutes)
  .use(fileRoutes)
  .use(adminRoutes)
  .use(extrasRoutes)
  .get(
    "/search",
    async ({ query, request, server, status }) => {
      if (!(await rateLimit(`search:${clientIp(request, server)}`, 30, 10))) return status(429, "搜得太快了")
      return search(query.q, query.limit)
    },
    {
      query: z.object({
        q: z.string().min(1).max(100),
        limit: z.coerce.number().int().min(1).max(20).default(8),
      }),
      tags: ["search"],
    },
  )
  .ws("/ws", {
    open(ws) {
      ws.subscribe(TOPIC)
      connected(ws.raw)
    },
    close(ws) {
      ws.unsubscribe(TOPIC)
      disconnected(ws.raw)
    },
    message(ws, message) {
      const parsed = clientWsEvent.safeParse(message)
      if (parsed.success) setPage(ws.raw, parsed.data.path.split(/[?#]/)[0]!)
    },
  })

export type App = typeof app
