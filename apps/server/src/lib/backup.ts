import { Glob } from "bun"
import { join } from "node:path"
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { env } from "../env"
import { filesDir } from "./storage"

export const backupDir = join(env.DATA_DIR, "backups")
const KEEP = 7
const NAME = /^backup-[\w-]+\.tar\.gz$/

/** pg_dump + 本地文件打成 tar.gz，只留最近 7 份 */
export async function createBackup() {
  await mkdir(backupDir, { recursive: true })
  const dump = Bun.spawn(["pg_dump", "--format=custom", "--no-owner", env.DATABASE_URL], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(dump.stdout).bytes(),
    new Response(dump.stderr).text(),
    dump.exited,
  ])
  if (code !== 0) throw new Error(`pg_dump 失败：${err.trim()}`)

  const entries: Record<string, Uint8Array> = { "db.dump": out }
  // 先读成字节再打包，见 CLAUDE.md
  // shortcut: 整个目录读进内存，文件到几 GB 时改成流式
  if (env.STORAGE === "local" && (await stat(filesDir).catch(() => null))) {
    for await (const f of new Glob("**/*").scan({ cwd: filesDir, onlyFiles: true }))
      entries[`files/${f}`] = await Bun.file(join(filesDir, f)).bytes()
  }
  const name = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`
  await Bun.Archive.write(join(backupDir, name), entries, { compress: "gzip" })
  for (const old of (await listBackups()).slice(KEEP)) await rm(join(backupDir, old.name))
  return name
}

export async function listBackups() {
  const names = await readdir(backupDir).catch(() => [])
  const rows = await Promise.all(
    names
      .filter((n) => NAME.test(n))
      .map(async (name) => ({ name, size: (await stat(join(backupDir, name))).size })),
  )
  return rows.sort((a, b) => b.name.localeCompare(a.name))
}

export const backupFile = (name: string) => (NAME.test(name) ? Bun.file(join(backupDir, name)) : null)
