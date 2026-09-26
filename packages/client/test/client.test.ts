import { expect, test } from "bun:test"
import { createClient, unwrap } from "../src"

// 类型烟雾测试：能点出路由、参数有类型；服务端没开时只测错误路径
test("Eden 客户端有类型", async () => {
  const api = createClient("http://127.0.0.1:1")
  const p = api.entries.slug({ slug: "hello" }).get({ query: { type: "post" } })
  await expect(unwrap(p)).rejects.toThrow()
})

test("能拿到真实数据（服务端在跑时）", async () => {
  const api = createClient(process.env.API_URL ?? "http://localhost:3900")
  const ok = await fetch(`${process.env.API_URL ?? "http://localhost:3900"}/health`).then(
    () => true,
    () => false,
  )
  if (!ok) return
  const list = await unwrap(api.entries.get({ query: { type: "post" } }))
  expect(Array.isArray(list.items)).toBe(true)
})
