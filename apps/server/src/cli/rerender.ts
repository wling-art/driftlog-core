/*
 * 用当前的 Markdown 管线重新渲染所有条目（正文里的新语法、链接卡片、视频卡片才会生效）。
 *
 *   bun src/cli/rerender.ts          # 只看会变哪些
 *   bun src/cli/rerender.ts --write  # 真的写回
 *
 * 只改 html / toc / excerpt，不动更新时间（重新渲染不算作者改过）。翻译只存了 HTML，改不了。
 */
import { eq, sql } from "drizzle-orm"
import { entries } from "@driftlog/db"
import { renderMarkdown } from "@driftlog/markdown"
import { db } from "../lib/db"
import { fetchLinkMeta } from "../lib/linkcard"

const write = process.argv.includes("--write")
let changed = 0
for (const e of await db
  .select({ id: entries.id, slug: entries.slug, body: entries.body, html: entries.html })
  .from(entries)) {
  const r = await renderMarkdown(e.body, { resolveLinkCard: fetchLinkMeta })
  if (r.html === e.html) continue
  changed++
  const cards = (r.html.match(/class="md-link-card"/g) ?? []).length
  const videos = (r.html.match(/class="md-embed"|<video /g) ?? []).length
  console.log(`${e.slug}: 链接卡片 ${cards}，视频 ${videos}`)
  if (write)
    await db
      .update(entries)
      .set({ html: r.html, toc: r.toc, excerpt: r.excerpt, updatedAt: sql`${entries.updatedAt}` })
      .where(eq(entries.id, e.id))
}
console.log(write ? `写回了 ${changed} 篇` : `${changed} 篇会变（加 --write 写回）`)
process.exit(0)
