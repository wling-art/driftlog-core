import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { backupDir, createBackup } from "../src/lib/backup"
import { filesDir } from "../src/lib/storage"

// 回归：Bun.Archive 写惰性 Bun.file 会得到 0 字节，备份必须先读成字节
test("备份包里的文件不是空的", async () => {
  const key = `zz/test-${Date.now()}.txt`
  await Bun.write(join(filesDir, key), "hello", { createPath: true })
  const name = await createBackup()
  try {
    const files = await new Bun.Archive(await Bun.file(join(backupDir, name)).bytes()).files()
    expect(await files.get(`files/${key}`)?.text()).toBe("hello")
    expect(files.get("db.dump")?.size).toBeGreaterThan(0)
  } finally {
    await rm(join(filesDir, key))
    await rm(join(backupDir, name))
  }
})
