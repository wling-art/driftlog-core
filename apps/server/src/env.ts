import { z } from "zod"

const optional = z.string().min(1).optional()

export const env = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().default(3900),
    /** API 自己对外的地址，Better Auth 回调和文件 URL 用 */
    PUBLIC_URL: z.url().default("http://localhost:3900"),
    BLOG_URL: z.url().default("http://localhost:5173"),
    ADMIN_URL: z.url().default("http://localhost:5174"),
    DATABASE_URL: z.string().default("postgres://postgres@localhost:5432/driftlog"),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    MEILI_URL: z.url().default("http://localhost:7700"),
    MEILI_KEY: optional,
    /** 持久化卷：文件、备份都放这里 */
    DATA_DIR: z.string().default("./data"),
    STORAGE: z.enum(["local", "s3"]).default("local"),
    /** STORAGE=s3 时文件的公开地址前缀（CDN）；S3_* 由 Bun.s3 自己读 */
    S3_PUBLIC_URL: optional,
    BETTER_AUTH_SECRET: z.string().min(32).default("dev-secret-dev-secret-dev-secret-dev"),
    GITHUB_CLIENT_ID: optional,
    GITHUB_CLIENT_SECRET: optional,
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    /** AI SDK 模型 id（走 AI Gateway，需要 AI_GATEWAY_API_KEY）；不填就不开 AI */
    AI_MODEL: optional,
    RESEND_API_KEY: optional,
    MAIL_FROM: z.string().default("Driftlog <noreply@example.com>"),
    OWNER_EMAIL: optional,
    SENTRY_DSN: optional,
    LOG_LEVEL: z.string().default("info"),
  })
  .parse(process.env)

export const isProd = env.NODE_ENV === "production"
