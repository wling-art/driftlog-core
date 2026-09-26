import { splice } from "micromark-util-chunked"
import { classifyCharacter } from "micromark-util-classify-character"
import { resolveAll } from "micromark-util-resolve-all"
import { asciiAlpha, asciiAlphanumeric } from "micromark-util-character"
import type {
  Event,
  Extension,
  Resolver,
  State,
  Token,
  TokenizeContext,
  Tokenizer,
} from "micromark-util-types"
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown"

/*
 * 自定义行内语法（micromark 扩展）：
 *   ||剧透||   ==标记==   ++插入++   {GH@user} 提及
 * 前三种照 micromark-extension-gfm-strikethrough 改写：成对的双字符，里面照常解析行内语法。
 */

type Wrap = "spoiler" | "mark" | "insert"

function doubleMarker(name: Wrap, marker: number): Extension {
  const seqTemp = `${name}SequenceTemporary` as never
  const seq = `${name}Sequence` as never
  const tokenizer = { name, tokenize, resolveAll: resolve }
  return {
    text: { [marker]: tokenizer },
    insideSpan: { null: [tokenizer] },
    attentionMarkers: { null: [marker] },
  }

  function resolve(events: Event[], context: TokenizeContext): Event[] {
    let index = -1
    while (++index < events.length) {
      const closer = events[index]!
      if (closer[0] !== "enter" || closer[1].type !== seqTemp || !closer[1]._close) continue
      let open = index
      while (open--) {
        const opener = events[open]!
        if (opener[0] !== "exit" || opener[1].type !== seqTemp || !opener[1]._open) continue
        closer[1].type = seq
        opener[1].type = seq
        const group: Token = { type: name, start: { ...opener[1].start }, end: { ...closer[1].end } }
        const text: Token = {
          type: `${name}Text` as never,
          start: { ...opener[1].end },
          end: { ...closer[1].start },
        }
        const next: Event[] = [
          ["enter", group, context],
          ["enter", opener[1], context],
          ["exit", opener[1], context],
          ["enter", text, context],
        ]
        const insideSpan = context.parser.constructs.insideSpan.null
        if (insideSpan)
          splice(next, next.length, 0, resolveAll(insideSpan, events.slice(open + 1, index), context))
        splice(next, next.length, 0, [
          ["exit", text, context],
          ["enter", closer[1], context],
          ["exit", closer[1], context],
          ["exit", group, context],
        ])
        splice(events, open - 1, index - open + 3, next)
        index = open + next.length - 2
        break
      }
    }
    for (const e of events) if (e[1].type === seqTemp) e[1].type = "data"
    return events
  }

  function tokenize(this: TokenizeContext, effects: Parameters<Tokenizer>[0], ok: State, nok: State): State {
    const previous = this.previous
    const events = this.events
    let size = 0
    const more: State = (code) => {
      if (code === marker) {
        if (size > 1) return nok(code)
        effects.consume(code)
        size++
        return more
      }
      if (size < 2) return nok(code)
      const token = effects.exit(seqTemp)
      const before = classifyCharacter(previous)
      const after = classifyCharacter(code)
      token._open = !after || (after === 2 && Boolean(before))
      token._close = !before || (before === 2 && Boolean(after))
      return ok(code)
    }
    return (code) => {
      if (previous === marker && events[events.length - 1]?.[1].type !== "characterEscape") return nok(code)
      effects.enter(seqTemp)
      return more(code)
    }
  }
}

// {GH@innei} → 链接到对应平台的主页
export const mentionPlatforms: Record<string, string> = {
  GH: "https://github.com/",
  TW: "https://x.com/",
  TG: "https://t.me/",
}

const mention: Extension = {
  text: {
    123: {
      name: "mention",
      tokenize(effects, ok, nok) {
        let platform = 0
        let user = 0
        const inPlatform: State = (code) => {
          if (asciiAlpha(code) && platform < 4) {
            effects.consume(code)
            platform++
            return inPlatform
          }
          if (code !== 64 || platform === 0) return nok(code)
          effects.exit("mentionPlatform")
          effects.enter("mentionMarker")
          effects.consume(code)
          effects.exit("mentionMarker")
          effects.enter("mentionUser")
          return inUser
        }
        const inUser: State = (code) => {
          if (code !== null && (asciiAlphanumeric(code) || code === 45 || code === 95) && user < 40) {
            effects.consume(code)
            user++
            return inUser
          }
          if (code !== 125 || user === 0) return nok(code)
          effects.exit("mentionUser")
          effects.enter("mentionMarker")
          effects.consume(code)
          effects.exit("mentionMarker")
          effects.exit("mention")
          return ok
        }
        return (code) => {
          effects.enter("mention")
          effects.enter("mentionMarker")
          effects.consume(code)
          effects.exit("mentionMarker")
          effects.enter("mentionPlatform")
          return inPlatform
        }
      },
    },
  },
}

export const micromarkExtensions: Extension[] = [
  doubleMarker("spoiler", 124),
  doubleMarker("mark", 61),
  doubleMarker("insert", 43),
  mention,
]

// mdast：把上面的 token 变成节点
function wrapFromMarkdown(name: Wrap): FromMarkdownExtension {
  return {
    canContainEols: [name],
    enter: {
      [name](token) {
        this.enter({ type: name, children: [] } as never, token)
      },
    },
    exit: {
      [name](token) {
        this.exit(token)
      },
    },
  }
}

export const fromMarkdownExtensions: FromMarkdownExtension[] = [
  wrapFromMarkdown("spoiler"),
  wrapFromMarkdown("mark"),
  wrapFromMarkdown("insert"),
  {
    enter: {
      mention(token) {
        this.enter({ type: "mention", platform: "", user: "" } as never, token)
      },
    },
    exit: {
      mentionPlatform(token) {
        ;(this.stack.at(-1) as unknown as { platform: string }).platform = this.sliceSerialize(token)
      },
      mentionUser(token) {
        ;(this.stack.at(-1) as unknown as { user: string }).user = this.sliceSerialize(token)
      },
      mention(token) {
        this.exit(token)
      },
    },
  },
]

declare module "mdast" {
  interface Spoiler extends Parent {
    type: "spoiler"
    children: PhrasingContent[]
  }
  interface Mark extends Parent {
    type: "mark"
    children: PhrasingContent[]
  }
  interface Insert extends Parent {
    type: "insert"
    children: PhrasingContent[]
  }
  interface Mention extends Node {
    type: "mention"
    platform: string
    user: string
  }
  interface PhrasingContentMap {
    spoiler: Spoiler
    mark: Mark
    insert: Insert
    mention: Mention
  }
  interface RootContentMap {
    spoiler: Spoiler
    mark: Mark
    insert: Insert
    mention: Mention
  }
}
declare module "micromark-util-types" {
  interface TokenTypeMap {
    spoiler: "spoiler"
    spoilerSequence: "spoilerSequence"
    spoilerSequenceTemporary: "spoilerSequenceTemporary"
    spoilerText: "spoilerText"
    mark: "mark"
    markSequence: "markSequence"
    markSequenceTemporary: "markSequenceTemporary"
    markText: "markText"
    insert: "insert"
    insertSequence: "insertSequence"
    insertSequenceTemporary: "insertSequenceTemporary"
    insertText: "insertText"
    mention: "mention"
    mentionMarker: "mentionMarker"
    mentionPlatform: "mentionPlatform"
    mentionUser: "mentionUser"
  }
}
export type { Resolver }
