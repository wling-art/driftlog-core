/*
 * 重建搜索索引：bun src/cli/reindex.ts
 */
import { entries } from "@driftlog/db"
import { db } from "../lib/db"
import { redis } from "../lib/redis"
import { meili, setupSearch, syncSearch } from "../lib/search"

await setupSearch()
await meili.index("entries").deleteAllDocuments().waitTask()
const rows = await db.select({ id: entries.id }).from(entries)
for (const { id } of rows) await syncSearch(id)
console.log(`已索引 ${rows.length} 条`)
redis.close()
process.exit(0)
