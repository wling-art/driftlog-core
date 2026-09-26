import { SQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import * as schema from "./schema"

export * from "./schema"
export { schema }

export function createDb(url = process.env.DATABASE_URL ?? "postgres://postgres@localhost:5432/driftlog") {
  return drizzle({ client: new SQL(url), schema })
}
export type Db = ReturnType<typeof createDb>
