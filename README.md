# sex

A self-hosted Firecrawl v2 API in three processes:

```
      SDK / MCP / curl
             │
   ┌─────────▼─────────┐
   │ sex               │  HTTP /v2/*, MCP stdio, CLI
   │   engine + config │  过滤不支持的选项，把告警写进 warning
   └───┬───────────┬───┘
       │ loopback  │ loopback
  ┌────▼─────┐  ┌──▼────────┐
  │ SearXNG  │  │ firecrawl │  Rust 子进程
  │ 搜索     │  │  -local   │  抓取 / 浏览器 / HTML→markdown / PDF / office
  └──────────┘  └───────────┘
```

- **firecrawl-local** 抓取：fetch、浏览器、清洗、文档解析。它是 Firecrawl 官方的 Rust 重写，跟云端共用 `apps/api/native` 的清洗代码。
- **SearXNG** 搜索。这是 firecrawl-local 唯一交给 Firecrawl 云的东西，sex 在本地答掉。
- **here-docs** 转换上传的文件（`/v2/parse`）。另一个子进程，MIT，底层就是 `@firecrawl/anydoc` 与 `@firecrawl/pdf-inspector`。
- **sex** 只做中间那层：HTTP API、MCP、CLI，以及两边对不上的东西的告警。

没有队列、数据库、worker。两个子进程，一个 HTTP 面。旧的 17 个包只剩 `packages/local` 和 `packages/search`，**src 1507 行**（原来 13800）。Bun only，没有 Node 支持，也没有逐包构建。

## 现在能用的

| 能力 | 谁做 | 说明 |
| --- | --- | --- |
| `POST /v2/scrape` | firecrawl-local | `formats` 只保留 `markdown` / `html` / `rawHtml` / `links`；其余被删掉并写进 `warning` |
| `POST /v2/search` | SearXNG | `web` / `news` / `images`、分类、时间、域名过滤 |
| `POST /v2/map` | firecrawl-local | 原样透传 |
| `/v2/crawl*`、`/v2/batch/scrape*` | firecrawl-local | 原样透传；job 在它的内存里，1 小时后过期 |
| `POST /v2/parse` | here-docs | 上传文件 → Markdown；here-docs 是独立子进程，没有 fork |
| `web_fetch` / `web_search` | sex | `sex mcp`，stdio |
| `sex search/scrape/map/parse` | sex | CLI，stdout 只放结果，日志走 stderr |

一次 scrape 的输出是 Firecrawl 的 `Document` 形状。被忽略的东西**不会静默消失**，会出现在 `data.warning` 里：

```json
{ "success": true, "data": { "markdown": "…", "warning": "unsupported format(s): json; `actions` is not supported and was ignored" } }
```

## 快速开始

```bash
bun install
bun run dev                       # http://127.0.0.1:3002，会自动拉起两个子进程
```

`firecrawl-local` 需要在本机（`PATH`，或 `SEX_LOCAL_PATH`）；还没有装的话，`SEX_LOCAL_URL` 指向一个已经跑着的实例。SearXNG 不需要准备，`@searxng-js/searxng` 带预编译二进制。`/v2/parse` 需要 `here-docs`（`npm i -g here-docs`，或 `SEX_PARSE_PATH` 指向它的 `dist/cli.js`）；没装时这条路由返回 503，别的照常。

```bash
curl -s localhost:3002/v2/scrape -H 'content-type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}' | jq -r .data.markdown

curl -s localhost:3002/v2/search -H 'content-type: application/json' \
  -d '{"query":"firecrawl","limit":5}' | jq '.data.web'
```

## 构建

```bash
bun run build                          # dist/sex（单文件，Bun + 内嵌 SearXNG）
SEX_TARGET=bun-linux-x64 bun run build  # 指定目标平台
SEX_LOCAL_BINARY=/path/to/firecrawl-local \
SEX_LOCAL_VERSION=0.1.1 bun run build   # 把 firecrawl-local 也嵌进去，运行时解压到 $XDG_CACHE_HOME/sex
```

`dist/sex` 是最小的部署单位。不嵌 firecrawl-local 时，它在运行时从 `PATH` / `SEX_LOCAL_PATH` 找。

## 发布

`v*` 标签触发 `.github/workflows/release.yml`：在原生 runner 上各构建一个二进制，附 SHA-256，发到 GitHub Release。

