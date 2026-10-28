import { z } from "zod"

const optional = z.string().min(1).optional()
const DEV_SECRET = "dev-secret-dev-secret-dev-secret-dev"

export const env = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().default(3900),
    /** API 自己的对外地址 */
    PUBLIC_URL: z.url().default("http://localhost:3900"),
    BLOG_URL: z.url().default("http://localhost:5173"),
    ADMIN_URL: z.url().default("http://localhost:5174"),
    DATABASE_URL: z.string().default("postgres://postgres@localhost:5432/driftlog"),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    MEILI_URL: z.url().default("http://localhost:7700"),
    MEILI_KEY: optional,
    /** 文件和备份的目录 */
    DATA_DIR: z.string().default("./data"),
    STORAGE: z.enum(["local", "s3"]).default("local"),
    /** STORAGE=s3 时文件的公开地址前缀；其余 S3_* 由 Bun.s3 读取 */
    S3_PUBLIC_URL: optional,
    BETTER_AUTH_SECRET: z.string().min(32).default(DEV_SECRET),
    GITHUB_CLIENT_ID: optional,
    GITHUB_CLIENT_SECRET: optional,
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    /** AI Gateway 的模型 id，不填就不开 AI */
    RESEND_API_KEY: optional,
    MAIL_FROM: z.string().default("Driftlog <noreply@example.com>"),
    OWNER_EMAIL: optional,
    SENTRY_DSN: optional,
    /** Umami 统计（服务端事件）：两项都填才发 */
    UMAMI_URL: optional,
    UMAMI_WEBSITE_ID: optional,
    LOG_LEVEL: z.string().default("info"),
  })
  // 空值当作没填
  .parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")))

export const isProd = env.NODE_ENV === "production"

if (isProd && env.BETTER_AUTH_SECRET === DEV_SECRET)
  throw new Error("生产环境必须设置 BETTER_AUTH_SECRET（openssl rand -base64 32）")
