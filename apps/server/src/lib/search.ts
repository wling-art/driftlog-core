import { Meilisearch } from "meilisearch"
import { eq } from "drizzle-orm"
import { entries } from "@driftlog/db"
import { env } from "../env"
import { db } from "./db"

export const meili = new Meilisearch({ host: env.MEILI_URL, apiKey: env.MEILI_KEY })
const index = meili.index("entries")

export async function setupSearch() {
  await meili
    .createIndex("entries", { primaryKey: "id" })
    .waitTask()
    .catch(() => {})
  await index.updateSettings({
    searchableAttributes: ["title", "tags", "excerpt", "text"],
    filterableAttributes: ["type"],
    sortableAttributes: ["publishedAt"],
  })
}

/** 把一篇同步进搜索：没发布就删掉 */
export async function syncSearch(id: number) {
  const [e] = await db.select().from(entries).where(eq(entries.id, id))
  if (!e?.published) return void (await index.deleteDocument(id))
  await index.addDocuments([
    {
      id: e.id,
      type: e.type,
      slug: e.slug,
      title: e.title,
      tags: e.tags,
      excerpt: e.excerpt,
      text: e.html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 20000),
      publishedAt: e.publishedAt?.getTime() ?? 0,
    },
  ])
}

export async function search(q: string, limit = 10) {
  const r = await index.search(q, {
    limit,
    attributesToRetrieve: ["id", "type", "slug", "title"],
    attributesToCrop: ["text"],
    cropLength: 40,
    attributesToHighlight: ["title", "text"],
    // 用控制字符占位，先转义再换成 <mark>：前台会把结果当 HTML 渲染
    highlightPreTag: "\u0001",
    highlightPostTag: "\u0002",
  })
  return r.hits.map((h) => ({
    id: h.id as number,
    type: h.type as string,
    slug: h.slug as string,
    title: highlight((h._formatted?.title as string) ?? (h.title as string)),
    snippet: highlight((h._formatted?.text as string) ?? ""),
  }))
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
export const highlight = (s: string) =>
  escapeHtml(s).replaceAll("\u0001", "<mark>").replaceAll("\u0002", "</mark>")
