import { expect, test } from "bun:test"
import { app } from "../src/app"
import { auth } from "../src/auth"

const loadEnv = (vars: Record<string, string>) =>
  Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(require.resolve("../src/env"))})`], {
    env: { PATH: process.env.PATH!, ...vars },
  }).exitCode

test("生产环境不接受默认的 BETTER_AUTH_SECRET；空值当作没填", () => {
  expect(loadEnv({ NODE_ENV: "production" })).not.toBe(0)
  expect(loadEnv({ NODE_ENV: "production", BETTER_AUTH_SECRET: "x".repeat(32) })).toBe(0)
  expect(loadEnv({ BETTER_AUTH_SECRET: "", MEILI_KEY: "" })).toBe(0)
})

test("其他站点发来的写请求被拒", async () => {
  const post = (origin: string) =>
    app.handle(
      new Request("http://localhost/admin/thoughts", {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: "content=spam",
      }),
    )
  expect((await post("https://evil.example")).status).toBe(403)
  expect((await post("http://localhost:5174")).status).toBe(401)
})

test("只有邮箱注册能成为站长", async () => {
  const before = auth.options.databaseHooks!.user!.create!.before!
  const u = {
    id: "x",
    name: "x",
    email: "x@example.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  const role = async (path: string) =>
    ((await before(u, { path } as never)) as { data: { role: string } }).data.role
  expect(await role("/callback/:id")).toBe("reader")
  expect(await role("/sign-up/email")).toBe("owner")
})
