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

**Databases**: real content lives in `driftlog` on the home server (`HuaweiLocal`, Postgres 17 in the `postgresql` container). The old mx-space database `mx_core` on the same server is **read-only for us**: never write to it. Tests (`bun test`) run against the **local empty** `driftlog` database (`postgres://postgres@localhost:5432/driftlog`), never the remote one; `apps/server/.env` points dev at the remote DB, so run tests from the repo root where that `.env` isn't loaded.

**Importing from mx-space** (re-runnable; upserts by source id into `legacy_id`; connection is forced read-only and aborts otherwise):

```bash
cd apps/server
MX_DATABASE_URL=postgres://…/mx_core MX_STATIC_DIR=…/mx-space/static DATABASE_URL=postgres://…/driftlog DATA_DIR=… bun src/cli/import-mx.ts
```

Rebuild the Meilisearch index (after restoring a DB or first deploy): `bun src/cli/reindex.ts` (needs `MEILI_URL`, `MEILI_KEY`).

After changing the markdown pipeline, re-render stored entries (keeps `updated_at`; translations only store HTML, so they can't be re-rendered):

```bash
cd apps/server && bun src/cli/rerender.ts   # dry run: which entries would change
bun src/cli/rerender.ts --write
```

The old image host is gone: the import reads `/api/v*/objects/<kind>/<name>` files from `MX_STATIC_DIR` (copy of `/root/mx-space/core/data/mx-space/static` on the home server) into our storage and rewrites URLs. Notes get `slug = nid` so old `/notes/12` links keep working; renamed slugs go into `slug_redirects` (served by `GET /entries/resolve`). The renderer's `mxCompat()` handles mx-space syntax (`::: info`, spaced `|| spoilers ||`) without changing stored bodies.

## Traps (all hit for real)

- **Eden path params**: a path segment whose value is an HTTP method name (`post`, `get`…) is treated as the method. That's why entry detail is `/entries/slug/:slug?type=post`, not `/entries/:type/:slug`. Put such values in the query.
- **Eden query types use the Zod _output_ type**: a query field with `.default()` becomes required on the client. Use `.optional()` and default in the handler (see `listQuery`).
- **`Bun.Archive` writes lazy `Bun.file()` blobs as 0 bytes**. Read files with `.bytes()` before archiving (`lib/backup.ts`, regression test in `test/backup.test.ts`).
- **Compiled binary**: `import "reflect-metadata"` must stay the first line of `src/index.ts` (the passkey plugin's tsyringe needs it and bundling reorders imports).
- **Search highlights** are rendered as HTML by the blog: `lib/search.ts` escapes first, then inserts `<mark>`. Keep it that way.
- **Tests share one process**: modules that read `env` at import time are loaded once; don't rely on setting `process.env` inside a test file.
- Content cache: `cached()` keys include a generation counter; call `invalidate()` after any content write instead of deleting keys.

## Conventions

- Shared validation lives in `packages/schema` and is used by the server, OpenAPI, and both web apps' forms.
- Optional integrations (AI, Resend, Sentry, S3, OAuth) turn off silently when their env vars are missing. Keep that behavior.
- First sign-up (email) becomes the owner, the only one. After that email sign-up is blocked: readers sign in with GitHub / Google only (like mx-space), which needs `GITHUB_CLIENT_ID/SECRET` or `GOOGLE_…` in `.env`; `GET /site` lists the configured ones in `oauth`. The admin only lets the owner in (`/admin/*` is owner-only).
