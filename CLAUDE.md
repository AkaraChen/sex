# sex

Firecrawl v2 API, self-hosted: **firecrawl-local** (Rust child process) scrapes, **SearXNG** searches, and sex is the
thin layer in front (HTTP, MCP, CLI, warnings). Bun only.

## Layout

- `packages/local` (`@searxng-js/sex-local`) — the **only** module that knows firecrawl-local exists. `host.ts`
  spawns the binary (`serve --host --port --token`, waits for `/health`, `setpriv --pdeathsig TERM` on Linux,
  SIGTERM→SIGKILL on stop), `resolveBinary` (explicit path → embedded via `registerEmbedded` → `PATH`), `client.ts`
  (HTTP, error mapping, timeouts), `service.ts` (lazy start, restart after exit, 3 failures/60 s → 30 s cooldown).
  Forced `FIRECRAWL_CLOUD=off`. No egress code: SSRF is firecrawl-local's `guard.rs`.
- `packages/search` (`@searxng-js/sex-search`) — `Searxng` (managed child via `@searxng-js/searxng`, or an external
  URL) and `searchWeb` (Firecrawl v2 search shape: `web`/`news`/`images`, categories, `tbs`, domains; one SearXNG
  query per `includeDomain`, because SearXNG cannot OR `site:`).
- `packages/parse` (`@searxng-js/sex-parse`) — `/v2/parse` without a fork: the bytes go to the **here-docs** CLI on
  stdin (`- --filename <name> --json`), its `{ markdown, warnings }` comes back. One process per file, so the native
  OCR engines stay out of sex's process. Not bundled: `SEX_PARSE_PATH`, else `here-docs` on PATH, else 503.
- `apps/sex` — `config.ts` (env only), `engine.ts` (`scrape`: filter formats/options with a warning, then delegate;
  `search`: SearXNG; `parse`: here-docs; map/crawl/batch: pass-through), `http.ts` (Hono, `/v2/*`), `mcp.ts`
  (`web_fetch`, `web_search` over stdio), `cli.ts`, `scripts/build.ts`.
- `docs/fork.md` — the patch list for the firecrawl-local fork.

Packages export TypeScript source (`exports: "./src/index.ts"`); there is no package build step. Only the app is
built (`bun run build` → `dist/sex`).

## Commands

- `bun install`
- `bun run dev` — `apps/sex/src/cli.ts serve`
- `bun run test` — `bun test ./packages ./apps` (mock HTTP servers; no Rust, Chrome or SearXNG needed)
- `bun run check` — `tsc --noEmit`
- `bun run build` — `dist/sex`; `SEX_TARGET=bun-linux-x64` picks the platform,
  `SEX_LOCAL_BINARY=/path/to/firecrawl-local` embeds the binary
- `bun run lint` / `bun run format` — Biome
- CI: `.github/workflows/ci.yml` (check, lint, test, build). Release: pushing a `v*` tag runs
  `.github/workflows/release.yml`, which builds `sex-linux-x64` and `sex-darwin-arm64` with SHA-256 files on native
  runners. Only those two platforms have a prebuilt SearXNG; the firecrawl-local fork is not embedded yet
  (`SEX_LOCAL_BINARY` is the hook).

## Rules

- **Bun only.** No Node support, no per-package `dist`, no npm publishing machinery. Use `Bun.spawn`, `Bun.file`,
  `Bun.serve`, `bun:sqlite` if a cache ever comes back.
- **One seam.** Nothing outside `packages/local` may import `firecrawl-local` details or fetch its routes. A second
  scraper is a new implementation of that package, not an `if` in the app.
- **Parse is a subprocess, not a fork.** `/v2/parse` goes through `packages/parse` → the `here-docs` CLI. Never import
  here-docs into sex (its native engines cannot load from a compiled binary) and never add a parse route to the
  firecrawl-local fork.
- **Refused, not ignored.** Options and formats firecrawl-local cannot honour are deleted from the request and named
  in `data.warning` (`engine.ts` `IGNORED`, `LOCAL_FORMATS`). Add new ones there.
- **Self-hosted.** `FIRECRAWL_CLOUD=off` is set by `LocalService` and is not configurable. No URL goes to Firecrawl.
- **Warnings travel.** A partial result carries `warning`; errors map in `apps/sex/src/errors.ts` (sidecar 4xx passes
  through, 5xx/401/403 → 502, unreachable → 503, timeout → 504).
- Timeouts cross `packages/local` as `CallTime` (`signal` + `deadlineAt`), never as a duration string.
- AGPL: firecrawl-local runs as a **separate process**. Never link the crate and never copy its source into this
  repository.

## Gotchas

- `/v2/parse` is not firecrawl-local's and is not a fork patch: it spawns the `here-docs` CLI. Without that binary
  the route is a 503 `PARSE_UNAVAILABLE`; tests use a stub script.
- firecrawl-local needs a Chrome/Chromium on the machine for JavaScript pages; `SEX_CHROME_PATH` overrides the search.
- Crawl and batch are in firecrawl-local's memory and disappear after an hour.
- `includeDomains` costs one query per domain, capped at 5 with a warning.
- Logs are JSON lines on stderr; stdout is CLI output only.
