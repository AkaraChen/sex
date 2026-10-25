# sex

自托管的 Web Search + Web Fetch，目标是做 [Firecrawl](https://firecrawl.dev) v2 API 的 drop-in replacement。

- **搜索**：[SearXNG](https://github.com/searxng/searxng)
- **抓取/清洗**：[Defuddle](https://github.com/kepano/defuddle)（无浏览器时用 linkedom 跑它的 Node 版；有浏览器时把同一份浏览器 bundle 注入页面执行）。HTML 和 PDF 的解析在 worker 线程池里进行（`SEX_EXTRACT_WORKERS`）
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

需要 LLM 功能时，先 `cp .env.example .env`，取消注释并填写 `SEX_LLM_MODEL`、`SEX_LLM_API_KEY` 等。

一键起全套（SearXNG + Lightpanda + Redis + HTTP API + MCP + worker）：

```bash
docker compose up -d
docker compose up -d --scale sex-worker=4   # 加 worker
# HTTP API: http://localhost:3002  (Scalar 文档 /docs，OpenAPI /openapi.json)
# MCP:      http://localhost:3003/mcp
```

compose 通过 `.env` 读取 `SEX_LLM_*` 和 `SEARXNG_SECRET`。其它 `SEX_*` 变量（如 `SEX_CORS_ORIGINS`、`SEX_ALLOWED_HOSTS`）不会自动传入容器，需要加到 `compose.yaml` 的 `x-sex` 的 `environment` 里。

## 可选能力

| 能力 | 开启方式 | 依赖它的功能 |
|---|---|---|
| 浏览器 | `--lightpanda`（启动本地 Lightpanda 子进程，二进制从 PATH / `--lightpanda-path` 找）或 `--cdp-url ws://...` | `actions`、JS 渲染页面；`waitFor` 无浏览器时忽略并给 warning |
| LLM | `--llm-model`（+ `--llm-base-url`、`--llm-api-key`） | `json` / `summary` / `question` / `highlights` 格式、`/v2/extract`、crawl 的 `prompt`、`/v2/crawl/params-preview` |
| Redis | `--redis-url redis://...`（`http` / `mcp` / `worker`） | 任务持久化、多进程/多机分担 crawl 和 batch；不配时任务存在内存里，只在当前进程执行 |

没开启却用到了对应功能时，直接报 `501 BROWSER_NOT_CONFIGURED` / `501 LLM_NOT_CONFIGURED`。

### 配置

优先级：命令行 flag > `SEX_*` 环境变量 > 默认值。规则：

- 空值（包括只有空白的值，以及 compose 里 `${VAR:-}` 传入的空串）视为未设置。
- 布尔值接受 `1/true/yes/on` 和 `0/false/no/off`，大小写不敏感。
- 非法值在启动时直接失败：CLI 打印 `error: CONFIG_INVALID: <变量名> must be ...` 并以退出码 2 结束。

| 环境变量 | 对应 flag | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | `http --port`（`-p`） | `3002` | 只有 `http` 读取；`mcp` 的端口用 `--port`，默认 `3003` |
| `HOST` | `http --host` | `127.0.0.1` | 只有 `http` 读取；`mcp --host` 默认 `127.0.0.1` |
| `SEX_SEARXNG_URL` | `--searxng-url` | `http://127.0.0.1:8080` | SearXNG 地址 |
| `SEX_LIGHTPANDA` | `--lightpanda` | `false` | 启动本地 Lightpanda 子进程 |
| `SEX_LIGHTPANDA_PATH`（回退 `LIGHTPANDA_EXECUTABLE_PATH`） | `--lightpanda-path` | 从 PATH 查找 | Lightpanda 可执行文件 |
| `SEX_CDP_URL` | `--cdp-url` | 无 | 已有 CDP 浏览器的地址，如 `ws://127.0.0.1:9222` |
| `SEX_LLM_MODEL` | `--llm-model` | 无（LLM 关闭） | 设置后开启 LLM 功能 |
| `SEX_LLM_BASE_URL`（回退 `OPENAI_BASE_URL`） | `--llm-base-url` | `https://api.openai.com/v1` | OpenAI 兼容接口 |
| `SEX_LLM_API_KEY`（回退 `OPENAI_API_KEY`） | `--llm-api-key` | 无 | LLM API key |
| `SEX_LLM_TIMEOUT` | — | `120000`（毫秒，最小 1000） | 单次 LLM 请求的超时 |
| `SEX_LLM_MAX_INPUT_CHARS` | — | `200000`（最小 1000） | 单次 LLM 调用最多发送的页面字符数 |
| `SEX_ALLOW_PRIVATE_NETWORK` | `--allow-private-network` | `search`/`fetch`：`true`；`http`/`mcp`/`worker`：`false` | 是否允许抓取回环、内网、link-local 地址 |
| `SEX_USER_AGENT` | `--user-agent` | Chrome 桌面 UA | 页面抓取使用的 User-Agent |
| `SEX_CONCURRENCY` | `--concurrency` | `8` | 单进程内同时进行的页面抓取数 |
| `SEX_TIMEOUT` | `--timeout` | `30000`（毫秒，最小 1） | 单页默认超时 |
| `SEX_MAX_BODY_BYTES` | — | `26214400`（25 MiB，最小 1024） | 单次页面下载的响应体上限 |
| `SEX_EXTRACT_WILDCARD_PAGES` | — | `25` | extract 的 URL 以 `/*` 结尾时，最多展开的页面数 |
| `SEX_EXTRACT_WORKERS` | — | `min(4, CPU 核数 - 1)`，至少 1 | HTML/PDF 解析的 worker 线程数；`0` 表示在主线程解析 |
| `SEX_REDIS_URL` | `--redis-url` | 无（内存队列） | BullMQ 和任务存储用的 Redis |
| `SEX_REDIS_PREFIX` | — | `sex` | Redis key 前缀 |
| `SEX_JOB_TTL_MS` | — | `86400000`（24 小时，最小 60000） | 已结束任务的保留时间；crawl 的 `delay × limit` 超过它时会被拒绝 |
| `SEX_LOG_LEVEL` | `--log-level` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `SEX_CORS_ORIGINS` | `--cors-origin` | 空（CORS 关闭） | 允许跨域调用 HTTP API 和 MCP 端点的浏览器 origin，逗号分隔，不带路径 |
| `SEX_ALLOWED_HOSTS` | `--allowed-host` | 绑定回环地址时只接受 `localhost` / `127.0.0.1` / `[::1]` | 允许的 `Host` 头主机名，逗号分隔，不带端口 |

其它 flag：`--worker` / `--no-worker`（`http`、`mcp`：是否在本进程消费任务，默认消费）、`--transport`、`--stateless`（`mcp`）。

## 任务队列

crawl、batch scrape、extract 都是异步任务。任务按页拆分：crawl 先跑一个 `crawl-start` 任务（读 robots.txt 和 sitemap），之后每个页面是一个 `page` 任务，抓完后再把新发现的链接入队；batch 每个 URL 一个任务；extract 整体是一个任务。

- **不配 Redis**：任务状态和队列都在进程内存里，`http` / `mcp` 进程自己执行，重启后丢失。文档内容总量超过 512 MiB 时，会淘汰最早结束的任务。
- **配了 Redis**：任务状态存在 Redis 里（hash、list、set，按 `SEX_JOB_TTL_MS` 过期），任务通过 BullMQ 分发。`http` / `mcp` 默认也会消费任务，加 `--no-worker` 则只负责入队；`sex worker` 是纯消费进程，可以开任意多个。同一个 crawl 的页面会分散到所有 worker 上并行处理，limit、去重和 robots 规则都通过 Redis 原子操作在 worker 之间共享。Redis 故障时，普通存取命令在有限次重试后报错，不会无限挂起；BullMQ 的阻塞消费连接与之分开。
- 所有 worker 应使用相同的配置（浏览器、LLM 等），因为页面实际在哪个 worker 上执行是不确定的。
- `worker` 命令同样默认拒绝内网地址。在 Redis 模式下，如果需要抓取内网站点，要在每个 worker 上都加 `--allow-private-network`，不能只加在 `http` 上。

## HTTP API（Firecrawl v2 兼容）

| Endpoint | 说明 |
|---|---|
| `GET /health` | 健康检查，返回版本，以及 SearXNG / 浏览器 / LLM / 任务存储的状态摘要 |
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
- `maxAge`、`proxy`、`blockAds`、`storeInCache`、搜索的 `location` / `country` / `ignoreInvalidURLs`、extract 的 `allowExternalLinks` 等参数会接受但忽略，没有缓存也没有代理池。
- crawl 的 `delay` 通过给每个页面任务分配错开的执行时间来实现；`maxConcurrency` 不按单个任务限制，并发由 worker 数和 `SEX_CONCURRENCY` 决定。crawl 的 `delay × limit` 超过 `SEX_JOB_TTL_MS` 时直接返回 `400 BAD_REQUEST`。
- crawl 遵守 robots.txt（RFC 9309）：robots.txt 返回 5xx 时视为全部禁止，返回 4xx 时视为全部允许。
- 请求参数有上限，超出时返回 `400 BAD_REQUEST`，例如：`waitFor` ≤ 60000 ms；`timeout` 在 1000–300000 ms；`formats`、`actions`、`includeTags`、`excludeTags`、`includePaths`、`excludePaths`、域名列表 ≤ 20 / 50 / 100 项不等（见 `src/schemas.ts`）；`urls` 批量 ≤ 10000；crawl `limit` ≤ 100000；`delay` ≤ 60 秒。
- 任务取消后，正在执行的页面会跑完，但结果会被丢弃；还在队列里的任务会被跳过。
- 不支持 SDK 的 `watcher()`（WebSocket 推送任务进度），只能轮询。
- 出于 SSRF 防护，`http` 和 `mcp` 默认拒绝抓取内网和回环地址，可以用 `--allow-private-network` 放开。`search` 和 `fetch` 这两个 CLI 命令默认允许。
  - 域名解析后，连接只使用已经通过检查的 IP，因此 DNS rebinding 无法在检查后把请求转到内网。每次重定向都会重新检查。
  - 浏览器模式下，页面发出的子请求同样经过检查（request interception），指向内网的请求会被拦截。
  - 绑定到非回环地址时（如 Docker 里的 `--host 0.0.0.0`），默认不做 Host 检查，需要自己设置 `SEX_ALLOWED_HOSTS`。
- 跨域和 Host 检查：
  - CORS 默认关闭。只有设置 `SEX_CORS_ORIGINS` 后，列出的 origin 才能跨域调用。
  - 请求带 `Origin` 头时，必须属于 `SEX_CORS_ORIGINS`，或与 `Host` 同源，否则返回 `403 ORIGIN_NOT_ALLOWED`。不带 `Origin` 的非浏览器客户端不受影响。
  - 设置 `SEX_ALLOWED_HOSTS` 后，`Host` 头的主机名必须在列表里，否则返回 `403 HOST_NOT_ALLOWED`；未设置时，只有回环绑定会检查 `Host` 是否为 localhost 名。
- 浏览器模式下，PDF 等非 HTML 响应会回退为普通 HTTP 抓取；`skipTlsVerification` 在 Chrome 上生效。

## MCP

工具：`web_fetch`、`web_search`、`web_map`、`web_crawl`、`web_crawl_status`、`web_extract`。参数沿用 firecrawl-mcp，只是把 `firecrawl_` 前缀换成了 `web_`（例如 `firecrawl_scrape` → `web_fetch`）。服务端基于 `@modelcontextprotocol/server` v2。

`sex` 不会自动出现在 PATH 上，配置时用以下任一方式：

- 构建后写绝对路径：`bun run build` 生成 `dist/sex`，Docker 镜像里则是 `/usr/local/bin/sex`。
- 直接用源码：`bun /绝对路径/src/cli.ts mcp`。
- 在仓库里执行 `bun link`，把 `sex` 链接到 PATH（读取 `package.json` 的 `bin` 字段）。

```json
{
  "mcpServers": {
    "sex": {
      "command": "/绝对路径/dist/sex",
      "args": ["mcp"],
      "env": { "SEX_SEARXNG_URL": "http://127.0.0.1:8080" }
    }
  }
}
```

MCP 工具的默认值比 HTTP API 保守，因为结果会进入 LLM 上下文：

- `web_crawl` 的 `limit` 默认 20（HTTP API 默认 10000）。
- `web_map` 的 `limit` 默认 200（HTTP API 默认 5000）。
- `web_crawl_status` 每次返回约 200000 个字符的页面，超出时用 `skip` 翻页；单个超大页面会被截断并标记 `truncated`。
- `web_extract` 最多等待 5 分钟，超时后取消任务并返回错误。

HTTP 传输（`mcp --transport http`，端点 `/mcp`，健康检查 `/health`）始终是无状态的（SDK v2 的行为），`--stateless` 不再有区别。同样适用 Host / Origin 检查，见上文。

## 开发

```bash
bun run verify    # bun check && bun run lint && bun test
bun run format    # biome --write
bun test          # 单元 + 集成测试（本地 fixture 站点、mock SearXNG、mock LLM，不依赖外网）
```

可选的集成测试需要外部服务，没有设置对应变量时会跳过：

```bash
docker compose up -d redis
SEX_TEST_REDIS_URL=redis://127.0.0.1:6379 bun test    # 任务存储和队列的 Redis/BullMQ 后端

SEX_TEST_CDP_URL=http://127.0.0.1:9222 bun test test/browser.test.ts   # 需要一个正在运行的 CDP 浏览器（如 Lightpanda 或 Chrome）
```

其它检查：`bun check`（类型检查），`bun run lint`（Biome）。
