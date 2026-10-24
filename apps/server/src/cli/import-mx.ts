/*
 * 从 mx-space（PostgreSQL 版 mx-core）导入内容。
 *
 *   MX_DATABASE_URL=postgres://…/mx_core MX_STATIC_DIR=…/mx-space/static bun src/cli/import-mx.ts
 *
 * - 源库只读：连接一建立就设成只读事务，服务端不确认就直接退出。
 * - 可以重复跑：每张表按源库的 id（legacy_id）更新，不会重复插入。
 * - 导入：文章 / 手记 / 页面、分类、手记专栏、评论、AI 摘要和翻译、旧 slug 跳转、一言、动态、友链、项目、站点设置；
 *   正文、封面和头像里旧站的图片从 MX_STATIC_DIR 读出，走新站的上传流程（去重、WebP、多尺寸），再改写成新地址。
 * - 不导入：访问统计明细、修订历史、serverless 片段、读者账号、各种第三方密钥。
 */
import { SQL } from "bun"
import { eq, sql } from "drizzle-orm"
import {
  categories,
  comments,
  entries,
  links,
  projects,
  says,
  siteSettings,
  slugRedirects,
  thoughts,
  topics,
  translations,
  type SiteSettings,
} from "@driftlog/db"
import { renderComment, renderMarkdown } from "@driftlog/markdown"
import { db } from "../lib/db"
import { fetchLinkMeta } from "../lib/linkcard"
import { extractFileHashes, publicFile, saveUpload, syncRefs } from "../lib/files"
import { invalidate, redis } from "../lib/redis"
import { meili, setupSearch, syncSearch } from "../lib/search"

const SRC = process.env.MX_DATABASE_URL
if (!SRC) throw new Error("设置 MX_DATABASE_URL（源库 mx_core 的连接串）")
const STATIC = process.env.MX_STATIC_DIR
if (!STATIC) throw new Error("设置 MX_STATIC_DIR（旧站数据目录里的 static）")

const src = new SQL(SRC, { max: 1 })
await src`set default_transaction_read_only = on`
const [{ default_transaction_read_only: ro }] = await src`show default_transaction_read_only`
if (ro !== "on") throw new Error("源库没能切到只读，停止导入")
console.log("源库已连接（只读）")

type Row = Record<string, any>
const log = (what: string, n: number) => console.log(`  ${what}：${n}`)

// ---------- 图片：旧站 /api/v2|v3/objects/<kind>/<name> 从 static 目录读出来重新上传 ----------
const OLD_OBJECT =
  /https?:\/\/mixspace\.crashvibe\.cn\/api\/v\d+\/objects\/(image|file|avatar|icon)\/([\w.-]+)/g
const moved = new Map<string, string | null>()
async function moveFile(url: string, kind: string, name: string) {
  if (moved.has(url)) return moved.get(url)
  const file = Bun.file(`${STATIC}/${kind}/${name}`)
  let next: string | null = null
  if (await file.exists()) {
    try {
      next = publicFile(
        await saveUpload(new File([await file.bytes()], name, { type: file.type.split(";")[0] })),
      ).url
    } catch (e) {
      console.warn(`  ! ${name} 没存上：${(e as Error).message}`)
    }
  } else console.warn(`  ! ${name} 不在 static 目录，保留原地址`)
  moved.set(url, next)
  return next
}
async function rewrite(text: string | null | undefined) {
  if (!text) return text ?? ""
  let out = text
  for (const [url, kind, name] of text.matchAll(OLD_OBJECT)) {
    const next = await moveFile(url, kind!, name!)
    if (next) out = out.replaceAll(url, next)
  }
  return out
}

// ---------- 站点设置 ----------
const opt = Object.fromEntries(
  (await src`select name, value from options where name in ('seo')`).map((r: Row) => [r.name, r.value]),
)
const [owner] = await src`
  select o.introduce, o.social_ids, r.name, r.image
  from owner_profiles o left join readers r on r.id = o.reader_id limit 1`
