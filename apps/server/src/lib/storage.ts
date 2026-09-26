import { S3Client } from "bun"
import { join } from "node:path"
import { env } from "../env"

// 存储适配层：本地磁盘（默认）或 S3 兼容存储。key 形如 ab/abcdef….webp
export interface Storage {
  put(key: string, data: Uint8Array | Blob, type: string): Promise<void>
  get(key: string): Blob | null
  delete(key: string): Promise<void>
  url(key: string): string
}

const filesDir = join(env.DATA_DIR, "files")

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
  const client = new S3Client() // 读 S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_BUCKET / S3_ENDPOINT
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
export { filesDir }
