/*
 * 从 mx-space 导入 AI 设置（供应商、翻译 / 摘要 / 评论审核用的模型和语言）。
 *
 *   MX_DATABASE_URL=postgres://…/mx_core bun src/cli/import-ai.ts
 *
 * 源库只读；已经有 AI 设置时不覆盖。
 */
import { SQL } from "bun"
import { aiSettings, type AiSettings } from "@driftlog/db"
import { db } from "../lib/db"

const url = process.env.MX_DATABASE_URL
if (!url) throw new Error("设置 MX_DATABASE_URL（源库 mx_core 的连接串）")
const src = new SQL(url, { max: 1 })
await src`set default_transaction_read_only = on`

type Model = { model?: string; providerId?: string } | undefined
const [row] = await src`select value from options where name = 'ai'`
if (!row) throw new Error("旧站没有 AI 设置")
const mx = typeof row.value === "string" ? JSON.parse(row.value) : row.value

const task = (m: Model, enabled: boolean) => ({
  enabled: enabled && Boolean(m?.providerId),
  providerId: m?.providerId ?? "",
  model: m?.model ?? "",
})
const lang = (l: string) => (l === "jp" ? "ja" : l)

const value: AiSettings = {
  providers: (mx.providers ?? []).map((p: Record<string, unknown>) => ({
    id: String(p.id),
    name: String(p.name ?? "AI"),
    endpoint: String(p.endpoint ?? ""),
    apiKey: String(p.apiKey ?? ""),
    defaultModel: String(p.defaultModel ?? ""),
    enabled: p.enabled !== false,
  })),
  translation: {
    ...task(mx.translationModel, Boolean(mx.enableTranslation)),
    languages: (mx.translationTargetLanguages ?? ["en", "ja"]).map(lang),
  },
  summary: task(mx.summaryModel, Boolean(mx.enableSummary)),
  moderation: task(mx.commentReviewModel, true),
}

const inserted = await db.insert(aiSettings).values({ id: 1, value }).onConflictDoNothing().returning()
console.log(inserted.length ? `已导入：${value.providers.length} 个供应商` : "已有 AI 设置，没有覆盖")
await src.close()
process.exit(0)