const settings: SiteSettings = {
  title: opt.seo?.title || "Driftlog",
  description: opt.seo?.description ?? "",
  keywords: opt.seo?.keywords ?? [],
  owner: {
    name: owner?.name ?? "wling",
    introduce: owner?.introduce ?? "",
    avatar: owner?.image ?? null,
    socials: Object.fromEntries(
      Object.entries((owner?.social_ids ?? {}) as Record<string, string>).filter(([, v]) => v),
    ),
  },
}
const [{ value: siteLikes }] = await src`select value from options where name = 'like'`
// 站点设置只在第一次导入时写入；点赞数取较大值
await db
  .insert(siteSettings)
  .values({ id: 1, value: settings, likes: Number(siteLikes) || 0 })
  .onConflictDoUpdate({
    target: siteSettings.id,
    set: { likes: sql`greatest(${siteSettings.likes}, excluded.likes)` },
  })
console.log(`站点设置：${settings.title}，点赞 ${Number(siteLikes) || 0}`)

// ---------- 分类、专栏 ----------
const categoryId = new Map<string, number>()
for (const c of await src`select * from categories order by created_at`) {
  const [row] = await db
    .insert(categories)
    .values({ name: c.name, slug: c.slug, legacyId: c.id, createdAt: c.created_at })
    .onConflictDoUpdate({ target: categories.legacyId, set: { name: c.name, slug: c.slug } })
    .returning({ id: categories.id })
  categoryId.set(c.id, row!.id)
}
log("分类", categoryId.size)

const topicId = new Map<string, number>()
for (const t of await src`select * from topics order by created_at`) {
  const values = {
    name: t.name,
    slug: t.slug,
    description: t.description ?? "",
    introduce: t.introduce ?? "",
  }
  const [row] = await db
    .insert(topics)
    .values({ ...values, legacyId: t.id, createdAt: t.created_at })
    .onConflictDoUpdate({ target: topics.legacyId, set: values })
    .returning({ id: topics.id })
  topicId.set(t.id, row!.id)
}
log("手记专栏", topicId.size)

// ---------- 文章 / 手记 / 页面 ----------
const summaries = new Map(
  (await src`select ref_id, summary from ai_summaries where not is_translation order by created_at`).map(
    (r: Row) => [r.ref_id, r.summary],
  ),
)
const entryId = new Map<string, number>() // 源 id → 新 id
const entryIds: number[] = []

async function upsertEntry(
  source: Row,
  values: Partial<typeof entries.$inferInsert> & {
    type: "post" | "note" | "page"
    slug: string
    title: string
  },
) {
  const body = await rewrite(source.text)
  const rendered = await renderMarkdown(body, { resolveLinkCard: fetchLinkMeta })
  const full = {
    ...values,
    body,
    ...rendered,
    published: source.is_published ?? true,
    views: source.read_count ?? 0,
    likes: source.like_count ?? 0,
    createdAt: source.created_at,
    updatedAt: source.modified_at ?? source.created_at,
    legacyId: source.id,
  }
  const [row] = await db
    .insert(entries)
    .values(full)
    .onConflictDoUpdate({ target: entries.legacyId, set: full })
    .returning({ id: entries.id })
  entryId.set(source.id, row!.id)
  entryIds.push(row!.id)
  await syncRefs(row!.id, extractFileHashes(body))
}

for (const p of await src`select * from posts order by created_at`) {
  await upsertEntry(p, {
    type: "post",
    title: p.title,
    slug: p.slug,
    categoryId: categoryId.get(p.category_id) ?? null,
    tags: p.tags ?? [],
    pinned: p.pin_at != null,
    copyright: p.copyright ?? true,
    summary: p.summary || summaries.get(p.id) || null,
    cover: (await rewrite(p.meta?.cover)) || null,
    publishedAt: p.created_at,
  })
}
log("文章", (await src`select count(*)::int n from posts`)[0].n)

