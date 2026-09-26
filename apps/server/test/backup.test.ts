import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

// 回归：Bun.Archive 写惰性 Bun.file 会得到 0 字节，备份必须先读成字节
test("备份包里的文件不是空的", async () => {
  const dir = await mkdtemp(join(tmpdir(), "driftlog-"))
  process.env.DATA_DIR = dir
  await Bun.write(join(dir, "files/ab/x.webp"), "hello")
  const { createBackup, backupDir } = await import("../src/lib/backup")
  const name = await createBackup()
  const files = await new Bun.Archive(await Bun.file(join(backupDir, name)).bytes()).files()
  expect(await files.get("files/ab/x.webp")?.text()).toBe("hello")
  expect(files.get("db.dump")?.size).toBeGreaterThan(0)
})
