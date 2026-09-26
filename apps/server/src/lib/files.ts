import { and, eq, inArray, isNotNull, isNull, lt, notExists, sql } from "drizzle-orm"
import { fileRefs, files, type FileVariant } from "@driftlog/db"
import { db } from "./db"
import { storage } from "./storage"

export const MAX_UPLOAD = 50 * 1024 * 1024
const RASTER = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic", "image/heif"])
const PASSTHROUGH = new Set(["image/gif", "video/mp4", "video/webm", "application/pdf"])
export const acceptedTypes = [...RASTER, ...PASSTHROUGH]
const WIDTHS = [640, 1280, 1920]

const extOf = (mime: string) =>
  ({ "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm", "application/pdf": "pdf" })[mime] ?? "bin"

/**
 * 上传：按内容哈希去重命名；位图一律转 WebP（重新编码顺带去掉 EXIF），再出几档宽度的衍生图和 ThumbHash 占位图
 */
export async function saveUpload(file: File) {
  if (!RASTER.has(file.type) && !PASSTHROUGH.has(file.type))
    throw new Error(`不支持的文件类型：${file.type || "未知"}`)
  if (file.size > MAX_UPLOAD) throw new Error("文件超过 50 MB")

  const bytes = await file.bytes()
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  const [existing] = await db.select().from(files).where(eq(files.hash, hash))
  if (existing) return existing

  const dir = hash.slice(0, 2)
  let key: string
  let mime = file.type
  let size = bytes.length
  let width: number | null = null
  let height: number | null = null
  let thumbhash: string | null = null
  const variants: FileVariant[] = []

  if (RASTER.has(file.type)) {
    const src = () => new Bun.Image(bytes, { autoOrient: true })
    const meta = await src().metadata()
    width = meta.width
    height = meta.height
    const main = await src().webp({ quality: 85 }).bytes()
    key = `${dir}/${hash}.webp`
    mime = "image/webp"
    size = main.length
    await storage.put(key, main, mime)
    for (const w of WIDTHS.filter((w) => w < meta.width)) {
      const k = `${dir}/${hash}-${w}.webp`
      await storage.put(k, await src().resize(w).webp({ quality: 80 }).bytes(), mime)
      variants.push({ width: w, key: k })
    }
    thumbhash = await src().placeholder()
  } else {
    key = `${dir}/${hash}.${extOf(file.type)}`
    await storage.put(key, bytes, file.type)
  }

  const [row] = await db
    .insert(files)
    .values({ hash, key, name: file.name, mime, size, width, height, thumbhash, variants })
    .onConflictDoNothing()
    .returning()
  return row ?? (await db.select().from(files).where(eq(files.hash, hash)))[0]!
}

/** 正文里出现的文件：…/ab/<64 位哈希>… */
export function extractFileHashes(...texts: (string | null | undefined)[]) {
  const set = new Set<string>()
  for (const t of texts)
    for (const m of (t ?? "").matchAll(/\b[0-9a-f]{2}\/([0-9a-f]{64})\b/g)) set.add(m[1]!)
  return [...set]
}

/** 保存文章时同步引用表 */
export async function syncRefs(entryId: number, hashes: string[]) {
  await db.transaction(async (tx) => {
    await tx.delete(fileRefs).where(eq(fileRefs.entryId, entryId))
    if (!hashes.length) return
    const rows = await tx.select({ id: files.id }).from(files).where(inArray(files.hash, hashes))
    if (rows.length) await tx.insert(fileRefs).values(rows.map((r) => ({ fileId: r.id, entryId })))
    await tx.update(files).set({ orphanSince: null }).where(inArray(files.hash, hashes))
  })
}

const unreferenced = notExists(db.select().from(fileRefs).where(eq(fileRefs.fileId, files.id)))

/** 孤儿检测（定时任务）：上传满一天还没人引用的，标记 orphanSince；重新被引用的清掉标记 */
export async function scanOrphans() {
  const dayAgo = new Date(Date.now() - 86400_000)
  const marked = await db
    .update(files)
    .set({ orphanSince: sql`now()` })
    .where(and(isNull(files.orphanSince), lt(files.createdAt, dayAgo), unreferenced))
    .returning({ id: files.id })
  await db
    .update(files)
    .set({ orphanSince: null })
    .where(
      and(
        isNotNull(files.orphanSince),
        sql`exists (select 1 from ${fileRefs} where ${fileRefs.fileId} = ${files.id})`,
      ),
    )
  return marked.length
}

/** 删除文件和它的衍生图 */
export async function deleteFile(id: number) {
  const [f] = await db.delete(files).where(eq(files.id, id)).returning()
  if (!f) return false
  await Promise.all([f.key, ...f.variants.map((v) => v.key)].map((k) => storage.delete(k)))
  return true
}

/** 清理：删掉已标记为孤儿、而且仍然没人引用的文件（后台手动触发） */
export async function purgeOrphans() {
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(and(isNotNull(files.orphanSince), unreferenced))
  for (const r of rows) await deleteFile(r.id)
  return rows.length
}

export const publicFile = (f: typeof files.$inferSelect) => ({
  ...f,
  url: storage.url(f.key),
  variants: f.variants.map((v) => ({ width: v.width, url: storage.url(v.key) })),
})
