import { RedisClient } from "bun"
import { env } from "../env"

export const redis = new RedisClient(env.REDIS_URL)

const GEN = "content:gen"

/** 内容缓存：key 带代号，invalidate() 把代号 +1，旧 key 等过期 */
export async function cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const gen = (await redis.get(GEN)) ?? "0"
  const k = `cache:${gen}:${key}`
  const hit = await redis.get(k)
  if (hit) return JSON.parse(hit) as T
  const value = await fn()
  if (value !== undefined && value !== null) await redis.set(k, JSON.stringify(value), "EX", ttl)
  return value
}
export const invalidate = () => redis.incr(GEN)

/** 固定窗口限流，超出返回 false */
export async function rateLimit(key: string, limit: number, windowSec: number) {
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`
  const n = await redis.incr(k)
  if (n === 1) await redis.expire(k, windowSec)
  return n <= limit
}
