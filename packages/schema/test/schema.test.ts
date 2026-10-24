import { expect, test } from "bun:test"
import { commentInput, entryPatch, linkInput, patchOf } from "../src"

test("PATCH 只带传了的字段，不补默认值", () => {
  expect(entryPatch.parse({ title: "新标题" })).toEqual({ title: "新标题" })
  expect(patchOf(linkInput).parse({ state: "approved" })).toEqual({ state: "approved" })
})

test("网址只收 http(s)", () => {
  const base = { entryId: 1, author: "a", email: "a@example.com", body: "hi" }
  expect(commentInput.safeParse({ ...base, url: "javascript:alert(1)" }).success).toBe(false)
  expect(commentInput.safeParse({ ...base, url: "https://example.com" }).success).toBe(true)
})
