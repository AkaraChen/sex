# sex

自托管的 Web Search + Web Fetch，目标是做 [Firecrawl](https://firecrawl.dev) v2 API 的 drop-in replacement。

- **搜索**：[SearXNG](https://github.com/searxng/searxng)
- **抓取/清洗**：[Defuddle](https://github.com/kepano/defuddle)（无浏览器时用 linkedom 跑它的 Node 版；有浏览器时把同一份浏览器 bundle 注入页面执行）
- **浏览器（可选）**：[Lightpanda](https://github.com/lightpanda-io/browser)，或任意 CDP 浏览器（Chrome 等）
- **LLM（可选）**：任意 OpenAI 兼容的 `/chat/completions` 接口

- **任务队列（可选）**：配置了 Redis 时，crawl / batch scrape / extract 跑在 [BullMQ](https://bullmq.io) 上，可以开多个 worker 一起处理；不配就用进程内的内存队列

一个二进制，四个主要子命令：`search`、`fetch`、`http`、`mcp`，另外有个 `worker`，用于在 Redis 模式下单独起消费进程。

## 快速开始

```bash
bun install
docker compose up -d searxng        # 或者自己跑一个 SearXNG，记得开启 json format

export SEX_SEARXNG_URL=http://127.0.0.1:8080
bun src/cli.ts search "defuddle"
bun src/cli.ts fetch https://stephango.com/saw
bun src/cli.ts http                  # http://127.0.0.1:3002/docs
bun src/cli.ts mcp                   # stdio
bun src/cli.ts mcp --transport http  # http://127.0.0.1:3003/mcp

bun run build                        # 单文件可执行：dist/sex
```

一键起全套（SearXNG + Lightpanda + Redis + HTTP API + MCP + worker）：

```bash
docker compose up -d
docker compose up -d --scale sex-worker=4   # 加 worker
# HTTP API: http://localhost:3002  (Scalar 文档 /docs，OpenAPI /openapi.json)
# MCP:      http://localhost:3003/mcp
```

## 可选能力

| 能力 | 开启方式 | 依赖它的功能 |
|---|---|---|
| 浏览器 | `--lightpanda`（启动本地 Lightpanda 子进程，二进制从 PATH / `--lightpanda-path` 找）或 `--cdp-url ws://...` | `actions`、JS 渲染页面；`waitFor` 无浏览器时忽略并给 warning |
| LLM | `--llm-model`（+ `--llm-base-url`、`--llm-api-key`） | `json` / `summary` / `question` / `highlights` 格式、`/v2/extract`、crawl 的 `prompt`、`/v2/crawl/params-preview` |

| Redis | `--redis-url redis://...`（`http` / `mcp` / `worker`） | 任务持久化、多进程/多机分担 crawl 和 batch；不配时任务存在内存里，只在当前进程执行 |

没开启却用到了对应功能时，直接报 `501 BROWSER_NOT_CONFIGURED` / `501 LLM_NOT_CONFIGURED`。

所有 flag 都有对应环境变量：`SEX_SEARXNG_URL`、`SEX_LIGHTPANDA`、`SEX_LIGHTPANDA_PATH`、`SEX_CDP_URL`、`SEX_LLM_MODEL`、`SEX_LLM_BASE_URL`（默认 `https://api.openai.com/v1`）、`SEX_LLM_API_KEY`（或 `OPENAI_API_KEY`）、`SEX_ALLOW_PRIVATE_NETWORK`、`SEX_USER_AGENT`、`SEX_CONCURRENCY`（默认 8）、`SEX_TIMEOUT`（默认 30000ms）、`SEX_LOG_LEVEL`、`SEX_REDIS_URL`、`SEX_REDIS_PREFIX`（默认 `sex`）、`SEX_JOB_TTL_MS`（默认 24h）。

## 任务队列

crawl、batch scrape、extract 都是异步任务。任务按页拆分：crawl 先跑一个 `crawl-start` 任务（读 robots.txt 和 sitemap），之后每个页面是一个 `page` 任务，抓完后再把新发现的链接入队；batch 每个 URL 一个任务；extract 整体是一个任务。

- **不配 Redis**：任务状态和队列都在进程内存里，`http` / `mcp` 进程自己执行，重启后丢失。
- **配了 Redis**：任务状态存在 Redis 里（hash、list、set，24 小时后自动过期），任务通过 BullMQ 分发。`http` / `mcp` 默认也会消费任务，加 `--no-worker` 则只负责入队；`sex worker` 是纯消费进程，可以开任意多个。同一个 crawl 的页面会分散到所有 worker 上并行处理，limit、去重和 robots 规则都通过 Redis 原子操作在 worker 之间共享。
- 所有 worker 应使用相同的配置（浏览器、LLM 等），因为页面实际在哪个 worker 上执行是不确定的。

## HTTP API（Firecrawl v2 兼容）

| Endpoint | 说明 |
|---|---|
| `POST /v2/scrape` | 单页抓取 |
| `POST /v2/search` | 搜索（`sources`: web/news/images，`scrapeOptions` 会顺便抓取结果页） |
| `POST /v2/map` | 列出站点 URL（sitemap + 页面链接 + SearXNG `site:`） |
| `POST /v2/crawl`、`GET/DELETE /v2/crawl/{id}`、`GET /v2/crawl/{id}/errors`、`GET /v2/crawl/active`、`POST /v2/crawl/params-preview` | 异步爬取 |
| `POST /v2/batch/scrape`、`GET/DELETE /v2/batch/scrape/{id}`、`GET /v2/batch/scrape/{id}/errors` | 批量抓取 |
| `POST /v2/extract`、`GET /v2/extract/{id}` | LLM 结构化抽取 |

直接用官方 SDK：

```ts
import Firecrawl from "@mendable/firecrawl-js";
const fc = new Firecrawl({ apiUrl: "http://localhost:3002", apiKey: "anything" });
await fc.scrape("https://example.com", { formats: ["markdown"] });
```

`bun test/sdk-smoke.ts http://localhost:3002` 会用官方 JS SDK 把主要接口跑一遍。

**和 Firecrawl 的差异**

- 不鉴权，`Authorization` 头会被忽略。
- 不支持 `screenshot`、`changeTracking`、`branding`、`product`、`menu`、`audio`、`video` 这几种格式，以及 `screenshot` / `pdf` 这两种 action，会返回 `501 NOT_SUPPORTED`。
- `maxAge`、`proxy`、`blockAds` 等参数会接受但忽略，没有缓存也没有代理池。
- crawl 的 `delay` 通过给每个页面任务分配错开的执行时间来实现；`maxConcurrency` 不按单个任务限制，并发由 worker 数和 `SEX_CONCURRENCY` 决定。
- 任务取消后，正在执行的页面会跑完，但结果会被丢弃；还在队列里的任务会被跳过。
- 出于 SSRF 防护，`http` 和 `mcp` 默认拒绝抓取内网和回环地址，可以用 `--allow-private-network` 放开。`search` 和 `fetch` 这两个 CLI 命令默认允许。

## MCP

工具：`web_fetch`、`web_search`、`web_map`、`web_crawl`、`web_crawl_status`、`web_extract`。参数沿用 firecrawl-mcp，只是去掉了 `firecrawl_` 前缀。

```json
{ "mcpServers": { "sex": { "command": "sex", "args": ["mcp"], "env": { "SEX_SEARXNG_URL": "http://127.0.0.1:8080" } } } }
```

## 开发

```bash
bun test          # 单元 + 集成测试（本地 fixture 站点、mock SearXNG、mock LLM，不依赖外网）
SEX_TEST_REDIS_URL=redis://127.0.0.1:6379 bun test   # 任务测试额外跑一遍 Redis/BullMQ 后端
bun check         # 类型检查
bun run lint      # biome
```
