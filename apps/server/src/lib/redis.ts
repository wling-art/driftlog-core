import { RedisClient } from "bun"
import { env } from "../env"

// Valkey / Redis：缓存、限流、跨实例广播都走 Bun 内置客户端
export const redis = new RedisClient(env.REDIS_URL)

const GEN = "content:gen"

/** 内容缓存：key 里带「代」，写操作把代 +1，旧缓存自然过期（ponytail: 不逐个删 key） */
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

/** 固定窗口限流：超出返回 false */
export async function rateLimit(key: string, limit: number, windowSec: number) {
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`
  const n = await redis.incr(k)
  if (n === 1) await redis.expire(k, windowSec)
  return n <= limit
}
