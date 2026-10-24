import { generateObject, generateText } from "ai"
import { z } from "zod"
import { env } from "../env"

// AI_MODEL 形如 anthropic/claude-haiku-4-5，走 AI Gateway
export const aiEnabled = Boolean(env.AI_MODEL)
const model = () => env.AI_MODEL!

export async function summarize(title: string, body: string) {
  const { text } = await generateText({
    model: model(),
    system: "你给博客文章写摘要：一段中文，不超过 120 字，不用「本文」开头，不加引号。",
    prompt: `# ${title}\n\n${body.slice(0, 12000)}`,
  })
  return text.trim()
}

export async function translate(title: string, body: string, lang: string) {
  const { object } = await generateObject({
    model: model(),
    schema: z.object({ title: z.string(), body: z.string() }),
    system: `把 Markdown 博客文章翻译成 ${lang}。保留 Markdown 结构、代码块、链接、:::指令 原样不译。`,
    prompt: JSON.stringify({ title, body }),
  })
  return object
}

export async function moderate(body: string, author: string) {
  const { object } = await generateObject({
    model: model(),
    schema: z.object({ verdict: z.enum(["approved", "spam"]), reason: z.string() }),
    system: "你是博客评论审核。广告、引流、辱骂、无意义灌水判 spam；批评、提问、闲聊都算正常评论。",
    prompt: `作者：${author}\n评论：${body.slice(0, 2000)}`,
  })
  return object
}
