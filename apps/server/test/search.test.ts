import { expect, test } from "bun:test"
import { highlight } from "../src/lib/search"

test("搜索高亮先转义再加 <mark>", () => {
  expect(highlight("<img src=x onerror=alert(1)> \u0001命中\u0002")).toBe(
    "&#60;img src=x onerror=alert(1)&#62; <mark>命中</mark>",
  )
})
