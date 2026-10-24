import { unified, type Plugin } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import remarkDirective from "remark-directive"
import remarkMath from "remark-math"
import remarkRehype, { type Options as RehypeOptions } from "remark-rehype"
import rehypeSlug from "rehype-slug"
import rehypeAutolinkHeadings, { type Options as AutolinkOptions } from "rehype-autolink-headings"
import rehypeKatex from "rehype-katex"
import rehypeShiki from "@shikijs/rehype"
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize"
import rehypeStringify from "rehype-stringify"
import { visit, SKIP } from "unist-util-visit"
import { toString as mdToString } from "mdast-util-to-string"
import { toString as hastToString } from "hast-util-to-string"
import { h } from "hastscript"
import type { Root as Mdast, Parent, PhrasingContent, RootContent } from "mdast"
import type { Element, Root as Hast } from "hast"
import type { TocItem } from "@driftlog/schema"
import { fromMarkdownExtensions, mentionPlatforms, micromarkExtensions } from "./micromark"

export type LinkMeta = { url: string; title?: string; description?: string; image?: string; site?: string }
export type RenderOptions = {
  /** 取链接卡片的元信息，不传就只显示网址 */
  resolveLinkCard?: (url: string) => Promise<LinkMeta | null>
}
export type Rendered = { html: string; toc: TocItem[]; excerpt: string }

// 接入自定义行内语法
const remarkCustom: Plugin<[], Mdast> = function () {
  const data = this.data()
  ;(data.micromarkExtensions ??= []).push(...micromarkExtensions)
  ;(data.fromMarkdownExtensions ??= []).push(...fromMarkdownExtensions)
}

const bannerTypes = new Set(["info", "warning", "error", "success"])

// 白名单组件：::name，其他名字显示为「不支持」
const components: Record<string, (attrs: Record<string, string>) => Element | null> = {
  video: (a) =>
    a.src?.startsWith("https://") || a.src?.startsWith("/")
      ? h("video", { src: a.src, controls: true, preload: "metadata" })
      : null,
  youtube: (a) =>
    /^[\w-]{11}$/.test(a.id ?? "")
      ? h("iframe.md-embed", {
          src: `https://www.youtube-nocookie.com/embed/${a.id}`,
          allowFullScreen: true,
          loading: "lazy",
          title: "YouTube 视频",
        })
      : null,
  bilibili: (a) =>
    /^BV\w{10}$/.test(a.bv ?? "")
      ? h("iframe.md-embed", {
          src: `https://player.bilibili.com/player.html?bvid=${a.bv}&autoplay=0`,
          allowFullScreen: true,
          loading: "lazy",
        })
      : null,
}

