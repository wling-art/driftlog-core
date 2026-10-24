import { treaty, type Treaty } from "@elysiajs/eden"
import type { App } from "@driftlog/server"

export type { App }
export * from "@driftlog/schema"

/** 类型安全的 API 客户端，请求带 cookie */
export function createClient(url: string, options: Treaty.Config = {}) {
  return treaty<App>(url, { ...options, fetch: { credentials: "include", ...options.fetch } })
}
export type Client = ReturnType<typeof createClient>

/** Eden 结果：成功返回 data，失败抛错 */
export async function unwrap<T>(
  p: Promise<{ data: T; error: null } | { data: null; error: { status: unknown; value: unknown } }>,
) {
  const r = await p
  if (r.error) throw Object.assign(new Error(errorMessage(r.error.value)), { status: r.error.status })
  return r.data as Exclude<T, null>
}

function errorMessage(v: unknown): string {
  if (typeof v === "string") return v
  if (v && typeof v === "object") {
    const o = v as { message?: string; summary?: string }
    return o.summary ?? o.message ?? "服务器摆烂了，不是你的问题"
  }
  return "服务器摆烂了，不是你的问题"
}
