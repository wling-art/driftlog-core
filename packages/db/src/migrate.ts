import { migrate } from "drizzle-orm/bun-sql/migrator"
import { createDb } from "./index"

await migrate(createDb(), { migrationsFolder: new URL("../drizzle", import.meta.url).pathname })
console.log("migrated")
process.exit(0)
