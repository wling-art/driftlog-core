import { z } from "zod"

// 共享 schema：服务端校验 + OpenAPI + 前台 / 后台表单共用一份

export const entryType = z.enum(["post", "note", "page"])
export type EntryType = z.infer<typeof entryType>

export const slug = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "只能用小写字母、数字和 -")

export const entryInput = z.object({
  type: entryType.default("post"),
  title: z.string().min(1, "标题不能空").max(200),
  slug,
  body: z.string().default(""),
  categoryId: z.number().int().nullable().default(null),
  tags: z.array(z.string().min(1).max(32)).max(16).default([]),
  cover: z.string().nullable().default(null),
  published: z.boolean().default(false),
  pinned: z.boolean().default(false),
  mood: z.string().max(16).nullable().default(null),
  weather: z.string().max(16).nullable().default(null),
  topicId: z.number().int().nullable().default(null),
  subtitle: z.string().max(200).nullable().default(null),
  copyright: z.boolean().default(true),
})
export type EntryInput = z.infer<typeof entryInput>

export const entryPatch = entryInput.partial()

export const listQuery = z.object({
  type: entryType.optional(),
  topic: z.string().optional(),
  category: z.string().optional(),
  tag: z.string().optional(),
  // 不用 .default()：Eden 按输出类型推断 query，带默认值的字段会变成必填
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(50).optional(),
})

export const tocItem = z.object({ depth: z.number(), id: z.string(), text: z.string() })
export type TocItem = z.infer<typeof tocItem>

export const categoryInput = z.object({
  name: z.string().min(1).max(32),
  slug,
  description: z.string().max(200).default(""),
  sort: z.number().int().default(0),
})
export type CategoryInput = z.infer<typeof categoryInput>

export const commentStatus = z.enum(["pending", "approved", "spam"])
export type CommentStatus = z.infer<typeof commentStatus>

export const commentInput = z.object({
  entryId: z.number().int(),
  parentId: z.number().int().nullable().default(null),
  author: z.string().min(1, "留个名字").max(32),
  email: z.email("邮箱格式不对"),
  url: z.url().nullable().default(null),
  body: z.string().min(1, "说点什么").max(2000, "超过 2000 字了"),
  private: z.boolean().default(false), // 悄悄话：只有站长看得到
})
export type CommentInput = z.infer<typeof commentInput>

export const reorderInput = z.object({ ids: z.array(z.number().int()) })

// WebSocket 事件：服务端广播，前台订阅
export const wsEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("online"), count: z.number() }),
  z.object({ type: z.literal("comment.created"), entryId: z.number(), commentId: z.number() }),
  z.object({
    type: z.literal("entry.published"),
    entryId: z.number(),
    entryType,
    slug: z.string(),
    title: z.string(),
  }),
])
export type WsEvent = z.infer<typeof wsEvent>

// ---------- mx-space 带过来的功能 ----------

export const topicInput = z.object({
  name: z.string().min(1, "专栏要有名字").max(32),
  slug,
  description: z.string().max(500).default(""),
  introduce: z.string().max(120).default(""),
  sort: z.number().int().default(0),
})

export const sayInput = z.object({
  text: z.string().min(1, "写一句").max(500),
  source: z.string().max(300).nullable().default(null),
  author: z.string().max(64).nullable().default(null),
})

export const thoughtInput = z.object({ content: z.string().min(1, "说点什么").max(2000) })

export const linkType = z.enum(["friend", "collection"])
export const linkState = z.enum(["approved", "pending", "outdated", "rejected"])
export const linkInput = z.object({
  name: z.string().min(1, "站名不能空").max(64),
  url: z.url("网址格式不对"),
  avatar: z.url("头像要是一个图片网址").nullable().default(null),
  description: z.string().max(200).default(""),
  type: linkType.default("friend"),
  state: linkState.default("approved"),
  email: z.email("邮箱格式不对").nullable().default(null),
})
/** 读者申请友链：只能填这几项，状态固定是待审核 */
export const linkApplyInput = linkInput
  .pick({ name: true, url: true, avatar: true, description: true, email: true })
  .extend({
    email: z.email("邮箱格式不对，审核结果会发到这里"),
  })

export const projectInput = z.object({
  name: z.string().min(1, "项目要有名字").max(64),
  description: z.string().max(300).default(""),
  avatar: z.url().nullable().default(null),
  previewUrl: z.url().nullable().default(null),
  projectUrl: z.url().nullable().default(null),
  docUrl: z.url().nullable().default(null),
  body: z.string().default(""),
  sort: z.number().int().default(0),
})

export const siteSettingsInput = z.object({
  title: z.string().min(1, "站名不能空").max(64),
  description: z.string().max(200),
  keywords: z.array(z.string().max(32)).max(20),
  owner: z.object({
    name: z.string().min(1).max(32),
    introduce: z.string().max(300),
    avatar: z.url().nullable(),
    socials: z.record(z.string(), z.string().max(200)),
  }),
})
export type SiteSettingsInput = z.infer<typeof siteSettingsInput>

export const reaction = z.enum(["up", "down"])
