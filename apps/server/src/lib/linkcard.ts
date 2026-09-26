import type { LinkMeta } from "@driftlog/markdown"
import { redis } from "./redis"

/** 链接卡片：只读 <head> 里的 og / title，用 HTMLRewriter 流式解析，缓存一天 */
export async function fetchLinkMeta(url: string): Promise<LinkMeta | null> {
  const key = `linkcard:${url}`
  const hit = await redis.get(key)
  if (hit) return JSON.parse(hit)

  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers: { "user-agent": "DriftlogBot/1.0 (+link-card)", accept: "text/html" },
    redirect: "follow",
  }).catch(() => null)
  if (!res?.ok || !res.headers.get("content-type")?.includes("text/html")) return null

  const meta: LinkMeta = { url }
  let title = ""
  const og = (prop: string, v: string | null) => {
    if (!v) return
    if (prop === "og:title") meta.title = v
    else if (prop === "og:description" || (prop === "description" && !meta.description)) meta.description = v
    else if (prop === "og:image") meta.image = new URL(v, url).href
    else if (prop === "og:site_name") meta.site = v
  }
  await new HTMLRewriter()
    .on("meta", {
      element(el) {
        og(el.getAttribute("property") ?? el.getAttribute("name") ?? "", el.getAttribute("content"))
      },
    })
    .on("head > title", {
      text(t) {
        title += t.text
      },
    })
    .transform(res)
    .arrayBuffer()
  meta.title ??= title.trim() || undefined
  await redis.set(key, JSON.stringify(meta), "EX", 86400)
  return meta
}