| 资产 | 平台 |
| --- | --- |
| `sex-linux-x64` | linux x64，glibc ≥ 2.35 |
| `sex-darwin-arm64` | macOS arm64 |

只有这两个平台发二进制，因为 `@searxng-js/searxng` 只给它们预编译的 SearXNG；其他地方需要 `SEX_SEARXNG_URL`。

**firecrawl-local 还没嵌进发布产物**（fork 未发布）：把 `firecrawl-local` 放到 `PATH`，或设 `SEX_LOCAL_PATH` / `SEX_LOCAL_URL`。fork 出来之后，release workflow 里预留的那一步会下载它、校验 SHA-256 并传 `SEX_LOCAL_BINARY`。`/v2/parse` 用的 here-docs 也不打进产物，需要单独装。


## 配置

| 变量 | 作用 |
| --- | --- |
| `SEX_HOST`, `SEX_PORT` | 监听地址，默认 `127.0.0.1:3002` |
| `SEX_LOCAL_PATH` | firecrawl-local 二进制（默认：嵌入的，否则 `PATH`） |
| `SEX_LOCAL_URL`, `SEX_LOCAL_TOKEN` | 用外部实例，不拉子进程 |
| `SEX_CHROME_PATH`, `SEX_BROWSER` | JS 页面的 Chrome；`auto` / `never` / `always` |
| `SEX_ALLOW_PRIVATE` | 允许 firecrawl-local 访问 loopback 和私网（元数据地址始终拒绝） |
| `SEX_SEARXNG_URL`, `SEX_SEARXNG_PATH` | 外部 SearXNG，或子进程用的二进制 |
| `SEX_PARSE_PATH`, `SEX_PARSE_TIMEOUT` | `/v2/parse` 用的 here-docs（默认 `PATH`），以及转换超时（默认 120 s） |
| `SEX_LOG_LEVEL`, `SEX_TIMEOUT` | stderr 日志级别、子进程启动与请求超时 |

**`FIRECRAWL_CLOUD` 强制为 `off`**，不可配置：sex 不会把 URL 送给 Firecrawl 云端。

安全边界由 firecrawl-local 的 `guard.rs` 兜底（URL 检查 + DNS 解析后再查一次，防 rebinding；浏览器走它自己的 loopback 代理）。sex 自己不抓页面，所以没有第二套 egress 规则。

## 明确不做的

这些属于 Firecrawl 云端，或者需要一个 sex 不想再维护的东西（队列、LLM、缓存层）。它们会被报出来，不会假装成功：

- `json` / `summary` 格式（要 LLM 端点）
- 浏览器 `actions`
- 持久化 crawl / batch 和 webhook
- `maxAge` / `storeInCache` / changeTracking
- `proxy` / stealth
- `blockAds`、`fastMode`

## fork

`/v2/parse`、`--proxy`、按请求的网络策略、adblock、actions 都需要改 firecrawl-local 本身——**除了 `/v2/parse`**：它是 `packages/parse`，跑 here-docs 子进程，不需要 fork，也不分发 AGPL 代码。剩下的 patch 顺序和封装规则在 [`docs/fork.md`](docs/fork.md)。上游 `firecrawl-local` 是 AGPL-3.0，sex 始终以**子进程 + HTTP** 使用它，从不链接它的 crate。

## 开发

```bash
bun run test    # 全在 mock 上：不需要 Rust、Chrome 或 SearXNG
bun run check   # tsc --noEmit
bun run lint    # Biome
```

- `packages/local` — 唯一知道 firecrawl-local 存在的地方：spawn、`/health`、token、重启与冷却、嵌入、HTTP 客户端。
- `packages/parse` — 把上传的字节喂给 here-docs 子进程，拿回 `{ markdown, warnings }`；OCR 引擎不进 sex 的进程。
- `packages/search` — 托管 SearXNG + Firecrawl v2 search 形状。
- `apps/sex` — `engine.ts`（过滤与转发）、`http.ts`、`mcp.ts`、`cli.ts`。

包直接导出 TypeScript 源码，没有构建步骤；只有 app 会被编译。

## License

MIT。firecrawl-local 是 AGPL-3.0，独立进程；嵌入了它二进制的构建是在分发它，要随附源码和许可。
