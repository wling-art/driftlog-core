# driftlog-core

Bun workspace: `apps/server` (Elysia API) and `packages/{schema,db,markdown,client}`. The web repo consumes these packages through a git submodule, so **every API change is also a change to the web repo's types**: after committing here, update the submodule in `web/` and run its typecheck.

## Commands

```bash
bun run dev          # API on :3900, docs at /openapi (needs .env or defaults; see .env.example)
bun run typecheck    # tsgo (TypeScript 7), not tsc
bun run lint         # oxlint
bun run fmt          # oxfmt
bun test             # needs Postgres + Redis running; backup test runs real pg_dump
bun run db:generate  # drizzle-kit, after editing packages/db/src/schema.ts
bun run db:migrate
bun run build        # bun build --compile → apps/server/dist/driftlog-server
```

`WORKER=off` starts the API without the BullMQ worker.

## Traps (all hit for real)

- **Eden path params**: a path segment whose value is an HTTP method name (`post`, `get`…) is treated as the method. That's why entry detail is `/entries/slug/:slug?type=post`, not `/entries/:type/:slug`. Put such values in the query.
- **Eden query types use the Zod *output* type**: a query field with `.default()` becomes required on the client. Use `.optional()` and default in the handler (see `listQuery`).
- **`Bun.Archive` writes lazy `Bun.file()` blobs as 0 bytes**. Read files with `.bytes()` before archiving (`lib/backup.ts`, regression test in `test/backup.test.ts`).
- **Compiled binary**: `import "reflect-metadata"` must stay the first line of `src/index.ts` (the passkey plugin's tsyringe needs it and bundling reorders imports).
- **Search highlights** are rendered as HTML by the blog: `lib/search.ts` escapes first, then inserts `<mark>`. Keep it that way.
- **Tests share one process**: modules that read `env` at import time are loaded once; don't rely on setting `process.env` inside a test file.
- Content cache: `cached()` keys include a generation counter; call `invalidate()` after any content write instead of deleting keys.

## Conventions

- Shared validation lives in `packages/schema` and is used by the server, OpenAPI, and both web apps' forms.
- Optional integrations (AI, Resend, Sentry, S3, OAuth) turn off silently when their env vars are missing. Keep that behavior.
- First email sign-up becomes the owner; later email sign-ups are rejected. Readers sign in with GitHub/Google.