/** 视频网址 → 对应的叶子指令（YouTube、B 站、.mp4 / .webm / .mov） */
export function embedOf(url: string): { name: string; attributes: Record<string, string> } | null {
  const yt = url.match(
    /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)([\w-]{11})/,
  )
  if (yt) return { name: "youtube", attributes: { id: yt[1]! } }
  const bv = url.match(/^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(BV\w{10})/)
  if (bv) return { name: "bilibili", attributes: { bv: bv[1]! } }
  if (/^https:\/\/[^?#]+\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(url))
    return { name: "video", attributes: { src: url } }
  return null
}
// 单独一行的链接：视频变播放器，文字就是网址的变链接卡片
const remarkAutoEmbed: Plugin<[], Mdast> = () => (tree) => {
  visit(tree, "paragraph", (node, index, parent) => {
    if (!parent || index === undefined) return
    const kids = node.children.filter((c) => !(c.type === "text" && !c.value.trim()))
    const link = kids.length === 1 && kids[0]!.type === "link" ? kids[0] : null
    if (!link || !/^https?:\/\//.test(link.url)) return
    const bare = mdToString(link).trim() === link.url
    const embed = embedOf(link.url) ?? (bare ? { name: "link-card", attributes: { url: link.url } } : null)
    if (!embed) return
    ;(parent as Parent).children.splice(index, 1, { type: "leafDirective", ...embed, children: [] } as never)
  })
}

type Directive = Extract<RootContent, { type: "containerDirective" | "leafDirective" | "textDirective" }>

// 指令 → HTML 元素
const remarkContainers: Plugin<[RenderOptions?], Mdast> =
  (opts = {}) =>
  async (tree) => {
    const cards: { node: Directive; url: string }[] = []
    visit(tree, (node, index, parent) => {
      if (
        node.type !== "containerDirective" &&
        node.type !== "leafDirective" &&
        node.type !== "textDirective"
      )
        return
      const d = node as Directive
      const attrs = (d.attributes ?? {}) as Record<string, string>
      const data = (d.data ??= {})
      const labelNode = d.children[0]
      const hasLabel = labelNode?.type === "paragraph" && labelNode.data?.directiveLabel
      const label = hasLabel ? mdToString(labelNode) : ""

      if (d.type === "textDirective") {
        // 行内指令（如 12:30、note:hi）还原成原文
        if (parent && index !== undefined) {
          const text: PhrasingContent = { type: "text", value: `:${d.name}${label ? `[${label}]` : ""}` }
          ;(parent as Parent).children.splice(index, 1, text)
          return [SKIP, index]
        }
        return
      }
      switch (d.name) {
        case "banner": {
          data.hName = "div"
          data.hProperties = {
            className: ["md-banner"],
            dataType: bannerTypes.has(attrs.type ?? "") ? attrs.type : "info",
          }
          return
        }
        case "details": {
          if (hasLabel) d.children.shift()
          data.hName = "details"
          d.children.unshift({
            type: "paragraph",
            data: { hName: "summary" },
            children: [{ type: "text", value: label || "展开" }],
          } as never)
          return
        }
        case "grid": {
          const cols = Math.min(Math.max(Number(attrs.cols) || 2, 1), 4)
          data.hName = "div"
          data.hProperties = { className: ["md-grid"], style: `--cols:${cols}` }
          return
        }
        case "gallery": {
          data.hName = "div"
          data.hProperties = { className: ["md-gallery"] }
          return
        }
        case "link-card": {
          const url = attrs.url ?? label
          if (!/^https?:\/\//.test(url)) break
          cards.push({ node: d, url })
          return
        }
        default: {
          const make = components[d.name]
          const el = make?.(attrs)
          if (el) {
            data.hName = el.tagName
            data.hProperties = el.properties as never
            d.children = []
            return
          }
        }
      }
      data.hName = "div"
      data.hProperties = { className: ["md-unknown"] }
      d.children = [{ type: "paragraph", children: [{ type: "text", value: `不支持的组件：${d.name}` }] }]
    })

    await Promise.all(
      cards.map(async ({ node, url }) => {
        const meta = (await opts.resolveLinkCard?.(url).catch(() => null)) ?? { url }
        const host = new URL(url).host
        const card = h("a.md-link-card", { href: url, target: "_blank", rel: "noopener noreferrer" }, [
          h("span.md-link-card-text", [
            h("strong", meta.title ?? host),
            meta.description ? h("span", meta.description) : null,
            h("small", meta.site ?? host),
          ]),
          meta.image ? h("img", { src: meta.image, alt: "", loading: "lazy" }) : null,
        ])
        node.data = {
          hName: card.tagName,
          hProperties: card.properties as never,
          hChildren: card.children as never,
        }
        node.children = []
      }),
    )
  }

// mermaid、excalidraw 代码块原样放进 <pre class="语言">，不高亮
const drawn = new Set(["mermaid", "excalidraw"])
const remarkMermaid: Plugin<[], Mdast> = () => (tree) => {
  visit(tree, "code", (node) => {
    if (!node.lang || !drawn.has(node.lang)) return
    node.data = {
      hName: "pre",
      hProperties: { className: [node.lang] },
      hChildren: [{ type: "text", value: node.value }],
    }
  })
}

const inlineHandlers: RehypeOptions["handlers"] = {
  spoiler: (state, node) => ({
    type: "element",
    tagName: "span",
    properties: { className: ["md-spoiler"] },
    children: state.all(node),
  }),
  mark: (state, node) => ({ type: "element", tagName: "mark", properties: {}, children: state.all(node) }),
  insert: (state, node) => ({ type: "element", tagName: "ins", properties: {}, children: state.all(node) }),
  mention: (_state, node: { platform: string; user: string }) => {
    const base = mentionPlatforms[node.platform]
    const text = { type: "text" as const, value: `@${node.user}` }
    return base
      ? {
          type: "element",
          tagName: "a",
          properties: { className: ["md-mention"], href: base + node.user, rel: ["noopener"] },
          children: [text],
        }
      : text
  },
}

const lazyImages: Plugin<[], Hast> = () => (tree) => {
  visit(tree, "element", (el) => {
    if (el.tagName === "img") Object.assign(el.properties, { loading: "lazy", decoding: "async" })
    if (el.tagName === "a" && typeof el.properties.href === "string" && /^https?:/.test(el.properties.href))
      Object.assign(el.properties, { target: "_blank", rel: "noopener noreferrer" })
  })
}

function collectToc(tree: Hast): TocItem[] {
  const toc: TocItem[] = []
  visit(tree, "element", (el) => {
    const depth = /^h([2-4])$/.exec(el.tagName)?.[1]
    if (depth && typeof el.properties.id === "string")
      toc.push({ depth: Number(depth), id: el.properties.id, text: hastToString(el) })
  })
  return toc
}

const excerptOf = (tree: Mdast, max = 160) => {
  const text = tree.children
    .filter((n) => n.type === "paragraph")
    .map((n) => mdToString(n))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

const autolink: AutolinkOptions = {
  behavior: "append",
  properties: { className: ["md-anchor"], ariaHidden: "true", tabIndex: -1 },
  content: { type: "text", value: "#" },
}

/** mx-space 的 `::: info 标题` 改写成 `:::banner[标题]{type=info}`；其他名字去掉空格 */
const MX_BANNER: Record<string, string> = {
  info: "info",
  note: "info",
  tip: "info",
  warning: "warning",
  warn: "warning",
  error: "error",
  danger: "error",
  success: "success",
}
export function mxCompat(markdown: string) {
  return markdown.replace(
    /^([ \t]*)(:{3,})[ \t]+([a-zA-Z][\w-]*)[ \t]*(.*)$/gm,
    (_all, indent: string, colons: string, name: string, rest: string) => {
      const lower = name.toLowerCase()
      const label = rest.trim() ? `[${rest.trim().replace(/[[\]]/g, "")}]` : ""
      if (MX_BANNER[lower]) return `${indent}${colons}banner${label}{type=${MX_BANNER[lower]}}`
      return `${indent}${colons}${lower}${label}`
    },
  )
}

/** 文章 / 手记 / 页面：完整语法 */
export async function renderMarkdown(markdown: string, opts: RenderOptions = {}): Promise<Rendered> {
  let excerpt = ""
  let toc: TocItem[] = []
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkCustom)
    .use(remarkDirective)
    .use(remarkMath)
    .use(remarkMermaid)
    .use(remarkAutoEmbed)
    .use(remarkContainers, opts)
    .use(() => (tree: Mdast) => void (excerpt = excerptOf(tree)))
    .use(remarkRehype, { handlers: inlineHandlers })
    .use(rehypeSlug)
    .use(() => (tree: Hast) => void (toc = collectToc(tree)))
    .use(rehypeAutolinkHeadings, autolink)
    .use(rehypeKatex)
    .use(rehypeShiki, {
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
      fallbackLanguage: "text",
      lazy: true,
    })
    .use(lazyImages)
    .use(rehypeStringify)
    .process(mxCompat(markdown))
  return { html: String(file), toc, excerpt }
}

// 评论：只有行内语法，经过 rehype-sanitize
const commentSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "ins"],
  attributes: {
    ...defaultSchema.attributes,
    span: [["className", "md-spoiler"]],
    a: [...(defaultSchema.attributes?.a ?? []), ["className", "md-mention"]],
  },
}
const commentProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkCustom)
  .use(remarkRehype, { handlers: inlineHandlers })
  .use(rehypeSanitize, commentSchema)
  .use(lazyImages)
  .use(rehypeStringify)

export async function renderComment(markdown: string): Promise<string> {
  return String(await commentProcessor.process(markdown))
}
