import { generateText, stepCountIs, tool } from "ai"
import { z } from "zod"
import { modelFor } from "./ai"

const FENCE = /^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?\n {0,3}\1[ \t]*$/gm
const URL = /\]\(([^)\s]+)|https?:\/\/[^\s)>\]]+/g

const fences = (s: string) => s.match(FENCE) ?? []
const urls = (s: string) => [...s.matchAll(URL)].map((m) => m[1] ?? m[0]).sort()
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

/** 译文和原文的结构对比，返回不一致的地方；空数组表示通过 */
export function checkStructure(src: string, out: string) {
  const problems: string[] = []
  const a = fences(src)
  const b = fences(out)
  if (a.length !== b.length) problems.push(`code blocks: source has ${a.length}, translation has ${b.length}`)
  else
    a.forEach((block, i) => {
      if (block !== b[i]) problems.push(`code block #${i + 1} was changed; it must be copied verbatim`)
    })
  if (urls(src).join("\n") !== urls(out).join("\n")) problems.push("links or URLs differ from the source")
  const heads = (s: string) => count(s.replace(FENCE, ""), /^#{1,6} /gm)
  if (heads(src) !== heads(out))
    problems.push(`headings: source has ${heads(src)}, translation has ${heads(out)}`)
  const dirs = (s: string) => count(s, /^:{2,}/gm)
  if (dirs(src) !== dirs(out))
    problems.push(`:: directive lines: source has ${dirs(src)}, translation has ${dirs(out)}`)
  return problems
}

const languageName = (lang: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) ?? lang
  } catch {
    return lang
  }
}

const system = (
  language: string,
) => `You are the translation agent of a personal blog. Translate the article into ${language} and deliver it with the submit tool.

Guidelines:
- Call submit once with the full translated title and Markdown body. Do not answer in prose.
- Keep the Markdown structure identical: headings, lists, tables, quotes, footnotes, emphasis, blank lines.
- Never change: fenced code blocks, inline code, URLs, image paths, HTML tags, ::: directives and their {attributes}, math ($...$) and {GH@user}-style mentions.
- Do translate: directive titles in [brackets], image alt text and link text.
- Keep product names, proper nouns and technical terms in their original form when that is the norm in ${language}.
- Keep the author's voice: first person, casual. Add no notes, explanations or summary.
- If submit returns problems, fix exactly those and call submit again.`

const MAX_STEPS = 4

/** 翻译 agent：模型用 submit 交卷，结构对不上就把问题退回去让它改 */
export async function translateEntry(title: string, body: string, lang: string) {
  const m = await modelFor("translation")
  if (!m) throw new Error("翻译没开，或者没有可用的供应商")

  let done: { title: string; body: string } | undefined
  let last: string[] = []
  await generateText({
    model: m.model,
    system: system(languageName(lang)),
    prompt: `<title>${title}</title>\n<article>\n${body}\n</article>`,
    tools: {
      submit: tool({
        description: "Submit the finished translation.",
        inputSchema: z.object({ title: z.string(), body: z.string() }),
        execute: async (t) => {
          last = checkStructure(body, t.body)
          if (!t.title.trim() || !t.body.trim()) last.push("title and body must not be empty")
          if (last.length === 0) {
            done = t
            return "ok"
          }
          return `Problems:\n${last.map((p) => `- ${p}`).join("\n")}`
        },
      }),
    },
    stopWhen: [() => Boolean(done), stepCountIs(MAX_STEPS)],
  })
  if (!done) throw new Error(`译文没通过结构检查：${last.join("；") || "模型没有交卷"}`)
  return { ...done, model: m.id }
}
