import { Umami } from "@umami/node"
import { env } from "../env"
import { log } from "./log"

// 没填 UMAMI_URL / UMAMI_WEBSITE_ID 就不发
const umami =
  env.UMAMI_URL && env.UMAMI_WEBSITE_ID
    ? new Umami({ hostUrl: env.UMAMI_URL, websiteId: env.UMAMI_WEBSITE_ID })
    : null

/**
 * 服务端自定义事件（只在服务端能确定的动作：评论、按 IP 去重后的点赞）。
 * 带上访客的 IP 和 UA，否则 Umami 会把所有事件记在 API 服务器头上。
 * 发送失败只记日志，不影响请求。
 */
export function trackServer(
  name: string,
  visitor: { ip: string; userAgent: string | null },
  data?: Record<string, string | number | boolean>,
) {
  if (!umami) return
  umami
    .track({
      name,
      data,
      ip: visitor.ip === "unknown" ? undefined : visitor.ip,
      userAgent: visitor.userAgent ?? undefined,
    })
    .catch((err: unknown) => log.warn({ err, name }, "umami track failed"))
}
