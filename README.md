# sex

A self-hosted Firecrawl v2 API in two processes:

- **firecrawl-local** scrapes: fetch, browser, HTML → markdown, PDFs and office documents. It is Firecrawl's own
  Rust rewrite, running as a child process.
- **SearXNG** searches. This is the one thing firecrawl-local hands to Firecrawl Cloud, and sex answers it locally.
- **sex** is the thin layer in between: the HTTP API, the MCP tools, the CLI, and the warnings for what neither
  process can do.

No queue, no database, no workers. Two child processes, one HTTP surface.

## Run

```bash
bun install
bun run dev                      # http://127.0.0.1:3002
```

`sex` starts firecrawl-local and SearXNG itself. Without a `firecrawl-local` binary on `PATH` (or a built release
that embeds one), point at one:

```bash
SEX_LOCAL_PATH=/path/to/firecrawl-local bun run dev
```

```bash
curl -s localhost:3002/v2/scrape -H 'content-type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}' | jq -r .data.markdown

curl -s localhost:3002/v2/search -H 'content-type: application/json' \
  -d '{"query":"firecrawl","limit":5}' | jq '.data.web'
```

## Routes

| Route | Answered by |
| --- | --- |
| `POST /v2/scrape` | sex → firecrawl-local (formats filtered, unsupported options reported) |
| `POST /v2/search` | sex → SearXNG |
| `POST /v2/map` | firecrawl-local, unchanged |
| `POST /v2/crawl`, `GET` / `DELETE /v2/crawl/{id}` | firecrawl-local, unchanged |
| `POST /v2/batch/scrape`, `GET` / `DELETE /v2/batch/scrape/{id}` | firecrawl-local, unchanged |
| `POST /v2/parse` | firecrawl-local (needs the fork's `/v2/parse` route) |
| `GET /health` | sex |

Crawl and batch jobs live in firecrawl-local's memory and expire an hour after they start.

## Commands

```bash
sex serve                                   # the API
sex scrape https://example.com --markdown
sex search "query" --limit 5
sex map https://example.com
sex parse report.pdf
sex mcp                                     # MCP tools over stdio
```

## What is not here

These belong to Firecrawl Cloud and are reported, not silently ignored:

- `json` and `summary` formats (an LLM endpoint would be a third child process)
- browser `actions`
- persistent crawl/batch jobs and webhooks
- cached scrapes, change tracking, `proxy`/stealth, uploads beyond `/v2/parse`

`/v2/parse` is part of the firecrawl-local fork (see `docs/fork.md`); upstream has no upload route.

## Configuration

| Variable | Effect |
| --- | --- |
| `SEX_HOST`, `SEX_PORT` | Where the API listens (`127.0.0.1:3002`) |
| `SEX_LOCAL_PATH` | The firecrawl-local binary (default: embedded, else `PATH`) |
| `SEX_LOCAL_URL`, `SEX_LOCAL_TOKEN` | Use a running firecrawl-local instead of a child |
| `SEX_CHROME_PATH`, `SEX_BROWSER` | Chrome for JavaScript pages (`auto`, `never`, `always`) |
| `SEX_ALLOW_PRIVATE` | Let firecrawl-local reach loopback and private addresses |
| `SEX_SEARXNG_URL`, `SEX_SEARXNG_PATH` | A running SearXNG, or a binary for the child process |
| `SEX_LOG_LEVEL`, `SEX_TIMEOUT` | stderr log level, child startup and request timeout |

`FIRECRAWL_CLOUD` is forced to `off`: sex never sends a URL to Firecrawl Cloud.

## License

sex is MIT. firecrawl-local is AGPL-3.0 and runs as a separate process; a build that embeds its binary
(`SEX_LOCAL_BINARY`) distributes it and must carry its source and licence. See `docs/fork.md`.
