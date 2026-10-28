# sex

自托管的 Web Search + Web Fetch，目标是做 [Firecrawl](https://firecrawl.dev) v2 API 的 drop-in replacement。

- **搜索**：[SearXNG](https://github.com/searxng/searxng)。默认由 sex 作为子进程启动（预编译二进制来自 [@searxng-js/searxng](https://github.com/AkaraChen/searxng)，`dist/sex` 里内置），也可以用 `SEX_SEARXNG_URL` 指向已部署的实例
- **抓取/清洗**：[Defuddle](https://github.com/kepano/defuddle)（无浏览器时用 linkedom 跑它的 Node 版；有浏览器时把同一份浏览器 bundle 注入页面执行）。HTML 和 PDF 的解析在 worker 线程池里进行（`SEX_EXTRACT_WORKERS`）
- **文档转换（可选）**：[here-docs](https://github.com/AkaraChen/here-docs)，PDF 保留标题、表格等结构，扫描页本地 OCR；还支持 Word / PowerPoint / Excel / OpenDocument / EPUB / RTF 和图片。不开时 PDF 用 unpdf 抽纯文本
- **浏览器（可选）**：[Lightpanda](https://github.com/lightpanda-io/browser)（作为 sex 的子进程运行，`dist/sex` 里内置了固定版本），或任意 CDP 浏览器（Chrome 等）
- **LLM（可选）**：任意 OpenAI 兼容的 `/chat/completions` 接口
- **任务**：crawl / batch scrape / extract 在 `serve` 进程里执行，队列用 [bunqueue](https://bunqueue.dev)（嵌入式），任务状态和队列都存在 SQLite 里（`SEX_DATA_DIR`），抓到的文档存在旁边的 JSONL 文件里（也可以放到 S3），进程重启后接着跑。不需要 Redis，也没有单独的 worker 进程

一个二进制，三个子命令：`search`、`fetch`、`serve`。`serve` 在同一个端口上同时提供 HTTP API 和 MCP（`/mcp`，只有 streamable HTTP，没有 stdio）；`http` 是 `serve` 的旧名，目前仍作为别名保留。

## 快速开始

```bash
bun install                          # 同时装上本平台的 SearXNG 二进制
bun src/cli.ts search "defuddle"     # sex 自己启动 SearXNG 子进程，用完即停
bun src/cli.ts fetch https://stephango.com/saw
bun src/cli.ts serve                 # HTTP API: http://127.0.0.1:3002/docs，MCP: http://127.0.0.1:3002/mcp

bun run build                        # 单文件可执行：dist/sex（内置 SearXNG、Lightpanda 和 here-docs）
```

需要 LLM 功能时，先 `cp .env.example .env`，取消注释并填写 `SEX_LLM_MODEL`、`SEX_LLM_API_KEY` 等。

一键起全套（只有一个 `sex` 服务：HTTP API、MCP 和任务都在同一个 sex 进程里，SearXNG 和 Lightpanda 是它的子进程，任务存在 `sex-data` volume 里）：

```bash
docker compose up -d
# HTTP API: http://localhost:3002  (Scalar 文档 /docs，OpenAPI /openapi.json)
# MCP:      http://localhost:3002/mcp
```

compose 通过 `.env` 读取 `SEX_LLM_*`、`SEX_DOCS` 和 `SEX_SEARXNG_URL`。其它 `SEX_*` 变量（如 `SEX_CORS_ORIGINS`、`SEX_ALLOWED_HOSTS`）不会自动传入容器，需要加到 `compose.yaml` 的 `x-sex` 的 `environment` 里。

镜像里是单文件二进制 `sex`（内置 here-docs），`SEX_DOCS` 默认关闭，在 `.env` 里设 `SEX_DOCS=1` 开启；任务存在 `/data`（compose 挂了 `sex-data` volume）。

`dist/sex` 内置 Lightpanda，compose 给 sex 设了 `SEX_LIGHTPANDA=1`，所以没有单独的 `lightpanda` 服务：sex 进程自己启动、管理一个子进程，空闲时约 13 MB 内存。内置不等于开启，是否使用仍由 `SEX_LIGHTPANDA` 决定。详见[浏览器](#浏览器)。

### SearXNG

不设 `SEX_SEARXNG_URL` 时，sex 自己运行 SearXNG：`serve` 启动时就拉起（冷启动约 1.5 秒，失败则报错退出），`search` / `fetch` 这类一次性命令在第一次搜索时才启动，命令结束时停掉。子进程监听 `127.0.0.1` 的随机端口，每次启动用随机 secret；它退出后下一次搜索会重新启动，60 秒内连续 3 次启动失败则暂停 30 秒（期间搜索返回 `502 SEARCH_BACKEND_UNAVAILABLE`）。sex 被 SIGKILL 时 SearXNG 也会退出（它监听自己的 stdin 管道）。

- 二进制：默认用 `@searxng-js/<平台>` 包里的（`bun install` 按平台装上，`bun run build` 把目标平台的嵌进 `dist/sex`，约 32 MB），第一次运行时解包到 `$XDG_CACHE_HOME/searxng-js/`，它自己再解压到 `$XDG_CACHE_HOME/searxng/`（约 130 MB）。`SEX_SEARXNG_PATH` 可以换成别的二进制。
- 平台：只有 linux-x64（glibc ≥ 2.35）、macOS arm64、Windows x64 有预编译二进制。其它平台（包括 linux-arm64 的 Docker 镜像和 musl）请设 `SEX_SEARXNG_URL`。
- 配置：默认是一份最小的 `settings.yml`（继承 SearXNG 默认值，开启 JSON，关闭 limiter 和 image proxy）。要调整引擎等设置，用 `SEX_SEARXNG_SETTINGS` 指定自己的文件，并保留 `search.formats` 里的 `json`；端口、监听地址和 secret 总是由 sex 设置。
- 资源：常驻内存约 220 MB（onefile 启动器加 SearXNG 进程）。
- 外部实例：设 `SEX_SEARXNG_URL`（或 `--searxng-url`）后不再启动子进程，需要在它的 `settings.yml` 里开启 json format。
- 许可：SearXNG 二进制是 AGPL-3.0-or-later。分发 `dist/sex` 或 Docker 镜像时，需要同时提供对应源码（固定版本的 SearXNG 加 [AkaraChen/searxng](https://github.com/AkaraChen/searxng) 的构建脚本），见 `node_modules/@searxng-js/<平台>/THIRD-PARTY-NOTICES.md`。

## 可选能力

| 能力 | 开启方式 | 依赖它的功能 |
|---|---|---|
| 浏览器 | `--lightpanda`（启动本地 Lightpanda 子进程，`dist/sex` 内置；从源码运行时从 PATH / `--lightpanda-path` 找；compose 已开启）或 `--cdp-url ws://...` | `actions`、JS 渲染页面；`waitFor` 无浏览器时忽略并给 warning |
| 文档转换 | `--docs`（`SEX_DOCS=1`） | PDF 结构化 + 扫描页 OCR、Office / EPUB / RTF 文档、图片 OCR（`image` parser）；不开时 PDF 用 unpdf 抽纯文本，其它文件返回 415 |
| LLM | `--llm-model`（+ `--llm-base-url`、`--llm-api-key`） | `json` / `summary` / `question` / `highlights` 格式、`/v2/extract`、crawl 的 `prompt`、`/v2/crawl/params-preview` |

没开启却用到了对应功能时，直接报 `501 BROWSER_NOT_CONFIGURED` / `501 LLM_NOT_CONFIGURED`。

### 文档转换

`--docs`（`SEX_DOCS=1`）开启后，PDF、Office 文档和图片交给 [here-docs](https://github.com/AkaraChen/here-docs)，它在本地跑 Firecrawl 的 pdf-inspector / anydoc 和 PP-OCR，不依赖任何外部服务：

- **PDF**：能抽出文字的页输出带标题、列表、表格的 Markdown；扫描页和图片页逐页 OCR，按页序合并。`metadata.numPages` 是总页数。
- **Office 等文档**：Word、PowerPoint、Excel、OpenDocument、EPUB、RTF 转成结构化 Markdown，内嵌图片的 OCR 文字插在原位置。
- **图片**（`image/*`）：OCR。请求里显式传了 `parsers` 但不含 `"image"` 时仍返回 415，和 Firecrawl 一致。
- **页数上限**：`parsers: [{ "type": "pdf", "maxPages": N }]` 只转换前 N 页，后面的页不会被解析或 OCR，`warning` 里会说明实际转换了几页。不开 `--docs` 时 unpdf 路径同样遵守 `maxPages`。
- **超时和取消**：转换受请求的 `timeout`（默认 `SEX_TIMEOUT`）约束，超时返回 `408 SCRAPE_TIMEOUT`；客户端断开或任务被取消时立即停止，返回 408。OCR 一页大约几百毫秒，长扫描件需要调大 `timeout` 或用 `maxPages`。
- **资源**：引擎在 `serve` 启动时加载（约 1–3 秒），每个进程一份，空闲时大约 200 MB 内存；OCR 吃 CPU，但跑在原生线程里，不阻塞事件循环。加载失败时 `serve` 直接以 `error: DOCS_UNAVAILABLE: ...` 退出。

**运行方式**：`bun run build` 把 here-docs 和当前平台的原生引擎（约 160 MiB）一起打进 `dist/sex`（约 260 MiB）。原生库只能从磁盘上的真实文件加载，所以开了 `--docs` 后，第一次用到时会把它们解压到 `$XDG_CACHE_HOME/sex/docs-<hash>`（默认 `~/.cache/sex`，约 0.3–0.6 秒，之后复用；换版本自动换目录）。从源码运行（`bun src/cli.ts`）时直接用 `node_modules` 里的 here-docs。`bun scripts/build.ts --target bun-linux-arm64` 等可以构建其它平台，前提是 `node_modules` 里装了那个平台的原生包。支持的平台：Linux x64 / arm64（glibc 和 musl）、macOS arm64、Windows x64；Intel Mac 不支持。

### 浏览器

- **`--lightpanda`**（`SEX_LIGHTPANDA=1`）：sex 自己 spawn 一个 Lightpanda 子进程。`serve` 启动时预热，其它命令在第一次用到浏览器时才启动；子进程退出后，下一次请求会自动重新启动；sex 退出时一起退出。连续启动失败（60 秒内 3 次，例如二进制起不来）后，30 秒内直接返回 `502 BROWSER_UNAVAILABLE`，不会对着坏掉的二进制反复 spawn。
- **`--cdp-url ws://...`**（`SEX_CDP_URL`）：连接已经在运行的 CDP 浏览器，比如 Chrome，或者单独部署的 Lightpanda。sex 不启动任何进程；和 `--lightpanda` 同时设置时以 `--cdp-url` 为准。
- 都不设：不用浏览器。

`dist/sex`（以及 Docker 镜像）内置了 Lightpanda，`--lightpanda` 开箱即用：第一次用到时解压到 `$XDG_CACHE_HOME/sex/lightpanda-<版本>-<hash>/`（约 76 MB），之后复用。版本和每个平台的 SHA-256 固定在 `scripts/lightpanda.ts`（目前是 1.0.2），`bun run build` 第一次会从 GitHub Releases 下载并校验，缓存在 `$XDG_CACHE_HOME/sex-build`，压缩后让 `dist/sex` 增大约 23 MB。预编译版本只有 Linux x64 / arm64（glibc ≥ 2.35）和 macOS x64 / arm64，Windows 和 musl 没有。

从源码运行（`bun src/cli.ts`）时没有内置的二进制，需要自己放到 PATH 上，或用 `--lightpanda-path`（`SEX_LIGHTPANDA_PATH`）指定；`--lightpanda-path` 也会覆盖内置的版本：

```bash
gh release download 1.0.2 -R lightpanda-io/browser -p lightpanda-x86_64-linux -O lightpanda && chmod +x lightpanda
bun src/cli.ts fetch https://example.com --lightpanda --lightpanda-path ./lightpanda
```

**子进程的回收**：`SIGINT` / `SIGTERM` 时 sex 会先关掉子进程再退出，但 `SIGKILL` 无法被捕获。所以在 Linux 上，sex 用 `setpriv --pdeathsig TERM -- lightpanda serve ...` 启动子进程（`setpriv` 属于 util-linux ≥ 2.33，Debian / Ubuntu 和 Docker 镜像里都有）：sex 被 `kill -9` 后，内核会给子进程发 `SIGTERM`，不会留下孤儿。macOS 没有对应机制（pdeathsig 是 Linux 特有的），Linux 上没有 `setpriv` 时也一样，sex 只能直接 spawn，此时 `kill -9` sex 会留下孤儿 Lightpanda 进程，需要自己清理。`lightpanda started` 日志里的 `spawn=setpriv` / `spawn=direct` 标明了实际用的是哪种方式。

**内网保护**：`--allow-private-network` 关闭时（`serve` 默认），子进程会带上 `--block-private-networks`，Lightpanda 在 DNS 解析后再拦一次内网地址，作为 request interception 之外的第二道防线。`--cdp-url` 接外部浏览器时没有这一层，只有 request interception。

### 配置

优先级：命令行 flag > `SEX_*` 环境变量 > 默认值。规则：

- 空值（包括只有空白的值，以及 compose 里 `${VAR:-}` 传入的空串）视为未设置。
- 布尔值接受 `1/true/yes/on` 和 `0/false/no/off`，大小写不敏感。
- 非法值在启动时直接失败：CLI 打印 `error: CONFIG_INVALID: <变量名> must be ...` 并以退出码 2 结束。

| 环境变量 | 对应 flag | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | `serve --port`（`-p`） | `3002` | 只有 `serve` 读取；HTTP API 和 `/mcp` 共用这个端口 |
| `HOST` | `serve --host` | `127.0.0.1` | 只有 `serve` 读取 |
| `SEX_SEARXNG_URL` | `--searxng-url` | 无（sex 自己运行 SearXNG） | 已部署的 SearXNG 地址；设置后不再启动子进程，见 [SearXNG](#searxng) |
| `SEX_SEARXNG_PATH` | `--searxng-path` | 内置的二进制 | sex 运行的 SearXNG 可执行文件 |
| `SEX_SEARXNG_SETTINGS` | `--searxng-settings` | 内置的最小配置 | sex 运行的 SearXNG 用的 `settings.yml` |
| `SEX_LIGHTPANDA` | `--lightpanda` | `false` | 启动本地 Lightpanda 子进程；compose 里已设为 `1` |
| `SEX_LIGHTPANDA_PATH`（回退 `LIGHTPANDA_EXECUTABLE_PATH`） | `--lightpanda-path` | 内置的二进制，没有时从 PATH 查找 | Lightpanda 可执行文件 |
| `SEX_CDP_URL` | `--cdp-url` | 无 | 已有 CDP 浏览器的地址，如 `ws://127.0.0.1:9222`；和 `SEX_LIGHTPANDA` 同时设置时以它为准 |
| `SEX_DOCS` | `--docs` | `false` | 用 here-docs 转换 PDF / Office 文档 / 图片（结构化 + 本地 OCR），见[文档转换](#文档转换) |
| `SEX_LLM_MODEL` | `--llm-model` | 无（LLM 关闭） | 设置后开启 LLM 功能 |
| `SEX_LLM_BASE_URL`（回退 `OPENAI_BASE_URL`） | `--llm-base-url` | `https://api.openai.com/v1` | OpenAI 兼容接口 |
| `SEX_LLM_API_KEY`（回退 `OPENAI_API_KEY`） | `--llm-api-key` | 无 | LLM API key |
| `SEX_LLM_TIMEOUT` | — | `120000`（毫秒，最小 1000） | 单次 LLM 调用的超时，包括遇到限流时的等待和重试 |
| `SEX_LLM_MAX_INPUT_CHARS` | — | `200000`（最小 1000） | 单次 LLM 调用最多发送的页面字符数 |
| `SEX_ALLOW_PRIVATE_NETWORK` | `--allow-private-network` | `search`/`fetch`：`true`；`serve`：`false` | 是否允许抓取回环、内网、link-local 地址 |
| `SEX_USER_AGENT` | `--user-agent` | Chrome 桌面 UA | 页面抓取使用的 User-Agent |
| `SEX_CONCURRENCY` | `--concurrency` | `8` | 单进程内同时进行的页面抓取数 |
| `SEX_TIMEOUT` | `--timeout` | `30000`（毫秒，最小 1） | 单页默认超时 |
| `SEX_MAX_BODY_BYTES` | — | `26214400`（25 MiB，最小 1024） | 单次页面下载的响应体上限 |
| `SEX_EXTRACT_WILDCARD_PAGES` | — | `25` | extract 的 URL 以 `/*` 结尾时，最多展开的页面数 |
| `SEX_EXTRACT_WORKERS` | — | `min(4, CPU 核数 - 1)`，至少 1 | HTML/PDF 解析的 worker 线程数；`0` 表示在主线程解析 |
| `SEX_DATA_DIR` | `--data-dir` | `serve`：`$XDG_DATA_HOME/sex` 或 `~/.local/share/sex`；Docker：`/data` | 任务数据库和任务队列（SQLite）所在目录，抓到的文档默认也在这里（`documents/`）；`search` / `fetch` 不使用 |
| `SEX_DOCUMENTS_URL` | `serve --documents-url` | `SEX_DATA_DIR/documents` | 任务抓到的文档存在哪里：`s3://bucket/prefix`（prefix 可省略；endpoint、凭据、region 读 Bun 的 `S3_ENDPOINT`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`S3_REGION`，或对应的 `AWS_*`）或 `file:///绝对路径`，其它值报 `CONFIG_INVALID`。一个 prefix（或目录）只能给一个 sex 实例用。见[任务队列](#任务队列) |
| `SEX_JOB_TTL_MS` | — | `86400000`（24 小时，最小 60000） | 任务结束后的保留时间（从结束时开始算，运行中的任务不会过期） |
| `SEX_LOG_LEVEL` | `--log-level` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `SEX_CORS_ORIGINS` | `--cors-origin` | 空（CORS 关闭） | 允许跨域调用 HTTP API 和 MCP 端点的浏览器 origin，逗号分隔，不带路径 |
| `SEX_ALLOWED_HOSTS` | `--allowed-host` | 绑定回环地址时只接受 `localhost` / `127.0.0.1` / `[::1]` | 允许的 `Host` 头主机名，逗号分隔，不带端口 |

## 任务队列

crawl、batch scrape、extract 都是异步任务。任务按页拆分：crawl 先跑一个 `crawl-start` 任务（读 robots.txt 和 sitemap），之后每个页面是一个 `page` 任务，抓完后再把新发现的链接入队；batch 每个 URL 一个任务；extract 整体是一个任务。

- **执行**：任务都在 `serve` 进程里跑，同时运行的页面数受 `SEX_CONCURRENCY` 限制。没有单独的 worker 进程。
- **存储**：任务状态（进度、错误、去重集合，以及文档的索引）存在 `SEX_DATA_DIR/jobs.sqlite`，待执行的任务存在 `SEX_DATA_DIR/queue.sqlite`（[bunqueue](https://bunqueue.dev) 的嵌入式 broker）。`serve` 默认用 `$XDG_DATA_HOME/sex`（没设时是 `~/.local/share/sex`），Docker 镜像里是 `/data`。结束的任务在 `SEX_JOB_TTL_MS` 后删除，连同它的文档。
- **文档**：抓到的页面（Firecrawl 的 `Document` JSON，常常一个就几百 KB）不放进 SQLite，SQLite 只记每个文档在哪、多大。存储位置由 `SEX_DOCUMENTS_URL` 决定：
  - 默认：每个任务一个只追加的 `SEX_DATA_DIR/documents/<任务 id>.jsonl`，一行一个文档。读状态页时整页一次读出，直接拼成响应，不做 JSON 解析和重新序列化。
  - `s3://bucket/prefix`：每个文档一个对象 `prefix/<任务 id>/<随机 id>.json`，用 Bun 内置的 S3 客户端，不需要额外依赖。读状态页时每个文档一个 GET，最多 8 个并发。任何 S3 兼容服务都可以（AWS S3、SeaweedFS、MinIO 等）。
  - `file:///path`：和默认一样，只是换一个目录。
  - 没有数据目录时（测试、一次性的 CLI 命令）文档留在内存里。
  - 同一个 S3 prefix（或 `file://` 目录）只能给一个 sex 实例用。sex 只按任务 id 删除它自己删掉的任务的文档，不会去删 bucket 或目录里的其它内容。
- **持久性**：JSONL 文件不做 fsync，和 SQLite 的 `synchronous = NORMAL` 一致：sex 进程崩溃（包括 `kill -9`）不丢已写入的文档，机器断电或系统崩溃可能丢掉最近写入的一部分。S3 的写入在请求返回时就已经持久。先写文档再写索引，所以崩溃最多留下没有索引的字节：JSONL 文件末尾的这部分在下次启动时截掉；S3 上的这种对象随任务一起删除。JSONL 文件被截短（系统崩溃丢了文件末尾）时，启动时把指向截掉部分的索引删掉。读取时从不改索引：某个文档读不到（对象不存在、没有权限、bucket 或 prefix 配错、刚写入还读不到）或者内容不完整时，这一页里跳过它并记一条警告，问题解决后它会重新出现，不会返回坏数据。删除任务时先在同一个事务里删任务、记一条墓碑（`dropped_jobs`），文档删掉之后再删墓碑；删到一半崩溃或者删除失败，墓碑留下，下次清理（启动时和之后每 10 分钟）会重试。
- **重启**：进程重启（包括被 `kill -9`）后，队列里的任务和延迟任务会继续执行；崩溃时正在跑的页面任务在锁过期后重新投递，不会重复计数。
- **单进程**：同一个数据目录同一时间只能有一个 sex 进程在用。
- `SEX_REDIS_URL` / `SEX_REDIS_PREFIX` 已经不再支持，设置了会在启动时报 `CONFIG_INVALID`。

## HTTP API（Firecrawl v2 兼容）

| Endpoint | 说明 |
|---|---|
| `GET /health` | 健康检查，返回版本，以及 SearXNG / 浏览器 / LLM / 任务存储 / 文档存储（`documents`，如 `s3://bucket/prefix`）的状态摘要 |
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
- `parsers` 支持 `"pdf"`（含 `maxPages`）和 `"image"`；PDF parser 的 `mode`、`pages`（`document.pages`）和 `blocks` 会接受但忽略。开了 `--docs` 时 PDF 的 `metadata.title` 不再取自 PDF 元数据（here-docs 不提供），标题以正文里的标题为准。
- 搜索：SearXNG 请求遇到网络错误或 5xx 时，约 400 ms 后重试 1 次（在整体 deadline 内）；结果为空且 SearXNG 报告了 `unresponsive_engines`（如 Google 被 captcha）时，引擎和原因写进 `warning`。不传 `timeout` 时整个搜索（含 scrape）的 deadline 是 `max(SEX_TIMEOUT × 2, 60000)` ms。`includeDomains` 会去掉首尾空白、转小写并校验主机名（不合法返回 `400`），按域名并发的 SearXNG 查询在整个进程内共享 4 个并发。没有搜索结果缓存。
- `links` / `images` 格式取自整个页面（含导航、页脚），不受 `onlyMainContent` 影响，这一点与 Firecrawl 只取主内容不同。`links` 去掉 `#fragment` 后去重、丢掉纯 `#fragment` 链接、保留 `mailto:`；`images` 包含 `srcset` 的全部候选、`<picture>` 的 `source`、`video[poster]` 以及 `og:image` / `og:image:secure_url` / `twitter:image`。`metadata` 里带映射名的 meta 同时有映射名（`ogTitle`）和原名（`og:title`）；`favicon` 只在页面声明时返回。
- crawl 的 `delay` 通过给每个页面任务分配错开的执行时间来实现；`maxConcurrency` 不按单个任务限制，并发由 `SEX_CONCURRENCY` 决定。
- crawl 遵守 robots.txt（RFC 9309）：robots.txt 返回 5xx 时视为全部禁止，返回 4xx 时视为全部允许。
- 请求参数有上限，超出时返回 `400 BAD_REQUEST`，例如：`waitFor` ≤ 60000 ms；`timeout` 在 1000–300000 ms；`formats`、`actions`、`includeTags`、`excludeTags`、`includePaths`、`excludePaths`、域名列表 ≤ 20 / 50 / 100 项不等（见 `src/schemas.ts`）；`urls` 批量 ≤ 10000；crawl `limit` ≤ 100000；`delay` ≤ 60 秒。
- LLM 相关的格式（json / summary / question / highlights）和 extract：
  - 带 JSON Schema 时，模型输出会按原始 schema 校验（Ajv，按 `$schema` 选择 draft-07 / 2019-09 / 2020-12，未写时按 2020-12；`format` 不校验）。输出不是合法 JSON 或不符合 schema 时，会把错误发回给模型修正一次，仍不符合才返回 `502 LLM_INVALID_OUTPUT`。schema 本身不合法时，在开始抓取之前就返回 `400 BAD_REQUEST`。根节点是数组的 schema 会包成 `{ items }` 发给模型（structured output 要求根节点是对象），返回时再拆开。
  - 页面内容放在 `<page>` 等标签里交给模型，system prompt 声明标签内是不可信内容，页面里的同名标签会被转义。页面超过 `SEX_LLM_MAX_INPUT_CHARS` 时截断，并在 `warning` 里说明。
  - `highlights` 和 `query` 格式的 `mode: "directQuote"` 让模型只返回行号，再从页面原文取出对应的行，结果一定是原文。`question` 和默认的 `query` 是自由回答。
  - `checkPromptInjection: true` 时，先用 LLM 检查页面有没有 prompt 注入（按 32000 字符分块、块间重叠 2000），发现后返回 `403 SCRAPE_PROMPT_INJECTION_DETECTED`。检查调用本身失败时放行，并在 `warning` 里说明有内容没检查到。extract 的 `scrapeOptions` 里也可以开。
  - extract 的流程沿用 Firecrawl：只有 prompt 时先让模型生成 schema；schema 里有数组时，先判断是"单一答案"还是"多实体"。多实体的数组字段逐页抽取（每页带 `is_content_relevant`，不相关的页丢掉），其余字段把所有页面一起抽取；多份结果在代码里合并（数组拼接、去重，同一实体的空字段互相补全；标量取第一个非空值），不再让 LLM 合并。
  - 模型输出被截断（达到 token 上限）或被内容过滤拦截时返回 `502 LLM_ERROR`，模型拒答时返回 `502 LLM_REFUSED`，不会把不完整的结果当作正常结果返回。
  - 单个 LLM 格式失败不会让整个 scrape 失败：失败的 `json` 返回 `null`，`summary` / `question` / `highlights` 省略，原因追加到 `warning`（如 `JSON extraction failed: ...`），已抓到的 markdown 等内容照常返回。`403 SCRAPE_PROMPT_INJECTION_DETECTED`、`501 LLM_NOT_CONFIGURED` 和请求取消仍直接报错。extract 本身仍是失败即报错。
  - LLM 接口返回 429（或带 `retry-after` 的 503）时，按 `retry-after` 等待后最多重试 2 次，等待时间算在 `SEX_LLM_TIMEOUT` 内；仍然失败时返回 `429 LLM_RATE_LIMITED`。错误详情里带上游的 request id。
- 任务取消后，正在执行的页面会跑完，但结果会被丢弃；还在队列里的任务会被跳过。
- 不支持 SDK 的 `watcher()`（WebSocket 推送任务进度），只能轮询。
- 出于 SSRF 防护，`serve` 默认拒绝抓取内网和回环地址，可以用 `--allow-private-network` 放开。`search` 和 `fetch` 这两个 CLI 命令默认允许。
  - 域名解析后，连接只使用已经通过检查的 IP，因此 DNS rebinding 无法在检查后把请求转到内网。每次重定向都会重新检查。
  - 浏览器模式下，页面发出的子请求同样经过检查（request interception），指向内网的请求会被拦截。Lightpanda 子进程还会带上 `--block-private-networks` 作为第二道防线（见[浏览器](#浏览器)）。
  - 绑定到非回环地址时（如 Docker 里的 `--host 0.0.0.0`），默认不做 Host 检查，需要自己设置 `SEX_ALLOWED_HOSTS`。
- 跨域和 Host 检查：
  - CORS 默认关闭。只有设置 `SEX_CORS_ORIGINS` 后，列出的 origin 才能跨域调用。
  - 请求带 `Origin` 头时，必须属于 `SEX_CORS_ORIGINS`，或与 `Host` 同源，否则返回 `403 ORIGIN_NOT_ALLOWED`。不带 `Origin` 的非浏览器客户端不受影响。
  - 设置 `SEX_ALLOWED_HOSTS` 后，`Host` 头的主机名必须在列表里，否则返回 `403 HOST_NOT_ALLOWED`；未设置时，只有回环绑定会检查 `Host` 是否为 localhost 名。
- 浏览器模式下，PDF 等非 HTML 响应会回退为普通 HTTP 抓取；`skipTlsVerification` 在 Chrome 上生效。

## MCP

工具：`web_fetch`、`web_search`、`web_map`、`web_crawl`、`web_crawl_status`、`web_extract`。参数沿用 firecrawl-mcp，只是把 `firecrawl_` 前缀换成了 `web_`（例如 `firecrawl_scrape` → `web_fetch`）。服务端基于 `@modelcontextprotocol/server` v2。

MCP 只通过 streamable HTTP 提供：先运行 `sex serve`，端点就是 `http://host:3002/mcp`（默认 `http://127.0.0.1:3002/mcp`），和 HTTP API 在同一个进程、同一个端口上。没有 stdio 传输，也没有 `sex mcp` 命令。

客户端配置，以 Claude Code 为例：

```bash
claude mcp add --transport http sex http://127.0.0.1:3002/mcp
```

或者写进 JSON 配置（例如 Claude Code 项目里的 `.mcp.json`）：

```json
{
  "mcpServers": {
    "sex": {
      "type": "http",
      "url": "http://127.0.0.1:3002/mcp"
    }
  }
}
```

只支持 stdio 的客户端（例如 Claude Desktop 的配置文件）需要用 `mcp-remote` 这类 stdio 转 HTTP 的桥接，或者改用客户端自带的远程 / 自定义 connector 功能。

MCP 工具的默认值比 HTTP API 保守，因为结果会进入 LLM 上下文：

- `web_crawl` 的 `limit` 默认 20（HTTP API 默认 10000）。
- `web_map` 的 `limit` 默认 200（HTTP API 默认 5000）。
- `web_crawl_status` 每次返回约 200000 个字符的页面，超出时用 `skip` 翻页；单个超大页面会被截断并标记 `truncated`。
- `web_extract` 最多等待 5 分钟，超时后取消任务并返回错误。

HTTP 传输（`serve`，端点 `/mcp`）始终是无状态的（SDK v2 的行为）。它和 HTTP API 在同一个进程、同一个端口上，所以 `/health`（JSON）、Host / Origin 检查和 CORS 设置也是同一套，见上文。

## 开发

```bash
bun run verify    # bun check && bun run lint && bun test
bun run format    # biome --write
bun test          # 单元 + 集成测试（本地 fixture 站点、mock SearXNG、mock LLM，不依赖外网；test/docs.test.ts 会真的跑 here-docs，平台不支持时自动跳过）
```

可选的集成测试需要外部服务，没有设置对应变量时会跳过：

```bash
SEX_TEST_CDP_URL=http://127.0.0.1:9222 bun test test/browser.test.ts   # 需要一个正在运行的 CDP 浏览器（如 Lightpanda 或 Chrome）
SEX_TEST_SEARXNG=1 bun test test/searxng.test.ts                      # 启动真的 SearXNG 二进制（可用 SEX_TEST_SEARXNG_PATH 指定），需要外网
SEX_TEST_LIGHTPANDA_PATH=./lightpanda bun test test/browser.test.ts    # 让 sex 自己 spawn 这个 Lightpanda 二进制（取法见「浏览器」一节），跑同一套用例，另加子进程用例：首次 spawn、被杀后重启、close 后无残留、sex 被 SIGKILL 后无孤儿
```

其它检查：`bun check`（类型检查），`bun run lint`（Biome）。
