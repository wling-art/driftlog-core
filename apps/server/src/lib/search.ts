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
    highlightPreTag: "<mark>",
    highlightPostTag: "</mark>",
  })
  return r.hits.map((h) => ({
    id: h.id as number,
    type: h.type as string,
    slug: h.slug as string,
    title: (h._formatted?.title as string) ?? (h.title as string),
    snippet: (h._formatted?.text as string) ?? "",
  }))
}
