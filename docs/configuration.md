# 配置

优先级：命令行 flag > `SEX_*` 环境变量 > 默认值。规则：

- 空值（包括只有空白的值，以及 compose 里 `${VAR:-}` 传入的空串）视为未设置。
- 布尔值接受 `1/true/yes/on` 和 `0/false/no/off`，大小写不敏感。
- 非法值在启动时直接失败：CLI 打印 `error: CONFIG_INVALID: <变量名> must be ...` 并以退出码 2 结束。

## 可选能力

| 能力 | 开启方式 | 依赖它的功能 |
|---|---|---|
| 浏览器 | `--lightpanda`（启动本地 Lightpanda 子进程，`dist/sex` 内置；从源码运行时从 PATH / `--lightpanda-path` 找；compose 已开启）或 `--cdp-url ws://...` | `actions`、JS 渲染页面；`waitFor` 无浏览器时忽略并给 warning |
| 文档转换 | `--docs`（`SEX_DOCS=1`） | PDF 结构化 + 扫描页 OCR、Office / EPUB / RTF 文档、图片 OCR（`image` parser）；不开时 PDF 用 unpdf 抽纯文本，其它文件返回 415 |
| LLM | `--llm-model`（+ `--llm-base-url`、`--llm-api-key`） | `json` / `summary` / `question` / `highlights` 格式、`/v2/extract`、crawl 的 `prompt`、`/v2/crawl/params-preview` |

没开启却用到了对应功能时，直接报 `501 BROWSER_NOT_CONFIGURED` / `501 LLM_NOT_CONFIGURED`。

## Docker Compose

compose 只有一个 `sex` 服务：HTTP API、MCP 和任务都在同一个 sex 进程里，SearXNG 和 Lightpanda 是它的子进程，任务存在 `sex-data` volume（容器里的 `/data`）里。

- compose 通过 `.env` 读取 `SEX_LLM_*`、`SEX_DOCS` 和 `SEX_SEARXNG_URL`。其它 `SEX_*` 变量（如 `SEX_CORS_ORIGINS`、`SEX_ALLOWED_HOSTS`）不会自动传入容器，需要加到 `compose.yaml` 里 `sex` 服务的 `environment` 下。
- 镜像里是单文件二进制 `sex`（内置 here-docs），`SEX_DOCS` 默认关闭，在 `.env` 里设 `SEX_DOCS=1` 开启；任务存在 `/data`（compose 挂了 `sex-data` volume）。
- `dist/sex` 内置 Lightpanda，compose 给 sex 设了 `SEX_LIGHTPANDA=1`，所以没有单独的 `lightpanda` 服务：sex 进程自己启动、管理一个子进程，空闲时约 13 MB 内存。内置不等于开启，是否使用仍由 `SEX_LIGHTPANDA` 决定。详见[浏览器](browser.md)。

## sex-lite

sex-lite 的能力和配置：

- 能力：搜索（可带 `scrapeOptions`）；抓取支持 `markdown` / `html` / `rawHtml` / `rawBase64` / `links` / `images` / `attributes` 格式，HTML 用 Defuddle 提取，PDF 用 unpdf 抽纯文本。
- 需要浏览器的选项（`actions`）和 LLM 格式（`json`、`summary` 等）返回 `501`，提示改用 sex；其它路由（如 `/v2/crawl`）是 `404`。
- 配置：只认下表里 SearXNG、抓取、HTTP 相关的那些变量（`PORT`、`HOST`、`SEX_SEARXNG_*`、`SEX_ALLOW_PRIVATE_NETWORK`、`SEX_PROXY_URL`、`SEX_USER_AGENT`、`SEX_CONCURRENCY`、`SEX_TIMEOUT`、`SEX_MAX_BODY_BYTES`、`SEX_EXTRACT_WORKERS`、`SEX_LOG_LEVEL`、`SEX_CORS_ORIGINS`、`SEX_ALLOWED_HOSTS`、`SEX_STRICT_REQUESTS`），含义相同。

## 环境变量

