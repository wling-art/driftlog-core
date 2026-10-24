import { expect, test } from "bun:test"
import { createClient, unwrap } from "../src"

// 类型烟雾测试：连不上时 unwrap 抛错
test("Eden 客户端有类型", async () => {
  const api = createClient("http://127.0.0.1:1")
  const p = api.entries.slug({ slug: "hello" }).get({ query: { type: "post" } })
  await expect(unwrap(p)).rejects.toThrow()
})
