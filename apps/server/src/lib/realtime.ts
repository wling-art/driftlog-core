import type { Server } from "bun"
import type { WsEvent } from "@driftlog/schema"
import { redis } from "./redis"
import { log } from "./log"

// WebSocket 广播：经 Valkey 频道转发到各实例
const CHANNEL = "driftlog:events"
export const TOPIC = "site"
let server: Server<unknown> | null = null

// 在线连接和每个连接所在的页面（只记路径，不记 IP）
const conns = new Set<unknown>()
const pages = new Map<unknown, string>()

export async function startRealtime(s: Server<unknown>) {
  server = s
  const sub = await redis.duplicate()
  await sub.subscribe(CHANNEL, (message) => server?.publish(TOPIC, message))
  log.info("realtime ready")
}

export function broadcast(event: WsEvent) {
  return redis.publish(CHANNEL, JSON.stringify(event))
}

// shortcut: 在线人数只算本实例，多实例时改用 Valkey 计数
export function connected(conn: unknown) {
  conns.add(conn)
  publishOnline()
}

export function disconnected(conn: unknown) {
  conns.delete(conn)
  pages.delete(conn)
  publishOnline()
}

export function setPage(conn: unknown, path: string) {
  pages.set(conn, path)
  publishOnline()
}

function publishOnline() {
  const byPage: Record<string, number> = {}
  for (const p of pages.values()) byPage[p] = (byPage[p] ?? 0) + 1
  server?.publish(
    TOPIC,
    JSON.stringify({ type: "online", count: conns.size, pages: byPage } satisfies WsEvent),
  )
}