// 手记的 slug 用原来的编号：旧链接 /notes/12 直接能打开
for (const n of await src`select * from notes order by nid`) {
  await upsertEntry(n, {
    type: "note",
    title: n.title,
    slug: String(n.nid),
    topicId: topicId.get(n.topic_id) ?? null,
    mood: n.mood || null,
    weather: n.weather || null,
    publishedAt: n.public_at ?? n.created_at,
  })
}
log("手记", (await src`select count(*)::int n from notes`)[0].n)

for (const pg of await src`select * from pages order by "order"`) {
  await upsertEntry(pg, {
    type: "page",
    title: pg.title,
    slug: pg.slug,
    subtitle: pg.subtitle || null,
    publishedAt: pg.created_at,
  })
}
log("页面", (await src`select count(*)::int n from pages`)[0].n)

// ---------- 旧 slug 跳转：slug_trackers 里记的是改名前的地址 ----------
let redirects = 0
for (const t of await src`select distinct slug, type, target_id from slug_trackers`) {
  const id = entryId.get(t.target_id)
  const old = String(t.slug).split("/").filter(Boolean).at(-1)
  if (!id || !old || (t.type !== "post" && t.type !== "note")) continue
  const [cur] = await db.select({ slug: entries.slug }).from(entries).where(eq(entries.id, id))
  if (cur?.slug === old) continue
  await db
    .insert(slugRedirects)
    .values({ type: t.type, oldSlug: old, entryId: id })
    .onConflictDoUpdate({ target: [slugRedirects.type, slugRedirects.oldSlug], set: { entryId: id } })
  redirects++
}
log("旧 slug 跳转", redirects)

// ---------- 评论：按时间顺序导，父评论总在前面 ----------
const readers = new Map<string, Row>(
  (await src`select id, name, email from readers`).map((r: Row) => [r.id, r]),
)
const commentId = new Map<string, number>()
// 旧站的回复关系丢了（parent_comment_id 全是空的，mx-space 从 MongoDB 迁到 PostgreSQL 时没带过来）。
// 只能按规律补：站长在一篇下面的评论，如果前面已经有别人评论过，就当是回复最近的那一条。
// ponytail: 启发式，只补站长的；读者之间的回复猜不出来，保持顶层
const lastGuest = new Map<number, number>() // 条目 → 最近一条别人的评论（新 id）
const seen = new Set<number>() // 已经有评论的条目
let skipped = 0
for (const c of await src`select * from comments where not coalesce(is_deleted, false) order by created_at`) {
  const target = entryId.get(c.ref_id)
  if (!target) {
    skipped++ // 挂在动态之类没有导入成条目的内容上
    continue
  }
  const reader = c.reader_id ? readers.get(c.reader_id) : undefined
  const author = c.author || reader?.name || "匿名"
  const isOwner = author === settings.owner.name
  const guessed = isOwner && seen.has(target) ? (lastGuest.get(target) ?? null) : null
  const values = {
    entryId: target,
    parentId: c.parent_comment_id ? (commentId.get(c.parent_comment_id) ?? null) : guessed,
    author,
    email: c.mail || reader?.email || "unknown@invalid",
    url: c.url || null,
    body: c.text ?? "",
    html: await renderComment(c.text ?? ""),
    // mx-space：0 未读、1 已读、2 垃圾
    status: c.state === 2 ? ("spam" as const) : ("approved" as const),
    private: Boolean(c.is_whispers),
    location: c.location || null,
    avatar: c.avatar || null,
    ip: c.ip || null,
    userAgent: c.agent || null,
    createdAt: c.created_at,
    legacyId: c.id,
  }
  const [row] = await db
    .insert(comments)
    .values(values)
    .onConflictDoUpdate({ target: comments.legacyId, set: values })
    .returning({ id: comments.id })
  commentId.set(c.id, row!.id)
  seen.add(target)
  if (!isOwner) lastGuest.set(target, row!.id)
}
log("评论", commentId.size)
if (skipped) log("跳过的评论（挂在未导入的内容上）", skipped)

