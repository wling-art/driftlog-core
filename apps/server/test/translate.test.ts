import { expect, test } from "bun:test"
import { checkStructure } from "../src/lib/translate"

const src = `# 标题

正文 [链接](https://a.com) 与 https://b.com

\`\`\`ts
const x = 1 // 注释
\`\`\`

:::info
提示
:::
`

test("结构一致的译文通过", () => {
  const out = src.replace("正文", "Body").replace("提示", "Note").replace("# 标题", "# Title")
  expect(checkStructure(src, out)).toEqual([])
})

test("代码块被改动、链接丢失、标题缺失都能查出来", () => {
  const out = src
    .replace("// 注释", "// comment")
    .replace("https://a.com", "https://x.com")
    .replace("# 标题\n", "")
  const problems = checkStructure(src, out)
  expect(problems.some((p) => p.includes("code block #1"))).toBe(true)
  expect(problems.some((p) => p.includes("links"))).toBe(true)
  expect(problems.some((p) => p.includes("headings"))).toBe(true)
})

test("缺少 ::: 指令行会报", () => {
  expect(checkStructure(src, src.replace(":::info\n", "").replace("\n:::\n", "\n"))[0]).toContain("directive")
})
