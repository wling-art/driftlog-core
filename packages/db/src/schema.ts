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
    views: integer("views").notNull().default(0),
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
