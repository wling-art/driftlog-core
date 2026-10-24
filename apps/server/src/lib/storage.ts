import { S3Client, type BunFile, type S3File } from "bun"
import { join } from "node:path"
import { env } from "../env"

// 文件存储：本地磁盘或 S3。key 形如 ab/<哈希>.webp
export interface Storage {
  put(key: string, data: Uint8Array | Blob, type: string): Promise<void>
  get(key: string): BunFile | S3File | null
  delete(key: string): Promise<void>
  url(key: string): string
}

export const filesDir = join(env.DATA_DIR, "files")

const local: Storage = {
  async put(key, data) {
    await Bun.write(join(filesDir, key), data, { createPath: true })
  },
  get(key) {
    if (key.includes("..")) return null
    return Bun.file(join(filesDir, key))
  },
  async delete(key) {
    await Bun.file(join(filesDir, key))
      .delete()
      .catch(() => {})
  },
  url: (key) => `${env.PUBLIC_URL}/files/${key}`,
}

function s3(): Storage {
  // 读 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_BUCKET / S3_ENDPOINT
  const client = new S3Client()
  return {
    async put(key, data, type) {
      await client.write(key, data, { type })
    },
    get: (key) => client.file(key),
    delete: (key) => client.delete(key),
    url: (key) => `${env.S3_PUBLIC_URL ?? env.PUBLIC_URL + "/files"}/${key}`,
  }
}

export const storage: Storage = env.STORAGE === "s3" ? s3() : local
