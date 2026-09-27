import { betterAuth } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { passkey } from "@better-auth/passkey"
import { count, eq } from "drizzle-orm"
import { Elysia } from "elysia"
import { schema, user } from "@driftlog/db"
import { db } from "./lib/db"
import { env, isProd } from "./env"

const social = <T extends string | undefined>(id: T, secret: T) =>
  id && secret ? { clientId: id, clientSecret: secret } : undefined
const ownerExists = async () =>
  ((await db.select({ n: count() }).from(user).where(eq(user.role, "owner")))[0]?.n ?? 0) > 0

export const auth = betterAuth({
  baseURL: env.PUBLIC_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.BLOG_URL, env.ADMIN_URL],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    password: {
      hash: (password) => Bun.password.hash(password),
      verify: ({ hash, password }) => Bun.password.verify(password, hash),
    },
  },
  socialProviders: {
    github: social(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    google: social(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
  },
  plugins: [
    passkey({
      rpName: "Driftlog",
      rpID: new URL(env.ADMIN_URL).hostname,
      origin: [env.ADMIN_URL, env.BLOG_URL],
    }),
  ],
  user: { additionalFields: { role: { type: "string", input: false, defaultValue: "reader" } } },
  databaseHooks: {
    user: {
      create: {
        // 第一个注册的人是站长；之后的都是读者（前台用 GitHub / Google 登录来评论），后台只认站长
        before: async (u) => ({ data: { ...u, role: (await ownerExists()) ? "reader" : "owner" } }),
      },
    },
  },
  hooks: {
    // 和 mx-space 一样：读者只能用 GitHub / Google 登录（第一次登录就是注册）；邮箱注册只给第一次建站、建站长用
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email" && (await ownerExists()))
        throw new APIError("FORBIDDEN", { message: "读者请用 GitHub 或 Google 登录" })
    }),
  },
  // 登录限流（Better Auth 默认只在生产环境开，这里开发也开）
  rateLimit: { enabled: true },
  advanced: isProd ? { defaultCookieAttributes: { sameSite: "none", secure: true } } : {},
})

export type Session = typeof auth.$Infer.Session

/** 配好了的第三方登录（前台只显示这些按钮） */
export const oauthProviders = (["github", "google"] as const).filter((p) =>
  p === "github"
    ? env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
    : env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET,
)

/** 挂上 Better Auth，并提供 { owner: true } / { session: true } 两个宏 */
export const authPlugin = new Elysia({ name: "auth" }).mount(auth.handler).macro({
  owner: {
    async resolve({ status, request: { headers } }) {
      const s = await auth.api.getSession({ headers })
      if (!s) return status(401, "先登录")
      if (s.user.role !== "owner") return status(403, "只有站长能做这个")
      return { user: s.user }
    },
  },
  session: {
    async resolve({ request: { headers } }) {
      const s = await auth.api.getSession({ headers })
      return { user: s?.user ?? null }
    },
  },
})