| 环境变量 | 对应 flag | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | `serve --port`（`-p`） | `3002` | 只有 `serve` 读取；HTTP API 和 `/mcp` 共用这个端口 |
| `HOST` | `serve --host` | `127.0.0.1` | 只有 `serve` 读取 |
| `SEX_SEARXNG_URL` | `--searxng-url` | 无（sex 自己运行 SearXNG） | 已部署的 SearXNG 地址；设置后不再启动子进程，见 [SearXNG](searxng.md) |
| `SEX_SEARXNG_PATH` | `--searxng-path` | 内置的二进制 | sex 运行的 SearXNG 可执行文件 |
| `SEX_SEARXNG_SETTINGS` | `--searxng-settings` | 内置的最小配置 | sex 运行的 SearXNG 用的 `settings.yml` |
| `SEX_LIGHTPANDA` | `--lightpanda` | `false` | 启动本地 Lightpanda 子进程；compose 里已设为 `1` |
| `SEX_LIGHTPANDA_PATH`（回退 `LIGHTPANDA_EXECUTABLE_PATH`） | `--lightpanda-path` | 内置的二进制，没有时从 PATH 查找 | Lightpanda 可执行文件 |
| `SEX_CDP_URL` | `--cdp-url` | 无 | 已有 CDP 浏览器（Chrome）的地址，如 `ws://127.0.0.1:9222`；和 `SEX_LIGHTPANDA` 同时设置时以它为准。地址是回环时流量经 `EgressProxy`，否则用 CDP request guard，见[浏览器](browser.md) |
| `SEX_BLOCK_MEDIA` | `--block-media` | `false` | 浏览器路径额外拦截图片和音视频请求；广告拦截（`blockAds`）见[浏览器](browser.md) |
| `SEX_DOCS` | `--docs` | `false` | 用 here-docs 转换 PDF / Office 文档 / 图片（结构化 + 本地 OCR），见[文档转换](documents.md) |
| `SEX_LLM_MODEL` | `--llm-model` | 无（LLM 关闭） | 设置后开启 LLM 功能 |
| `SEX_LLM_SMALL_MODEL` | `--llm-small-model` | 无（用主模型） | 辅助调用用的小模型，和 `SEX_LLM_MODEL` 共用 base URL 和 key，必须同时设置 `SEX_LLM_MODEL`。用于 extract 的分类和生成 schema、crawl `prompt` 转选项、extract 的 `/*` 选页；抽取、summary、question、highlights 仍用主模型；`checkPromptInjection` 的注入检查是安全检查，也始终用主模型，不为省钱降低检出率 |
| `SEX_LLM_BASE_URL`（回退 `OPENAI_BASE_URL`） | `--llm-base-url` | `https://api.openai.com/v1` | OpenAI 兼容接口 |
| `SEX_LLM_API_KEY`（回退 `OPENAI_API_KEY`） | `--llm-api-key` | 无 | LLM API key |
| `SEX_LLM_TIMEOUT` | — | `120000`（毫秒，最小 1000） | 单次 LLM 调用的超时，包括遇到限流时的等待和重试 |
| `SEX_LLM_MAX_INPUT_CHARS` | — | `200000`（最小 1000） | 单次 LLM 调用最多发送的页面字符数 |
| `SEX_ALLOW_PRIVATE_NETWORK` | `--allow-private-network` | `search`/`fetch`：`true`；`serve`：`false` | 是否允许抓取回环、内网、link-local 地址 |
| `SEX_PROXY_URL` | —（只读环境变量，凭据不进进程列表） | 无 | 出站 HTTP(S) 代理，如 `http://user:pass@proxy:3128`。用户给的 URL 的所有抓取（HTTP 路径、浏览器、robots.txt、sitemap、webhook）都走它；sex 自己启动的 SearXNG 也走它（自带 `settings.yml` 时不处理）；LLM、S3 不走。安全影响见[出站代理](proxy.md) |
| `SEX_STEALTH_PROXY_URL` | —（只读环境变量，凭据不进进程列表） | 无 | 第二个出站代理，格式同上。普通抓取被站点拦截（403、429，或连接被重置 / 断开）时换它重试一次；请求 `proxy: "stealth"` 时直接用它。不设置则不重试，行为和以前一样。见[出站代理](proxy.md) |
| `SEX_USER_AGENT` | `--user-agent` | Chrome 桌面 UA | 页面抓取使用的 User-Agent |
| `SEX_CONCURRENCY` | `--concurrency` | `8` | 单进程内同时进行的页面抓取数 |
| `SEX_TIMEOUT` | `--timeout` | `30000`（毫秒，最小 1） | 单页默认超时（请求用到 LLM（LLM 格式或 `checkPromptInjection`）且没传 `timeout` 时至少 60000）|
| `SEX_MAX_BODY_BYTES` | — | `26214400`（25 MiB，最小 1024） | 单次页面下载的响应体上限，也是 `/v2/parse` 上传文件的上限 |
| `SEX_MCP_TOOL_NAMES` | — | `web` | MCP 工具名：`web`（`web_fetch` 等）或 `firecrawl`（firecrawl-mcp 里有的工具用它的名字） |
| `SEX_EXTRACT_WILDCARD_PAGES` | — | `25` | extract 的 URL 以 `/*` 结尾时，最多展开的页面数（请求里的 `limit` 优先） |
| `SEX_DOCS_CONCURRENCY` | — | `min(2, CPU 核数 - 1)`，至少 1 | 同时用 here-docs 转换的文档数，超出的排队（排队时间计入请求的 `timeout`） |
| `SEX_EXTRACT_WORKERS` | — | `min(4, CPU 核数 - 1)`，至少 1 | HTML/PDF 解析的 worker 线程数；`0` 表示在主线程解析 |
| `SEX_DATA_DIR` | `--data-dir` | `serve`：`$XDG_DATA_HOME/sex` 或 `~/.local/share/sex`；Docker：`/data` | 任务数据库和任务队列（SQLite）所在目录，抓到的文档默认也在这里（`documents/`），页面缓存（`cache.sqlite`）和变更追踪（`change-tracking.sqlite`）也在这里；`search` / `fetch` 不使用 |
| `SEX_DOCUMENTS_URL` | `serve --documents-url` | `SEX_DATA_DIR/documents` | 任务抓到的文档存在哪里：`s3://bucket/prefix`（prefix 可省略；endpoint、凭据、region 读 Bun 的 `S3_ENDPOINT`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`S3_REGION`，或对应的 `AWS_*`）或 `file:///绝对路径`，其它值报 `CONFIG_INVALID`。一个 prefix（或目录）只能给一个 sex 实例用。见[任务队列](jobs.md) |
| `SEX_JOB_TTL_MS` | — | `86400000`（24 小时，最小 60000） | 任务结束后的保留时间（从结束时开始算，运行中的任务不会过期） |
| `SEX_CACHE_MAX_AGE_MS` | — | `0`（不用缓存） | 请求没给 `maxAge` 时用的 `maxAge`（毫秒）。`0` 表示请求不给 `maxAge` 时完全不用缓存（不读也不写）；要默认用缓存就设成比如 `172800000`（Firecrawl 的默认值，两天）。见[页面缓存](cache.md#页面缓存) |
| `SEX_CACHE_TTL_MS` | — | `172800000`（两天，最小 60000） | 缓存页面的保留时间，过了就删；请求的 `maxAge` 最大也只到这个值 |
| `SEX_CACHE_MAX_BYTES` | — | `268435456`（256 MiB，最小 1048576） | 缓存占用上限（压缩后的字节数），超出时先删最久没被用到的页面 |
| `SEX_WEBHOOK_SECRET` | —（不提供命令行参数，免得出现在进程列表里） | 空（不签名） | 设了之后，每个 webhook 的请求体用它做 HMAC-SHA256，结果放进请求头 `X-Firecrawl-Signature: sha256=<hex>`。见[Webhook](jobs.md#webhook) |
| `SEX_LOG_LEVEL` | `--log-level` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `SEX_STRICT_REQUESTS` | — | `false` | HTTP API 收到 schema 里没有的请求字段（含 `scrapeOptions` 等嵌套对象里的）时返回 `400`，而不是丢掉；不影响 MCP |
| `SEX_CORS_ORIGINS` | `--cors-origin` | 空（CORS 关闭） | 允许跨域调用 HTTP API 和 MCP 端点的浏览器 origin，逗号分隔，不带路径 |
| `SEX_ALLOWED_HOSTS` | `--allowed-host` | 绑定回环地址时只接受 `localhost` / `127.0.0.1` / `[::1]` | 允许的 `Host` 头主机名，逗号分隔，不带端口 |
