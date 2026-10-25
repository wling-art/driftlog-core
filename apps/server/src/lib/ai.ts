import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { generateObject, generateText } from "ai"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { aiSettings, type AiSettings } from "@driftlog/db"
import { db } from "./db"

export const emptyAiSettings: AiSettings = {
  providers: [],
  translation: { enabled: false, providerId: "", model: "", languages: ["en", "ja"] },
  summary: { enabled: false, providerId: "", model: "" },
  moderation: { enabled: false, providerId: "", model: "" },
}

export async function getAiSettings(): Promise<AiSettings> {
  const [row] = await db.select().from(aiSettings).where(eq(aiSettings.id, 1))
  return { ...emptyAiSettings, ...row?.value }
}

type Task = "translation" | "summary" | "moderation"

/** 某个任务用的模型；没开、没选供应商或供应商停用时返回 null */
export async function modelFor(task: Task, settings?: AiSettings) {
  const s = settings ?? (await getAiSettings())
  const t = s[task]
  const p = s.providers.find((p) => p.id === t.providerId)
  if (!t.enabled || !p?.enabled || !p.apiKey) return null
  const provider = createOpenAICompatible({
    name: p.name,
    baseURL: p.endpoint.replace(/\/$/, ""),
    apiKey: p.apiKey,
  })
  const id = t.model || p.defaultModel
  return { model: provider(id), id }
}

/** 试一下供应商连不连得通 */
export async function testModel(provider: AiSettings["providers"][number], modelId: string) {
  const p = createOpenAICompatible({
    name: provider.name,
    baseURL: provider.endpoint.replace(/\/$/, ""),
    apiKey: provider.apiKey,
  })
  const { text } = await generateText({
    model: p(modelId || provider.defaultModel),
    prompt: "Reply with the single word: ok",
    maxOutputTokens: 16,
  })
  return text.trim()
}

export async function summarize(title: string, body: string) {
  const m = await modelFor("summary")
  if (!m) return null
  const { text } = await generateText({
    model: m.model,
    system: "你给博客文章写摘要：一段中文，不超过 120 字，不用「本文」开头，不加引号。",
    prompt: `# ${title}\n\n${body.slice(0, 12000)}`,
  })
  return text.trim()
}

/** 评论审核；没开审核时返回 null，由调用方放行 */
export async function moderate(body: string, author: string) {
  const m = await modelFor("moderation")
  if (!m) return null
  const { object } = await generateObject({
    model: m.model,
    schema: z.object({ verdict: z.enum(["approved", "spam"]), reason: z.string() }),
    system: "你是博客评论审核。广告、引流、辱骂、无意义灌水判 spam；批评、提问、闲聊都算正常评论。",
    prompt: `作者：${author}\n评论：${body.slice(0, 2000)}`,
  })
  return object
}
