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
})
export type EntryInput = z.infer<typeof entryInput>

export const entryPatch = entryInput.partial()

export const listQuery = z.object({
  type: entryType.optional(),
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
