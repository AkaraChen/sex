# sex

Firecrawl v2 compatible web search (SearXNG) + fetch (Defuddle) as a CLI, HTTP API (Hono + oRPC) and MCP server (`@modelcontextprotocol/server` v2). See README.md for usage.

## Layout

- `src/cli.ts` — citty CLI: `search`, `fetch`, `serve` (alias `http`), `worker`
- `src/config.ts` — zod-validated config (`resolveConfig`). Precedence: CLI flag → `SEX_*` env → default. Empty values count as unset; invalid values throw `CONFIG_INVALID`. Tests pass an explicit env object instead of `process.env`.
- `src/errors.ts` — `AppError` and helpers (`badRequest`, `unsupported`, `browserRequired`, `llmRequired`). Throw these, not plain `Error`s.
- `src/log.ts` — leveled logger, stderr only.
- `src/core/` — engine shared by all front-ends (scrape, search, map, crawl, batch, extract, browser, llm)
- `src/core/net.ts` — SSRF guard: `isPrivateIp` / `resolvePublicAddresses` / `assertPublicUrl` (ipaddr.js). `safeFetch` re-checks every redirect hop and connects to the DNS-validated IP (`pinToAddress`) so a second lookup cannot rebind.
- `src/core/extract-pool.ts` + `src/core/extract-worker.ts` — HTML/PDF extraction in a worker-thread pool (`SEX_EXTRACT_WORKERS`, 0 = main thread). `bun run build` embeds the worker as an extra entrypoint.
- `src/core/docs.ts` — `DocsConverter`: PDFs, office documents and images through here-docs (`--docs` / `SEX_DOCS`). One engine per process, started by `serve` / `worker` warmup (or on first use), run on the main thread (the native engines do not block the event loop). `convertPages` is iterated so `parsers[].maxPages` stops early; the request `timeout` and signal abort it. Off: PDFs go through unpdf in the extract pool, other files are 415.
- `src/core/llm.ts` — LLM client on xsai (`chat` adapter + `generateText`): checks result `status`/`reason`/refusals, narrows errors with `isInstance`, retries 429 per `retry-after` within `SEX_LLM_TIMEOUT`.
- `src/core/json-schema.ts` — Ajv compile (400 on invalid schema) for user JSON Schemas; LLM JSON output is validated against the original schema, since xsai's strict `json_schema` drops keywords like `allOf`/`not`/`if`.
- `src/core/page-script.js` — page-side extractor, imported as text. Runs inside the browser (injected next to Defuddle's bundle) and in Node (via `new Function` on a linkedom document). Keep it a single self-contained function expression.
- `src/core/browser.ts` — `BrowserPool`: CDP connections to a Lightpanda child process (`--lightpanda`) or an external browser (`--cdp-url`). The child is spawned lazily, spawned again after it exits, and not respawned for a cooldown after repeated failed starts (`BROWSER_UNAVAILABLE`). On Linux with `setpriv` it runs as `setpriv --pdeathsig TERM -- lightpanda serve ...` so it dies with sex even on SIGKILL (no equivalent on macOS; plain spawn otherwise), and gets `--block-private-networks` unless private networks are allowed (a second line of defence behind the `requestGuard` interception, which stays primary because `--cdp-url` browsers have no such flag).
- `src/core/jobs/` — `JobStore` + `TaskQueue` interfaces with memory and Redis/BullMQ implementations; `src/core/tasks.ts` dispatches tasks to the crawl/batch/extract handlers. Job logic must only go through these interfaces (no in-process job state), so it works across workers.
- `src/http/router.ts` — oRPC procedures; `src/http/server.ts` — Hono app (Host/Origin checks, CORS, `/health`, `/docs`, MCP over HTTP at `/mcp`)
- `src/mcp/server.ts` — MCP tools (`web_*`) only, mounted at `/mcp` by `src/http/server.ts`; there is no stdio transport, and this module must not import from `src/http/`
- `src/schemas.ts` — Zod schemas mirroring Firecrawl v2 (OpenAPI + MCP params)
- `test/helpers.ts` — fixture site, mock SearXNG and mock LLM servers, `testEngine()`

## Gotchas

- Never pass JS *functions* to `page.evaluate`: Bun's bundler can rename globals like `document` inside them. Pass strings.
- Browser and LLM are optional; features needing them must fail with `browserRequired()` / `llmRequired()` (501).
- here-docs is imported only dynamically (`import("here-docs")` in `src/core/docs.ts`) and is `--external` in `bun run build`: its native addons cannot load from a `bun build --compile` binary, so `dist/sex --docs` fails with `DOCS_UNAVAILABLE`, and the Docker image runs `bun src/cli.ts` instead of the binary. It resolves to TypeScript source through the `bun` export condition (`customConditions` in tsconfig); there is no `dist/` in a Bun install.
- Content-type checks for "is this markup" use `MARKUP_TYPE` from `src/core/net.ts`; a bare `/xml/` also matches OOXML office documents.
- The Docker image ships Lightpanda (digest-pinned by `LIGHTPANDA_IMAGE` in the Dockerfile) and compose has no browser service, but the binary being present enables nothing: `SEX_LIGHTPANDA` decides. Same for here-docs and `SEX_DOCS`.
- Screenshots (format and action) and the pdf action are deliberately unsupported (501), even with a browser.
- User-supplied URLs must only be fetched through `safeFetch` / `assertPublicUrl` (or the browser with its `requestGuard`), never with a bare `fetch`.
- Logs go to stderr only (stdout carries CLI output).
- BullMQ needs `ioredis`; don't swap it for Bun's built-in Redis client.
- There is no frontend. HTTP endpoints are oRPC procedures in `src/http/router.ts` mounted in Hono; don't add a frontend bundle or a second routing layer.
- When settings change, update the README env table and this Layout in the same change.

## Commands

- Use Bun, not Node: `bun <file>`, `bun install`, `bun run <script>`, `bun test`, `bun check` (type check, not `tsc`).
- `bun install`
- `bun run verify` — `bun check && bun run lint && bun test`
- `bun run format` — Biome write
- Opt-in suites: `SEX_TEST_REDIS_URL=redis://127.0.0.1:6379 bun test` (job store/queue on Redis), `SEX_TEST_CDP_URL=http://127.0.0.1:9222` (browser tests against a running CDP browser) and `SEX_TEST_LIGHTPANDA_PATH=/path/to/lightpanda` (the same browser tests through the spawn path, plus child process lifecycle tests; `bun test test/browser.test.ts`)
- `test/docs.test.ts` runs the real here-docs engines (installed as a dependency) against fixtures in `test/fixtures/`; it skips itself where here-docs cannot start (e.g. Intel macOS).
- `bun run build` — single binary at `dist/sex` (without here-docs)
