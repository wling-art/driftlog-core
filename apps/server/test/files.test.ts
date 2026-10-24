import { expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { files, thoughts } from "@driftlog/db"
import { db } from "../src/lib/db"
import { scanOrphans } from "../src/lib/files"

test("动态里用到的文件不算孤儿", async () => {
  const hash = (n: number) => `${Date.now().toString(16).padStart(12, "0")}${n}`.padEnd(64, "0")
  const old = new Date(Date.now() - 2 * 86400_000)
  const row = (h: string) => ({
    hash: h,
    key: `${h.slice(0, 2)}/${h}.webp`,
    name: "a",
    mime: "image/webp",
    size: 1,
    createdAt: old,
  })
  const [used, unused] = await db
    .insert(files)
    .values([row(hash(1)), row(hash(2))])
    .returning()
  const [t] = await db
    .insert(thoughts)
    .values({ content: `![](http://localhost:3900/files/${used!.key})` })
    .returning()
  try {
    await scanOrphans()
    const orphanSince = async (id: number) =>
      (await db.select().from(files).where(eq(files.id, id)))[0]!.orphanSince
    expect(await orphanSince(used!.id)).toBeNull()
    expect(await orphanSince(unused!.id)).not.toBeNull()
  } finally {
    await db.delete(thoughts).where(eq(thoughts.id, t!.id))
    await db.delete(files).where(eq(files.id, used!.id))
    await db.delete(files).where(eq(files.id, unused!.id))
  }
})
