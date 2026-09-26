import type { Server } from "bun"
import type { WsEvent } from "@driftlog/schema"
import { redis } from "./redis"
import { log } from "./log"

// 实时：本实例内用 Bun 原生 pub/sub；多实例之间用 Valkey 频道转发
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

// ponytail: 在线人数只算本实例，多实例要准就改成 Valkey 里的计数
export function onlineChanged(delta: 1 | -1) {
  online += delta
  server?.publish(TOPIC, JSON.stringify({ type: "online", count: online } satisfies WsEvent))
  return online
}
