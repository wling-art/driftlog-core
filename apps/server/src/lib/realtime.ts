import type { Server } from "bun"
import type { WsEvent } from "@driftlog/schema"
import { redis } from "./redis"
import { log } from "./log"

// WebSocket 广播：经 Valkey 频道转发到各实例
const CHANNEL = "driftlog:events"
export const TOPIC = "site"
let server: Server<unknown> | null = null
let online = 0

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
export function onlineChanged(delta: 1 | -1) {
  online += delta
  server?.publish(TOPIC, JSON.stringify({ type: "online", count: online } satisfies WsEvent))
}
