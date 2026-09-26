import { expect, test } from "bun:test"
import { renderComment, renderMarkdown } from "../src"

test("自定义行内语法", async () => {
  const { html } = await renderMarkdown("这是||剧透||、==标记==、++插入++，还有 {GH@innei}。**粗==体==**")
  expect(html).toContain('<span class="md-spoiler">剧透</span>')
  expect(html).toContain("<mark>标记</mark>")
  expect(html).toContain("<ins>插入</ins>")
  expect(html).toContain('href="https://github.com/innei"')
  expect(html).toContain("<strong>粗<mark>体</mark></strong>")
})

test("容器、白名单组件、误伤还原", async () => {
  const md = [
    ":::banner{type=warning}\n小心\n:::",
    ":::details[点开看]\n藏起来的\n:::",
    ":::grid{cols=3}\n![a](/a.png)\n:::",
    "::bilibili{bv=BV1xx411c7mD}",
    "::evil{x=1}",
    "现在是 12:30，note:hi",
    '::link-card{url="https://example.com"}',
  ].join("\n\n")
  const { html } = await renderMarkdown(md, { resolveLinkCard: async (url) => ({ url, title: "示例" }) })
  expect(html).toContain('class="md-banner" data-type="warning"')
  expect(html).toContain("<details><summary>点开看</summary>")
  expect(html).toContain('style="--cols:3"')
  expect(html).toContain("player.bilibili.com")
  expect(html).toContain("不支持的组件：evil")
  expect(html).toContain("12:30，note:hi")
  expect(html).toContain('<a class="md-link-card" href="https://example.com"')
  expect(html).toContain("<strong>示例</strong>")
})

test("代码高亮、公式、mermaid、目录", async () => {
  const r = await renderMarkdown(
    "## 第一节\n\n```ts\nconst a = 1\n```\n\n$E=mc^2$\n\n```mermaid\ngraph TD; A-->B\n```",
  )
  expect(r.html).toContain("shiki")
  expect(r.html).toContain("katex")
  expect(r.html).toContain('<pre class="mermaid">graph TD; A-->B')
  expect(r.toc).toEqual([{ depth: 2, id: "第一节", text: "第一节" }])
})

test("评论被过滤", async () => {
  const html = await renderComment(
    "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> [x](javascript:alert(1)) ||剧透|| ::banner",
  )
  expect(html).not.toContain("<script")
  expect(html).not.toContain("javascript:")
  expect(html).toContain('<span class="md-spoiler">剧透</span>')
})