// ---------- AI 翻译：同一篇同一语言只留最新的；jp 统一成 ja ----------
let translated = 0
for (const t of await src`
  select distinct on (ref_id, case lang when 'jp' then 'ja' else lang end)
    ref_id, case lang when 'jp' then 'ja' else lang end as lang, title, text
  from ai_translations where coalesce(text, '') <> ''
  order by ref_id, case lang when 'jp' then 'ja' else lang end, coalesce(updated_at, created_at) desc`) {
  const id = entryId.get(t.ref_id)
  if (!id) continue
  const { html } = await renderMarkdown(await rewrite(t.text), { resolveLinkCard: fetchLinkMeta })
  await db
    .insert(translations)
    .values({ entryId: id, lang: t.lang, title: t.title, html })
    .onConflictDoUpdate({ target: [translations.entryId, translations.lang], set: { title: t.title, html } })
  translated++
}
log("AI 翻译", translated)

// ---------- 一言、动态、友链、项目 ----------
for (const s of await src`select * from says order by created_at`) {
  const values = { text: s.text, source: s.source || null, author: s.author || null }
  await db
    .insert(says)
    .values({ ...values, legacyId: s.id, createdAt: s.created_at })
    .onConflictDoUpdate({ target: says.legacyId, set: values })
}
log("一言", (await src`select count(*)::int n from says`)[0].n)

for (const r of await src`select * from recentlies order by created_at`) {
  const content = await rewrite(r.content)
  const values = {
    content,
    html: await renderComment(content),
    up: r.up ?? 0,
    down: r.down ?? 0,
    updatedAt: r.modified_at ?? r.created_at,
  }
  await db
    .insert(thoughts)
    .values({ ...values, legacyId: r.id, createdAt: r.created_at })
    .onConflictDoUpdate({ target: thoughts.legacyId, set: values })
}
log("动态", (await src`select count(*)::int n from recentlies`)[0].n)

// mx-space：type 0 友链、1 收藏；state 0 通过、1 待审核、2 过期、3 屏蔽、4 拒绝
const linkState = ["approved", "pending", "outdated", "rejected", "rejected"] as const
for (const l of await src`select * from links order by created_at`) {
  const values = {
    name: l.name,
    url: l.url,
    avatar: (await rewrite(l.avatar)) || null,
    description: l.description ?? "",
    type: l.type === 1 ? ("collection" as const) : ("friend" as const),
    state: linkState[l.state] ?? ("pending" as const),
    email: l.email || null,
  }
  await db
    .insert(links)
    .values({ ...values, legacyId: l.id, createdAt: l.created_at })
    .onConflictDoUpdate({ target: links.legacyId, set: values })
}
log("友链", (await src`select count(*)::int n from links`)[0].n)

for (const p of await src`select * from projects order by created_at`) {
  const body = await rewrite(p.text)
  const values = {
    name: p.name,
    description: p.description ?? "",
    avatar: (await rewrite(p.avatar)) || null,
    previewUrl: p.preview_url || null,
    projectUrl: p.project_url || null,
    docUrl: p.doc_url || null,
    body: body === "无" ? "" : body,
    html: body && body !== "无" ? (await renderMarkdown(body)).html : "",
  }
  await db
    .insert(projects)
    .values({ ...values, legacyId: p.id, createdAt: p.created_at })
    .onConflictDoUpdate({ target: projects.legacyId, set: values })
}
log("项目", (await src`select count(*)::int n from projects`)[0].n)

// ---------- 收尾：搜索重建、缓存失效 ----------
await setupSearch().catch(() => {})
await meili
  .index("entries")
  .deleteAllDocuments()
  .waitTask()
  .catch(() => {})
for (const id of entryIds)
  await syncSearch(id).catch((e) => console.warn(`  ! 搜索同步失败 #${id}：${(e as Error).message}`))
await invalidate()
log("迁移的图片", [...moved.values()].filter(Boolean).length)
const [total] = await db.select({ n: sql<number>`count(*)::int` }).from(entries)
console.log(`完成。新库共 ${total?.n} 篇内容。`)
await src.close()
redis.close()
process.exit(0)
