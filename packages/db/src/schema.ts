import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import type { TocItem } from "@driftlog/schema"

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

// ---------- Better Auth ----------
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("reader"), // owner | reader，第一个注册的人是 owner
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const passkey = pgTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credential_id").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  aaguid: text("aaguid"),
  createdAt: createdAt(),
})

// ---------- 内容 ----------
export const entryType = pgEnum("entry_type", ["post", "note", "page"])
export const commentStatus = pgEnum("comment_status", ["pending", "approved", "spam"])

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull().default(""),
  sort: integer("sort").notNull().default(0),
  legacyId: text("legacy_id").unique(),
  createdAt: createdAt(),
})

// 手记专栏：手记按专栏归类（像文章按分类）
export const topics = pgTable("topics", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull().default(""),
  introduce: text("introduce").notNull().default(""), // 一句话介绍
  sort: integer("sort").notNull().default(0),
  legacyId: text("legacy_id").unique(), // 从 mx-space 导入时的原 id，重复导入按它更新
  createdAt: createdAt(),
})

// 文章 / 手记 / 页面共用一张表（ponytail: 字段几乎一样，拆表只会多三份 CRUD）
export const entries = pgTable(
  "entries",
  {
    id: serial("id").primaryKey(),
    type: entryType("type").notNull().default("post"),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    body: text("body").notNull().default(""),
    html: text("html").notNull().default(""),
    toc: jsonb("toc").$type<TocItem[]>().notNull().default([]),
    excerpt: text("excerpt").notNull().default(""),
    summary: text("summary"), // AI 摘要
    subtitle: text("subtitle"), // 页面的副标题
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    cover: text("cover"),
    published: boolean("published").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    mood: text("mood"),
    weather: text("weather"),
    topicId: integer("topic_id").references(() => topics.id, { onDelete: "set null" }),
    copyright: boolean("copyright").notNull().default(true), // 文末显示版权声明
    views: integer("views").notNull().default(0),
    likes: integer("likes").notNull().default(0),
    legacyId: text("legacy_id").unique(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("entries_type_slug").on(t.type, t.slug),
    index("entries_published_at").on(t.published, t.publishedAt),
  ],
)

export const translations = pgTable(
  "translations",
  {
    entryId: integer("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    lang: text("lang").notNull(),
    title: text("title").notNull(),
    html: text("html").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.lang] })],
)

export const comments = pgTable(
  "comments",
  {
    id: serial("id").primaryKey(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    parentId: integer("parent_id"),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    author: text("author").notNull(),
    email: text("email").notNull(),
    url: text("url"),
    body: text("body").notNull(),
    html: text("html").notNull(),
    status: commentStatus("status").notNull().default("pending"),
    private: boolean("private").notNull().default(false), // 悄悄话：只有站长看得到
    location: text("location"),
    legacyId: text("legacy_id").unique(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("comments_entry").on(t.entryId, t.status)],
)

// ---------- 文件 ----------
export type FileVariant = { width: number; key: string }

export const files = pgTable("files", {
  id: serial("id").primaryKey(),
  hash: text("hash").notNull().unique(), // 内容哈希，去重 + 命名
  key: text("key").notNull(), // 存储里的路径
  name: text("name").notNull(), // 原文件名
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  width: integer("width"),
  height: integer("height"),
  thumbhash: text("thumbhash"),
  variants: jsonb("variants").$type<FileVariant[]>().notNull().default([]),
  orphanSince: timestamp("orphan_since", { withTimezone: true }),
  createdAt: createdAt(),
})

export const fileRefs = pgTable(
  "file_refs",
  {
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    entryId: integer("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.entryId] })],
)

// ---------- mx-space 带过来的功能 ----------

// 旧地址跳转：改过 slug 的文章，旧 slug 还能打开（301 到新地址）
export const slugRedirects = pgTable(
  "slug_redirects",
  {
    type: entryType("type").notNull(),
    oldSlug: text("old_slug").notNull(),
    entryId: integer("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.type, t.oldSlug] })],
)

// 一言：一句话 + 出处
export const says = pgTable("says", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  source: text("source"),
  author: text("author"),
  legacyId: text("legacy_id").unique(),
  createdAt: createdAt(),
})

// 动态：比手记更短的碎片（Shiro 的 /thinking），可以顶 / 踩
export const thoughts = pgTable("thoughts", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(),
  html: text("html").notNull().default(""),
  up: integer("up").notNull().default(0),
  down: integer("down").notNull().default(0),
  legacyId: text("legacy_id").unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const linkType = pgEnum("link_type", ["friend", "collection"])
export const linkState = pgEnum("link_state", ["approved", "pending", "outdated", "rejected"])

// 友链：读者可以申请（pending），站长审核
export const links = pgTable("links", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull().unique(),
  avatar: text("avatar"),
  description: text("description").notNull().default(""),
  type: linkType("type").notNull().default("friend"),
  state: linkState("state").notNull().default("pending"),
  email: text("email"),
  legacyId: text("legacy_id").unique(),
  createdAt: createdAt(),
})

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  avatar: text("avatar"),
  previewUrl: text("preview_url"),
  projectUrl: text("project_url"),
  docUrl: text("doc_url"),
  body: text("body").notNull().default(""),
  html: text("html").notNull().default(""),
  sort: integer("sort").notNull().default(0),
  legacyId: text("legacy_id").unique(),
  createdAt: createdAt(),
})

// 站点设置：只有一行（id = 1）
export type SiteSettings = {
  title: string
  description: string
  keywords: string[]
  owner: { name: string; introduce: string; avatar: string | null; socials: Record<string, string> }
}
export const siteSettings = pgTable("site_settings", {
  id: integer("id").primaryKey().default(1),
  value: jsonb("value").$type<SiteSettings>().notNull(),
  updatedAt: updatedAt(),
})
