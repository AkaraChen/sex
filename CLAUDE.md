# sex

Firecrawl v2 compatible web search (SearXNG) + fetch (Defuddle) as a CLI, HTTP API (Hono + oRPC) and MCP server (`@modelcontextprotocol/server` v2). See README.md for usage.

## Layout

- `src/cli.ts` — citty CLI: `search`, `fetch`, `serve` (alias `http`). There is no separate worker process: `serve` runs crawl/batch/extract tasks itself.
- `src/config.ts` — zod-validated config (`resolveConfig`). Precedence: CLI flag → `SEX_*` env → default. Empty values count as unset; invalid values throw `CONFIG_INVALID`. Tests pass an explicit env object instead of `process.env`.
- `src/errors.ts` — `AppError` and helpers (`badRequest`, `unsupported`, `browserRequired`, `llmRequired`). Throw these, not plain `Error`s.
- `src/log.ts` — leveled logger, stderr only.
- `src/core/` — engine shared by all front-ends (scrape, search, map, crawl, batch, extract, browser, llm)
- `src/core/net.ts` — SSRF guard: `isPrivateIp` / `resolvePublicAddresses` / `assertPublicUrl` (ipaddr.js). `safeFetch` re-checks every redirect hop and connects to the DNS-validated IP (`pinToAddress`) so a second lookup cannot rebind.
- `src/core/extract-pool.ts` + `src/core/extract-worker.ts` — HTML/PDF extraction in a worker-thread pool (`SEX_EXTRACT_WORKERS`, 0 = main thread). `bun run build` embeds the worker as an extra entrypoint.
- `src/core/docs.ts` — `DocsConverter`: PDFs, office documents and images through here-docs (`--docs` / `SEX_DOCS`). One engine per process, started by `serve` warmup (or on first use), run on the main thread (the native engines do not block the event loop). `convertPages` is iterated so `parsers[].maxPages` stops early; the request `timeout` and signal abort it. Off: PDFs go through unpdf in the extract pool, other files are 415.
- `src/core/llm.ts` — LLM client on xsai (`chat` adapter + `generateText`): checks result `status`/`reason`/refusals, narrows errors with `isInstance`, retries 429 per `retry-after` within `SEX_LLM_TIMEOUT`.
- `src/core/json-schema.ts` — Ajv compile (400 on invalid schema) for user JSON Schemas; LLM JSON output is validated against the original schema, since xsai's strict `json_schema` drops keywords like `allOf`/`not`/`if`.
- `src/core/page-script.js` — page-side extractor, imported as text. Runs inside the browser (injected next to Defuddle's bundle) and in Node (via `new Function` on a linkedom document). Keep it a single self-contained function expression.
- `src/core/searxng.ts` — `SearxngService`: the external SearXNG at `SEX_SEARXNG_URL`, or else a SearXNG child process started with `startServer()` from `@searxng-js/searxng` (prebuilt Nuitka binary; `SEX_SEARXNG_PATH` / `SEX_SEARXNG_SETTINGS` override binary and settings.yml). Started lazily (`serve` warmup starts it up front), started again after it exits, cooldown after repeated failed starts (`SEARCH_BACKEND_UNAVAILABLE`). It exits when its stdin pipe closes, so it dies with sex even on SIGKILL. Search code gets the base URL from `engine.searxng.url()`, never from config.
- `src/core/browser.ts` — `BrowserPool`: CDP connections to a Lightpanda child process (`--lightpanda`) or an external browser (`--cdp-url`). The child is spawned lazily, spawned again after it exits, and not respawned for a cooldown after repeated failed starts (`BROWSER_UNAVAILABLE`). On Linux with `setpriv` it runs as `setpriv --pdeathsig TERM -- lightpanda serve ...` so it dies with sex even on SIGKILL (no equivalent on macOS; plain spawn otherwise), and gets `--block-private-networks` unless private networks are allowed (a second line of defence behind the `requestGuard` interception, which stays primary because `--cdp-url` browsers have no such flag).
- `src/core/jobs/` — `JobStore` + `TaskQueue` interfaces. `SqliteJobStore` (`sqlite.ts`, bun:sqlite) keeps job state; `BunqueueTaskQueue` (`queue.ts`) runs tasks on bunqueue's embedded broker. Both use files under `SEX_DATA_DIR` (`jobs.sqlite`, `queue.sqlite`; `serve` defaults to `$XDG_DATA_HOME/sex`) or `:memory:` without one (tests, one-shot CLI). `src/core/tasks.ts` dispatches tasks to the crawl/batch/extract handlers. A task interrupted by a crash is redelivered after a restart; `settle(taskId)` keeps it from counting twice.
- `src/http/router.ts` — oRPC procedures; `src/http/server.ts` — Hono app (Host/Origin checks, CORS, `/health`, `/docs`, MCP over HTTP at `/mcp`)
- `src/mcp/server.ts` — MCP tools (`web_*`) only, mounted at `/mcp` by `src/http/server.ts`; there is no stdio transport, and this module must not import from `src/http/`
- `src/schemas.ts` — Zod schemas mirroring Firecrawl v2 (OpenAPI + MCP params)
- `test/helpers.ts` — fixture site, mock SearXNG and mock LLM servers, `testEngine()`

## Gotchas

- Never pass JS *functions* to `page.evaluate`: Bun's bundler can rename globals like `document` inside them. Pass strings.
- Browser and LLM are optional; features needing them must fail with `browserRequired()` / `llmRequired()` (501).
- here-docs is `--external` in the bundle. `scripts/build.ts` embeds its runtime closure for the target platform file by file (`with { type: "file" }`, via a generated `src/cli.embedded.gen.ts` that registers them and then imports `cli.ts`; it lives in `src/` so the entrypoints' common root, which `extract-pool.ts` relies on, stays `src/`). At runtime `src/core/docs.ts` extracts the files once to `$XDG_CACHE_HOME/sex/docs-<digest>` (native libraries load only from real files) and imports here-docs from there; `--compile-autoload-package-json` is required for that on-disk resolution. From source it imports `here-docs` from node_modules. It resolves to TypeScript source through the `bun` export condition (`customConditions` in tsconfig); there is no `dist/` in a Bun install.
- Content-type checks for "is this markup" use `MARKUP_TYPE` from `src/core/net.ts`; a bare `/xml/` also matches OOXML office documents.
- The SearXNG binary comes from the per-platform optional dependency `@searxng-js/<os>-<cpu>` (linux-x64 glibc ≥ 2.35, darwin-arm64, win32-x64 only); `bun build --compile` embeds the target's one through the package's literal imports, and it is unpacked to `$XDG_CACHE_HOME/searxng-js/` at runtime. Elsewhere (linux-arm64, musl) `SEX_SEARXNG_URL` is required. `@searxng-js/searxng` is pinned to an exact version. `testEngine()` defaults `searxngUrl` to a dead port so tests never start a real SearXNG; tests that run `serve` as a subprocess must set `SEX_SEARXNG_URL`.
- `dist/sex` embeds Lightpanda: the release pinned by version and per-platform SHA-256 in `scripts/lightpanda.ts` (linux x64/arm64 glibc ≥ 2.35, macOS x64/arm64; none for Windows or musl). `scripts/build.ts` downloads it into `$XDG_CACHE_HOME/sex-build`, checks the hash and embeds it zstd-compressed; `findLightpanda` in `src/core/browser.ts` uses an explicit `--lightpanda-path` first, then the embedded one (decompressed once to `$XDG_CACHE_HOME/sex/lightpanda-<version>-<hash>/`), then PATH. Compose has no browser service, but the binary being present enables nothing: `SEX_LIGHTPANDA` decides. Same for here-docs and `SEX_DOCS`.
- Screenshots (format and action) and the pdf action are deliberately unsupported (501), even with a browser.
- User-supplied URLs must only be fetched through `safeFetch` / `assertPublicUrl` (or the browser with its `requestGuard`), never with a bare `fetch`.
- Logs go to stderr only (stdout carries CLI output).
- bunqueue's embedded broker is a process-wide singleton bound to one `dataPath`: every `BunqueueTaskQueue` in a process must use the same path (tests use `:memory:` only; the durability test runs `serve` as a subprocess). Always pass `dataPath` explicitly, or bunqueue reads generic env vars like `DATA_PATH` / `SQLITE_PATH`. `shutdownManager()` runs when the last queue closes. bunqueue is pinned to an exact version (it releases very often); bump it deliberately and rerun the job tests.
- `SEX_REDIS_URL` / `SEX_REDIS_PREFIX` are rejected with `CONFIG_INVALID` (Redis/BullMQ and the `worker` command were removed).
- There is no frontend. HTTP endpoints are oRPC procedures in `src/http/router.ts` mounted in Hono; don't add a frontend bundle or a second routing layer.
- When settings change, update the README env table and this Layout in the same change.

## Commands

- Use Bun, not Node: `bun <file>`, `bun install`, `bun run <script>`, `bun test`, `bun check` (type check, not `tsc`).
- `bun install`
- `bun run verify` — `bun check && bun run lint && bun test`
- `bun run format` — Biome write
- Opt-in suites: `SEX_TEST_SEARXNG=1` (the real SearXNG binary, optionally `SEX_TEST_SEARXNG_PATH`; `bun test test/searxng.test.ts`), `SEX_TEST_CDP_URL=http://127.0.0.1:9222` (browser tests against a running CDP browser) and `SEX_TEST_LIGHTPANDA_PATH=/path/to/lightpanda` (the same browser tests through the spawn path, plus child process lifecycle tests; `bun test test/browser.test.ts`)
- `test/docs.test.ts` runs the real here-docs engines (installed as a dependency) against fixtures in `test/fixtures/`; it skips itself where here-docs cannot start (e.g. Intel macOS).
- `bun run build` (`scripts/build.ts`) — single binary at `dist/sex`, SearXNG, Lightpanda and here-docs embedded (the first build downloads Lightpanda); `--target bun-<os>-<arch>` for other platforms whose packages are installed
