# sex

自托管的 Web Search + Web Fetch，目标是做 [Firecrawl](https://firecrawl.dev) v2 API 的 drop-in replacement。

- **搜索**：[SearXNG](https://github.com/searxng/searxng)。默认由 sex 作为子进程启动（预编译二进制来自 [@searxng-js/searxng](https://github.com/AkaraChen/searxng)，`dist/sex` 里内置），也可以用 `SEX_SEARXNG_URL` 指向已部署的实例
- **抓取/清洗**：[Defuddle](https://github.com/kepano/defuddle)（无浏览器时用 linkedom 跑它的 Node 版；有浏览器时把同一份浏览器 bundle 注入页面执行）。HTML 和 PDF 的解析在 worker 线程池里进行（`SEX_EXTRACT_WORKERS`）
- **文档转换（可选）**：[here-docs](https://github.com/AkaraChen/here-docs)，PDF 保留标题、表格等结构，扫描页本地 OCR；还支持 Word / PowerPoint / Excel / OpenDocument / EPUB / RTF 和图片。不开时 PDF 用 unpdf 抽纯文本
- **浏览器（可选）**：[Lightpanda](https://github.com/lightpanda-io/browser)（作为 sex 的子进程运行，`dist/sex` 里内置了固定版本），或任意 CDP 浏览器（Chrome 等）
- **LLM（可选）**：任意 OpenAI 兼容的 `/chat/completions` 接口
- **任务**：crawl / batch scrape / extract 在 `serve` 进程里执行，队列用 [bunqueue](https://bunqueue.dev)（嵌入式），任务状态和队列都存在 SQLite 里（`SEX_DATA_DIR`），抓到的文档存在旁边的 JSONL 文件里（也可以放到 S3），进程重启后接着跑。不需要 Redis，也没有单独的 worker 进程

一个二进制，三个子命令：`search`、`fetch`、`serve`。`serve` 在同一个端口上同时提供 HTTP API 和 MCP（`/mcp`，只有 streamable HTTP，没有 stdio）；`http` 是 `serve` 的旧名，目前仍作为别名保留。

只要搜索和抓取的话，还有一个轻量版 [sex-lite](#sex-lite)。

仓库是 Bun workspace，`packages/` 放库，`apps/` 放两个产品（架构和拆分计划见 [docs/architecture.md](docs/architecture.md)）：

| 目录 | 内容 |
|---|---|
| `packages/core`（`@sex/core`） | 两个产品共用的部分：SearXNG 搜索、HTTP 抓取 + Defuddle 提取、SSRF 防护、`/v2/scrape` 和 `/v2/search` 路由、`web_fetch` / `web_search` 两个 MCP 工具、CLI 的公共部分 |
| `packages/egress`（`@searxng-js/sex-egress`，发布到 npm） | SSRF 安全的出站请求：`EgressPolicy`、`safeFetch`、`rewriteUrl`。Bun 和 Node 24 都能用，用法见 [packages/egress/README.md](packages/egress/README.md) |
| `packages/page`（`@searxng-js/sex-page`，发布到 npm） | HTML 和 PDF 提取（Defuddle、unpdf、worker 线程池）、Markdown 转 HTML。Bun 和 Node 24 都能用；Node 上转 Markdown 需要装可选 peer `marked`，用法见 [packages/page/README.md](packages/page/README.md) |
| `packages/searxng`（`@searxng-js/sex-searxng`，发布到 npm） | 连接外部 SearXNG，或把预编译的 SearXNG 作为子进程托管。Node 上给托管实例配代理需要装可选 peer `yaml`，用法见 [packages/searxng/README.md](packages/searxng/README.md) |
| `packages/errors`（`@searxng-js/sex-errors`，私有） | `AppError` 和错误目录（`ERRORS`），打包进用到它的包；跨包判断错误用 `AppError.isInstance` |
| `apps/sex` | 完整版：在 core 上加了浏览器、LLM、文档转换、map / crawl / batch / extract 和任务队列 |
| `apps/sex-lite` | 轻量版：只用 core |

## 快速开始

```bash
bun install                          # 同时装上本平台的 SearXNG 二进制
bun run dev search "defuddle"        # 即 bun apps/sex/src/cli.ts；sex 自己启动 SearXNG 子进程，用完即停
bun run dev fetch https://stephango.com/saw
bun run dev serve                    # HTTP API: http://127.0.0.1:3002/docs，MCP: http://127.0.0.1:3002/mcp

bun run build                        # 单文件可执行：dist/sex（内置 SearXNG、Lightpanda 和 here-docs）
```

### sex-lite

只有 `web_search` 和 `web_fetch`：没有浏览器、LLM、here-docs，也没有 map / crawl / batch / extract 和任务存储。CLI、HTTP API 和 MCP 都有，用法和 sex 一样：

```bash
bun run dev:lite search "defuddle"   # 即 bun apps/sex-lite/src/cli.ts
bun run dev:lite fetch https://stephango.com/saw -f markdown,links
bun run dev:lite serve               # POST /v2/search、POST /v2/scrape（兼容 Firecrawl），/docs，/health，MCP 在 /mcp

bun run build:lite                   # dist/sex-lite（内置 SearXNG，约 130 MB；dist/sex 约 330 MB）
docker build --target lite -t sex-lite .
```

- 能力：搜索（可带 `scrapeOptions`）；抓取支持 `markdown` / `html` / `rawHtml` / `rawBase64` / `links` / `images` / `attributes` 格式，HTML 用 Defuddle 提取，PDF 用 unpdf 抽纯文本。
- 需要浏览器的选项（`actions`）和 LLM 格式（`json`、`summary` 等）返回 `501`，提示改用 sex；其它路由（如 `/v2/crawl`）是 `404`。
- 配置：只认下表里 SearXNG、抓取、HTTP 相关的那些变量（`PORT`、`HOST`、`SEX_SEARXNG_*`、`SEX_ALLOW_PRIVATE_NETWORK`、`SEX_PROXY_URL`、`SEX_USER_AGENT`、`SEX_CONCURRENCY`、`SEX_TIMEOUT`、`SEX_MAX_BODY_BYTES`、`SEX_EXTRACT_WORKERS`、`SEX_LOG_LEVEL`、`SEX_CORS_ORIGINS`、`SEX_ALLOWED_HOSTS`、`SEX_STRICT_REQUESTS`），含义相同。

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
- 配置：默认是一份最小的 `settings.yml`（继承 SearXNG 默认值，开启 JSON，关闭 limiter 和 image proxy）。要调整引擎等设置，用 `SEX_SEARXNG_SETTINGS` 指定自己的文件，并保留 `search.formats` 里的 `json`；端口、监听地址和 secret 总是由 sex 设置。设了 `SEX_PROXY_URL` 且用的是这份默认配置时，sex 会在里面加上 `outgoing.proxies`（`all://` 指向该代理），SearXNG 对搜索引擎的请求就走代理；配置文件只在启动时写入一个 `0600` 的临时文件，SearXNG 读完即删，代理凭据不进日志。你自己用 `SEX_SEARXNG_SETTINGS` 提供的文件原样使用，sex 不碰其中的 `outgoing`（要走代理请自己写 `outgoing.proxies`，日志里会提示一次）；外部 SearXNG（`SEX_SEARXNG_URL`）也不处理。
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

- **PDF**：能抽出文字的页输出带标题、列表、表格的 Markdown；扫描页和图片页逐页 OCR，按页序合并。`metadata.numPages` 是实际转换的页数，`metadata.totalPages` 是文件的总页数（不设 `maxPages` 时两者相同；这是语义变化，见 [HTTP API](#http-api-firecrawl-v2-兼容)）。
- **Office 等文档**：Word、PowerPoint、Excel、OpenDocument、EPUB、RTF 转成结构化 Markdown，内嵌图片的 OCR 文字插在原位置。
- **CSV**：`text/csv` 也交给 here-docs 转成 Markdown 表格；不开 `--docs` 时仍按纯文本返回。
- **图片**（`image/*`）：OCR。请求里显式传了 `parsers` 但不含 `"image"` 时仍返回 415，和 Firecrawl 一致。
- **页数上限**：`parsers: [{ "type": "pdf", "maxPages": N }]` 只转换前 N 页，后面的页不会被解析或 OCR，`warning` 里会说明实际转换了几页。不开 `--docs` 时 unpdf 路径同样遵守 `maxPages`：逐页抽取，到 `maxPages` 就停，后面的页不会被解析。
- **`html` / `rawHtml`**：文档的这两个字段是它的 Markdown 经 Bun 内置的 Markdown 渲染器（`Bun.markdown`）得到的 HTML，两者相同；Markdown 里的原始 HTML 会被转义，不会原样输出。链接地址照原样保留，调用方要自己做净化。
- **超时和取消**：转换受请求的 `timeout`（默认 `SEX_TIMEOUT`）约束，超时时已转换出若干页就返回这部分，`warning` 里写明只转换到第几页；一页都没转换出来才返回 `408 SCRAPE_TIMEOUT`（转换最多用掉剩余时间的 90%，留一点给后面的步骤）；排队等待转换的时间也算在 `timeout` 里；客户端断开或任务被取消时立即停止，返回 408。OCR 一页大约几百毫秒，长扫描件需要调大 `timeout` 或用 `maxPages`。
- **资源**：引擎在 `serve` 启动时加载（约 1–3 秒），每个进程一份，空闲时大约 200 MB 内存；OCR 吃 CPU，但跑在原生线程里，不阻塞事件循环。light-ocr 每个引擎只有一个识别线程，所以同时转换的文档数由 `SEX_DOCS_CONCURRENCY` 限制，超出的排队。加载失败时 `serve` 直接以 `error: DOCS_UNAVAILABLE: ...` 退出。

**运行方式**：`bun run build` 把 here-docs 和当前平台的原生引擎（约 160 MiB）一起打进 `dist/sex`（约 260 MiB）。原生库只能从磁盘上的真实文件加载，所以开了 `--docs` 后，第一次用到时会把它们解压到 `$XDG_CACHE_HOME/sex/docs-<hash>`（默认 `~/.cache/sex`，约 0.3–0.6 秒，之后复用；换版本自动换目录）。从源码运行（`bun run dev`）时直接用 `node_modules` 里的 here-docs。`bun apps/sex/scripts/build.ts --target bun-linux-arm64` 等可以构建其它平台，前提是 `node_modules` 里装了那个平台的原生包。支持的平台：Linux x64 / arm64（glibc 和 musl）、macOS arm64、Windows x64；Intel Mac 不支持。

### 浏览器

- **`--lightpanda`**（`SEX_LIGHTPANDA=1`）：sex 自己 spawn 一个 Lightpanda 子进程。`serve` 启动时预热，其它命令在第一次用到浏览器时才启动；子进程退出后，下一次请求会自动重新启动；sex 退出时一起退出。连续启动失败（60 秒内 3 次，例如二进制起不来）后，30 秒内直接返回 `502 BROWSER_UNAVAILABLE`，不会对着坏掉的二进制反复 spawn。
- **`--cdp-url ws://...`**（`SEX_CDP_URL`）：连接已经在运行的 CDP 浏览器，比如 Chrome。sex 不启动任何进程；地址是回环时按“本机的外部浏览器”处理（Chrome 专用，见下面的表），要用 Lightpanda 请用 `--lightpanda`；和 `--lightpanda` 同时设置时以 `--cdp-url` 为准。
- 都不设：不用浏览器。

`dist/sex`（以及 Docker 镜像）内置了 Lightpanda，`--lightpanda` 开箱即用：第一次用到时解压到 `$XDG_CACHE_HOME/sex/lightpanda-<版本>-<hash>/`（约 76 MB），之后复用。版本和每个平台的 SHA-256 固定在 `apps/sex/scripts/lightpanda.ts`（目前是 1.0.2），`bun run build` 第一次会从 GitHub Releases 下载并校验，缓存在 `$XDG_CACHE_HOME/sex-build`，压缩后让 `dist/sex` 增大约 23 MB。预编译版本只有 Linux x64 / arm64（glibc ≥ 2.35）和 macOS x64 / arm64，Windows 和 musl 没有。

从源码运行（`bun run dev`）时没有内置的二进制，需要自己放到 PATH 上，或用 `--lightpanda-path`（`SEX_LIGHTPANDA_PATH`）指定；`--lightpanda-path` 也会覆盖内置的版本：

```bash
gh release download 1.0.2 -R lightpanda-io/browser -p lightpanda-x86_64-linux -O lightpanda && chmod +x lightpanda
bun run dev fetch https://example.com --lightpanda --lightpanda-path ./lightpanda
```

**子进程的回收**：`SIGINT` / `SIGTERM` 时 sex 会先关掉子进程再退出，但 `SIGKILL` 无法被捕获。所以在 Linux 上，sex 用 `setpriv --pdeathsig TERM -- lightpanda serve ...` 启动子进程（`setpriv` 属于 util-linux ≥ 2.33，Debian / Ubuntu 和 Docker 镜像里都有）：sex 被 `kill -9` 后，内核会给子进程发 `SIGTERM`，不会留下孤儿。macOS 没有对应机制（pdeathsig 是 Linux 特有的），Linux 上没有 `setpriv` 时也一样，sex 只能直接 spawn，此时 `kill -9` sex 会留下孤儿 Lightpanda 进程，需要自己清理。`lightpanda started` 日志里的 `spawn=setpriv` / `spawn=direct` 标明了实际用的是哪种方式。

**出站规则与执行点**：出站规则只有一份（core 的 `EgressPolicy`：解析域名，任何一个地址是内网、回环、link-local（含云元数据 `169.254.169.254`）就拒绝，通过后给出要固定连接的 IP，按 host 缓存 30 秒）。`safeFetch`、浏览器都问它；浏览器能在哪里执行这条规则，取决于浏览器本身：

| 浏览器 | SSRF 检查 | 广告拦截 | 凭据限定 / 媒体拦截 |
|---|---|---|---|
| Lightpanda（`--lightpanda`） | 子进程的 `--block-private-networks`；设了 `SEX_PROXY_URL` 时改由 `EgressProxy` | CDP 拦截 | CDP 拦截，按需开 |
| 本机的外部浏览器（`--cdp-url`，地址是回环：`127.0.0.1`、`localhost`、`::1`） | `EgressProxy` | `EgressProxy` | CDP 拦截，按需开 |
| 远程的外部浏览器（`--cdp-url`，其它地址） | CDP request guard | CDP 拦截 | CDP 拦截，按需开 |

“按需开”：只有带了 `Authorization` / `Proxy-Authorization` 的请求或设了 `SEX_BLOCK_MEDIA` 时才打开 CDP 拦截；表里没有 CDP 的格子不会因为 SSRF 或广告而打开它。`--allow-private-network` 打开时三条路径都不做 SSRF 检查（和以前一样）。

**`EgressProxy`**（本机的外部浏览器，以及 Lightpanda 配了 `SEX_PROXY_URL` 时）：sex 在 `127.0.0.1` 的随机端口起一个转发代理（`node:http`，随 `BrowserPool` 懒启动，`engine.close()` 时关闭），浏览器的所有流量都经过它，所以文档、重定向、子资源、service worker、WebSocket 都在检查范围内，这是 CDP 拦截做不到的。

- HTTPS（`CONNECT`）和 HTTP（绝对 URL 转发）都先过 `EgressPolicy`，再连到它验证过的 IP（不会再解析一次域名，DNS rebinding 无从下手）；转发保留原始 `Host`，去掉 hop-by-hop 头和 `Proxy-*` 头，不跟随重定向（原样交还浏览器，浏览器跟随时每一跳重新检查）。
- 认证：每次抓取（每个 browser context）一组随机凭据（`Proxy-Authorization: Basic`，`timingSafeEqual` 比较），对应这次抓取的策略（广告表、上游代理）；抓取结束就注销，并关掉这次抓取的所有连接。同机其它进程没有凭据，用不了这个代理。Chrome 用 `page.authenticate` 回答 407，Lightpanda 把凭据写在 `proxyServer` 的 URL 里（它不回应 CONNECT 的 407，但会主动带上）；凭据不再出现在 Lightpanda 的命令行上。
- Chrome 默认不让回环和 link-local 地址走代理（直连），所以每个 context 都带 `proxyBypassList: ["<-loopback>"]`，否则 `127.0.0.1`、`169.254.169.254` 会绕过检查。
- 被拒的主文档报 `PRIVATE_NETWORK_BLOCKED`（域名不存在报 `SCRAPE_DNS_RESOLUTION_ERROR`）；被拒的子资源只是加载失败，页面照常返回。
- 广告：`blockAds` 在这条路径上按 host 拒绝，查的是同一份 EasyList 表（见下）。代理看不到“这是不是主文档导航”，所以目标页自己的 host 永远不拦；页面重定向到表里的域名时会被拦（CDP 路径则不拦主文档导航）。
- 失败时关闭：代理起不来是 `BROWSER_UNAVAILABLE`，不会退回无防护的浏览器。浏览器和 sex 不在同一个网络命名空间里（例如端口转发到容器里的 Chrome，`--cdp-url` 写的是 `127.0.0.1`）时，浏览器连不上这个回环代理，页面加载会失败（同样是关闭，不是放行）；这种部署请让 `--cdp-url` 用浏览器所在的主机名，走远程那一行。
- `--cdp-url` 按 Chrome 处理。接外部 Lightpanda 时请用 `--lightpanda`，让 sex 自己启动。
- 上游代理：设了 `SEX_PROXY_URL` 时，`EgressProxy` 把请求串到它后面（HTTP 转发走上游，`CONNECT` 先向上游发 `CONNECT`，带上游的凭据）。这时域名由上游解析，无法固定 IP：沿用[出站代理](#出站代理)的语义，先在本机检查一次，本机解析不了的域名拒绝；残留风险见该节。

**Lightpanda**：没有 `SEX_PROXY_URL` 时不经过 `EgressProxy`（少一跳），内网保护靠子进程的 `--block-private-networks`（Lightpanda 在 DNS 解析之后拦内网地址，主文档和子资源都拦）。设了 `SEX_PROXY_URL` 时，Lightpanda 的这个选项会把回环代理一起拒掉，所以不带它，改由 `EgressProxy` 检查并串联上游。

**远程的外部浏览器**：sex 连不到它那边的回环，只能用 CDP request guard：每个 origin 过一次 `EgressPolicy`，被拒的请求中止。它看不到 interception 打开之前的请求、service worker 和 WebSocket；这些要靠浏览器所在主机的网络层（防火墙、或在那台机器上套一个带 SSRF 防护的代理）限制。设了 `SEX_PROXY_URL` 时，浏览器直接用它（`createBrowserContext({ proxyServer })`，用户名密码由 `page.authenticate` 回答 407），guard 仍在前面。

**请求头与凭据**：请求里的 `headers` 在浏览器路径上的处理和 HTTP 路径一致，凭据只发给目标页所在的 origin（协议 + 主机 + 端口）：

- `Authorization` / `Proxy-Authorization` 只附加在发往目标 origin 的请求上（包括它的子资源），CDN、统计、广告等第三方域名收不到；重定向到其它 origin 后也不再带上。这需要 CDP request interception，所以即使开了 `--allow-private-network` 也会启用。经过代理（`EgressProxy` 或 `SEX_PROXY_URL`）的请求里，调用方给的 `Proxy-Authorization` 只可能是写给代理的，所以丢弃，不发给目标。
- `Cookie` 拆开写进浏览器的 cookie jar，只属于目标页的主机（host-only，不猜“末两段”域名），浏览器只会发给这个主机。
- 其它头（如 `Accept-Language`）仍对页面的所有请求生效。页面自己设置的头不受影响。
- 浏览器不支持 request interception 时：需要 CDP request guard（远程的外部浏览器）或带了 `Authorization` / `Proxy-Authorization` 的请求返回 `501 BROWSER_INTERCEPTION_UNSUPPORTED`，不会退回“发给所有域名”。不支持 `Network.setCookies` 时，`Cookie` 改为和 `Authorization` 一样只附加在目标 origin 的请求上（同样需要 request interception）。
- Lightpanda 1.0.2 已实测：支持带 headers 的 `Fetch.continueRequest` 和 `Network.setCookies`。它对 request interception 里暂停的请求会把 `Cookie` 头少报一个字符，所以 sex 不会把它传回浏览器，由 cookie jar 负责发送。
- `X-Api-Key` 这类自定义的鉴权头不在上面的名单里，仍会发给页面的所有请求；需要限定范围的话请用 `Authorization`。

**广告与追踪器拦截（`blockAds`）**：只作用于浏览器路径，默认开启（和 Firecrawl 一致），请求里传 `blockAds: false` 关闭。

- 数据：EasyList 和 EasyPrivacy 里的域名规则，也就是 `||domain^`（可带 `$third-party`）和例外规则 `@@||domain^`，约 9 万条。带路径、通配符、其它选项的规则和页面元素隐藏规则不用。
- 匹配：按域名的 label 从后往前做后缀匹配（`ads.example.com` 命中 `cdn.ads.example.com`，不命中 `badads.example.com`），不是子串匹配；例外规则优先于拦截规则。`$third-party` 规则只在请求离开目标页所在的可注册域名时生效（没有 public suffix list，用“两段或 `co.uk` 式三段”近似）。
- 范围：子资源和 iframe 被拦截时直接中止；目标页本身的导航（包括重定向）永远不拦（`EgressProxy` 上的差别见上）。浏览器不支持 request interception（部分 `--cdp-url` 浏览器）且没有别的策略需要它时，静默不拦截，不报错。
- 数据怎么来：`apps/sex/scripts/adblock.ts` 固定了 EasyList 仓库的一个提交，按它的模板拉取各个子列表，提取域名后得到一个纯文本表，并固定该表的 SHA-256。`bun run build` 把它 zstd 压缩（约 600 KB）嵌入 `dist/sex`；第一次用到浏览器时解压并建 `Set`（约 30 ms，常驻内存增加约 10 MiB），之后每次查询不到 1 µs。从源码运行时，第一次用到会下载并校验，缓存在 `$XDG_CACHE_HOME/sex-build`；下载失败只打一条警告，不拦截，不影响抓取。升级规则：改 `EASYLIST_COMMIT`，运行 `bun apps/sex/scripts/adblock.ts` 取新 hash 填进 `ADBLOCK_TABLE_SHA256`。
- 开销：CDP 路径要让浏览器把每个请求交给 sex 决定，这一步（CDP 往返）才是成本，查表本身可以忽略；本机的外部浏览器上广告在 `EgressProxy` 里按 host 拒绝，不需要 CDP 拦截。开了 `--allow-private-network`（`search` / `fetch` 默认就开）且没有其它策略时，Lightpanda 和远程浏览器上的 `blockAds` 会把 CDP 拦截打开。在 Lightpanda 上，一个有 50 个子资源且没有一个命中广告表的页面，实测增加约 2–5%（约 80 µs / 请求）；真实的广告多的新闻页面里，被拦掉 4–13 个请求，页面反而更快，正文不变。复测：`bun apps/sex/scripts/bench-adblock.ts`。
- **`SEX_BLOCK_MEDIA`**（`--block-media`）：另外拦截图片和音视频请求（按资源类型，不是扩展名），默认关。文本抓取不需要这些字节；`screenshot` 本来就不支持。

**EasyList 的出处与许可**：广告域名表来自 [EasyList](https://easylist.to/) 和 EasyPrivacy（[easylist/easylist](https://github.com/easylist/easylist)），双许可 GPLv3 / CC BY-SA 3.0。sex 只取其中的域名，派生出的域名表随 `dist/sex` 一起分发；具体的提交和校验和见 `apps/sex/scripts/adblock.ts`。

### 出站代理

设置 `SEX_PROXY_URL`（`http://` 或 `https://`，可带 `user:pass@`）后，抓取用户给的 URL 都经过这个代理：HTTP 路径用 Bun `fetch` 自带的 `proxy` 选项，浏览器按[浏览器](#浏览器)一节的方式配置：Lightpanda 和本机的外部浏览器经 `EgressProxy` 串联到它，远程的外部浏览器直接用它。凭据只从环境变量读，没有命令行参数，避免出现在进程列表里；Lightpanda 的命令行上也不再有代理（它连的是 `EgressProxy`，凭据是每次抓取随机生成的）。

SSRF 防护在代理之前仍然生效：

- 每次请求（包括每一跳重定向）发出前，sex 先在本机解析并检查目标，内网、回环、link-local 地址照旧拒绝（`PRIVATE_NETWORK_BLOCKED`），被拒的请求不会到达代理。浏览器的请求在 `EgressProxy`（或远程浏览器的 CDP request guard）里同样先检查。
- 本机解析不出来的域名在走代理时直接拒绝（`SCRAPE_DNS_RESOLUTION_ERROR`），否则只有代理的 DNS 才认识的内部域名会绕过检查。代价是只能靠代理解析的域名抓不了。
- 请求里的 `Proxy-Authorization` 头在走代理时被丢弃，不能借此改变代理的身份。

**SearXNG**：sex 自己启动 SearXNG 时（没有 `SEX_SEARXNG_URL`），`SEX_PROXY_URL` 同样会写进它的 `outgoing.proxies`，SearXNG 去搜索引擎的请求走这个代理。这里的目标是搜索引擎，不是用户提交的 URL，所以没有 SSRF 检查。`SEX_SEARXNG_SETTINGS` 是你自己的文件时 sex 不改它；外部 SearXNG 由你自己配置。

**LLM 和 S3 不走 `SEX_PROXY_URL`**：`SEX_LLM_BASE_URL` 和 `SEX_DOCUMENTS_URL` 的 S3 端点都是运维方自己配置的地址，不是用户提交的 URL。确实需要走代理时，用 Bun 认的标准环境变量 `HTTP_PROXY` / `HTTPS_PROXY`（小写也行，`NO_PROXY` 生效），已用 Bun 1.4.3 实测：`fetch`（LLM 请求用的就是它）和 `Bun.S3Client` 都读这些变量，`http://` 地址看 `HTTP_PROXY`，`https://` 地址看 `HTTPS_PROXY`。注意它是整个进程范围的：sex 访问本机 SearXNG（`127.0.0.1`）的请求也会走代理，所以要同时设 `NO_PROXY=127.0.0.1,localhost`；没显式用 `SEX_PROXY_URL` 的 `fetch` 同样受影响。

**stealth 重试**（`SEX_STEALTH_PROXY_URL`）：设置后，普通抓取被拦截时换这个代理重试一次。判断“被拦截”的规则只有一处（`packages/errors/src/index.ts` 的 `isBlocked`）：响应状态是 403 或 429，或者抛出的错误在错误目录里标了 `blocked`（目前只有 `SCRAPE_SITE_ERROR`，连接被重置 / 断开）。别的状态、`PRIVATE_NETWORK_BLOCKED` 这类我们自己的拒绝都不重试。

- 重试在这次抓取的同一个 `Deadline` 里，剩下不到 2 秒就不重试；超时照常是 `SCRAPE_TIMEOUT`。重试本身失败时保留第一次的结果，`warning` 里说明。
- 用了 stealth 的文档，`metadata.proxyUsed` 是 `"stealth"`，`warning` 写明重试过；没重试或重试没被采用是 `"basic"`。重试得到的响应不管状态是什么都会被采用（再被拦就是第二次的 403）。
- 请求 `proxy: "basic"` 不重试；`proxy: "stealth"` 从第一次请求就走 stealth 代理，并且用纯 HTTP（不用浏览器，`warning` 说明，带 `actions` 是 400）；`auto`、`enhanced` 和不传一样。两个代理相同时不重试。
- 浏览器只有启动时那一个代理，所以浏览器渲染出的页面被拦截（403 / 429，没有 `actions`）时，换 stealth 代理做一次纯 HTTP 抓取，这次没被拦截才替换浏览器的结果（脚本没有执行，`warning` 说明）。
- SSRF 规则和 `SEX_PROXY_URL` 完全一样：每一跳先在本机解析并检查，本机解析不了的域名拒绝，调用方的 `Proxy-Authorization` 丢弃，由 stealth 代理解析域名所以无法固定 IP（残留风险同下）。缓存键不含代理，stealth 取回的 2xx 页面会和其他页面一样进缓存。

**残留风险**：走代理时由代理解析域名，连接无法固定到 sex 检查过的 IP（`pinToAddress` 只在直连时有效）。DNS rebinding（sex 检查时返回公网 IP，代理查询时返回内网 IP）在 sex 这一侧防不住，需要代理自己拒绝内网目标，例如 squid 的 ACL，或带 SSRF 防护的代理；sex 的检查是对它的补充，不是替代。浏览器串联在 `EgressProxy` 后面时同理（`EgressProxy` 在本机检查一次，上游再解析一次）。远程的 `--cdp-url` 浏览器直接连上游代理，它的 service worker、WebSocket 等不经过 request interception 的网络路径只能靠网络层（代理或防火墙）限制。

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
| `SEX_CDP_URL` | `--cdp-url` | 无 | 已有 CDP 浏览器（Chrome）的地址，如 `ws://127.0.0.1:9222`；和 `SEX_LIGHTPANDA` 同时设置时以它为准。地址是回环时流量经 `EgressProxy`，否则用 CDP request guard，见[浏览器](#浏览器) |
| `SEX_BLOCK_MEDIA` | `--block-media` | `false` | 浏览器路径额外拦截图片和音视频请求；广告拦截（`blockAds`）见[浏览器](#浏览器) |
| `SEX_DOCS` | `--docs` | `false` | 用 here-docs 转换 PDF / Office 文档 / 图片（结构化 + 本地 OCR），见[文档转换](#文档转换) |
| `SEX_LLM_MODEL` | `--llm-model` | 无（LLM 关闭） | 设置后开启 LLM 功能 |
| `SEX_LLM_SMALL_MODEL` | `--llm-small-model` | 无（用主模型） | 辅助调用用的小模型，和 `SEX_LLM_MODEL` 共用 base URL 和 key，必须同时设置 `SEX_LLM_MODEL`。用于 extract 的分类和生成 schema、crawl `prompt` 转选项、extract 的 `/*` 选页；抽取、summary、question、highlights 仍用主模型；`checkPromptInjection` 的注入检查是安全检查，也始终用主模型，不为省钱降低检出率 |
| `SEX_LLM_BASE_URL`（回退 `OPENAI_BASE_URL`） | `--llm-base-url` | `https://api.openai.com/v1` | OpenAI 兼容接口 |
| `SEX_LLM_API_KEY`（回退 `OPENAI_API_KEY`） | `--llm-api-key` | 无 | LLM API key |
| `SEX_LLM_TIMEOUT` | — | `120000`（毫秒，最小 1000） | 单次 LLM 调用的超时，包括遇到限流时的等待和重试 |
| `SEX_LLM_MAX_INPUT_CHARS` | — | `200000`（最小 1000） | 单次 LLM 调用最多发送的页面字符数 |
| `SEX_ALLOW_PRIVATE_NETWORK` | `--allow-private-network` | `search`/`fetch`：`true`；`serve`：`false` | 是否允许抓取回环、内网、link-local 地址 |
| `SEX_PROXY_URL` | —（只读环境变量，凭据不进进程列表） | 无 | 出站 HTTP(S) 代理，如 `http://user:pass@proxy:3128`。用户给的 URL 的所有抓取（HTTP 路径、浏览器、robots.txt、sitemap、webhook）都走它；sex 自己启动的 SearXNG 也走它（自带 `settings.yml` 时不处理）；LLM、S3 不走。安全影响见[出站代理](#出站代理) |
| `SEX_STEALTH_PROXY_URL` | —（只读环境变量，凭据不进进程列表） | 无 | 第二个出站代理，格式同上。普通抓取被站点拦截（403、429，或连接被重置 / 断开）时换它重试一次；请求 `proxy: "stealth"` 时直接用它。不设置则不重试，行为和以前一样。见[出站代理](#出站代理) |
| `SEX_USER_AGENT` | `--user-agent` | Chrome 桌面 UA | 页面抓取使用的 User-Agent |
| `SEX_CONCURRENCY` | `--concurrency` | `8` | 单进程内同时进行的页面抓取数 |
| `SEX_TIMEOUT` | `--timeout` | `30000`（毫秒，最小 1） | 单页默认超时（请求用到 LLM（LLM 格式或 `checkPromptInjection`）且没传 `timeout` 时至少 60000）|
| `SEX_MAX_BODY_BYTES` | — | `26214400`（25 MiB，最小 1024） | 单次页面下载的响应体上限，也是 `/v2/parse` 上传文件的上限 |
| `SEX_MCP_TOOL_NAMES` | — | `web` | MCP 工具名：`web`（`web_fetch` 等）或 `firecrawl`（firecrawl-mcp 里有的工具用它的名字） |
| `SEX_EXTRACT_WILDCARD_PAGES` | — | `25` | extract 的 URL 以 `/*` 结尾时，最多展开的页面数（请求里的 `limit` 优先） |
| `SEX_DOCS_CONCURRENCY` | — | `min(2, CPU 核数 - 1)`，至少 1 | 同时用 here-docs 转换的文档数，超出的排队（排队时间计入请求的 `timeout`） |
| `SEX_EXTRACT_WORKERS` | — | `min(4, CPU 核数 - 1)`，至少 1 | HTML/PDF 解析的 worker 线程数；`0` 表示在主线程解析 |
| `SEX_DATA_DIR` | `--data-dir` | `serve`：`$XDG_DATA_HOME/sex` 或 `~/.local/share/sex`；Docker：`/data` | 任务数据库和任务队列（SQLite）所在目录，抓到的文档默认也在这里（`documents/`），页面缓存（`cache.sqlite`）和变更追踪（`change-tracking.sqlite`）也在这里；`search` / `fetch` 不使用 |
| `SEX_DOCUMENTS_URL` | `serve --documents-url` | `SEX_DATA_DIR/documents` | 任务抓到的文档存在哪里：`s3://bucket/prefix`（prefix 可省略；endpoint、凭据、region 读 Bun 的 `S3_ENDPOINT`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`S3_REGION`，或对应的 `AWS_*`）或 `file:///绝对路径`，其它值报 `CONFIG_INVALID`。一个 prefix（或目录）只能给一个 sex 实例用。见[任务队列](#任务队列) |
| `SEX_JOB_TTL_MS` | — | `86400000`（24 小时，最小 60000） | 任务结束后的保留时间（从结束时开始算，运行中的任务不会过期） |
| `SEX_CACHE_MAX_AGE_MS` | — | `0`（不用缓存） | 请求没给 `maxAge` 时用的 `maxAge`（毫秒）。`0` 表示请求不给 `maxAge` 时完全不用缓存（不读也不写）；要默认用缓存就设成比如 `172800000`（Firecrawl 的默认值，两天）。见[页面缓存](#页面缓存) |
| `SEX_CACHE_TTL_MS` | — | `172800000`（两天，最小 60000） | 缓存页面的保留时间，过了就删；请求的 `maxAge` 最大也只到这个值 |
| `SEX_CACHE_MAX_BYTES` | — | `268435456`（256 MiB，最小 1048576） | 缓存占用上限（压缩后的字节数），超出时先删最久没被用到的页面 |
| `SEX_WEBHOOK_SECRET` | —（不提供命令行参数，免得出现在进程列表里） | 空（不签名） | 设了之后，每个 webhook 的请求体用它做 HMAC-SHA256，结果放进请求头 `X-Firecrawl-Signature: sha256=<hex>`。见[Webhook](#webhook) |
| `SEX_LOG_LEVEL` | `--log-level` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `SEX_STRICT_REQUESTS` | — | `false` | HTTP API 收到 schema 里没有的请求字段（含 `scrapeOptions` 等嵌套对象里的）时返回 `400`，而不是丢掉；不影响 MCP |
| `SEX_CORS_ORIGINS` | `--cors-origin` | 空（CORS 关闭） | 允许跨域调用 HTTP API 和 MCP 端点的浏览器 origin，逗号分隔，不带路径 |
| `SEX_ALLOWED_HOSTS` | `--allowed-host` | 绑定回环地址时只接受 `localhost` / `127.0.0.1` / `[::1]` | 允许的 `Host` 头主机名，逗号分隔，不带端口 |

### 页面缓存

`maxAge`、`storeInCache`、`minAge`、`lockdown` 按 Firecrawl 的含义工作（只有 sex，sex-lite 没有缓存）。缓存存在 `SEX_DATA_DIR/cache.sqlite`（bun:sqlite，和任务数据库分开，大块内容和它的 WAL 不进 `jobs.sqlite`）；没有数据目录时（一次性 CLI 命令）没有缓存。

- **缓存什么**：抓到的内容，不是最后的 Document：HTTP 响应体（HTML、PDF、文件字节），浏览器渲染的页面则是渲染后的 HTML，zstd 压缩后一个 (URL, 变体) 一行。`formats`、选择器、`parsers`（含 `maxPages`）、LLM 格式都是对取出来的内容再做一遍，所以一条缓存可以回答所有格式的请求，命中时仍会解析（省掉的是下载和渲染）。只缓存 2xx 响应。
- **缓存键**：抓取用的 URL（重写后、去掉 `#` 片段）加变体：有没有走浏览器渲染、`blockAds: false`、`waitFor`、`mobile`、`skipTlsVerification`、`location.languages`。
- **不读也不写**：带 `actions` 或 `headers` 的请求，`rawBase64`，上传；以及请求没给 `maxAge`、而 `SEX_CACHE_MAX_AGE_MS` 是 0 的请求。
- **读写**：`maxAge`（毫秒）内的缓存命中；没命中就现抓，并写入缓存，除非 `storeInCache: false`。请求里明确给 `maxAge: 0`（和 Firecrawl 一致）是不读缓存、照常现抓，但仍然写入，用来刷新一条缓存。`metadata.cacheState` 是 `hit` / `miss`，命中时还有 `metadata.cachedAt`（写入时间，ISO 8601）。`lockdown` 和 `minAge` 只读缓存，永远不抓页面：`minAge` 要求缓存至少这么旧，没给 `maxAge` 时上限是 `SEX_CACHE_TTL_MS`，没有符合的缓存（或请求本来就不缓存）返回 `404 SCRAPE_NO_CACHED_DATA`。
- **过期与容量**：超过 `SEX_CACHE_TTL_MS` 的在启动时和之后每 10 分钟（写入时检查）删除；总大小超过 `SEX_CACHE_MAX_BYTES` 时删最久没被用到的；压缩后超过上限 1/8 的单个页面不缓存。缓存文件打不开或不是数据库时重建。
- **命中和现抓的差别**：浏览器渲染的页面存的是渲染后的 HTML，命中时在 Node 里用 linkedom 重新解析，而现抓是在浏览器里跑页面脚本，个别页面的结果会有细微差别；命中时 `mobile` 没有浏览器的 warning 也不再出现。crawl、batch 和 search 的 `scrapeOptions` 里给 `maxAge` 同样生效。

### 变更追踪

`formats: ["markdown", { "type": "changeTracking", "modes": ["git-diff", "json"], "tag": "daily" }]` 把这次抓到的页面和同一个 URL（和 `tag`）上一次抓到的比较，结果在文档的 `changeTracking` 里，字段和 Firecrawl 一样：`changeStatus`（`new` / `same` / `changed` / `removed`）、`previousScrapeAt`（上一次抓取时间，ISO 8601，第一次是 `null`）、`visibility`、`diff`、`json`。只有 sex 支持；sex-lite 和没有 `SEX_DATA_DIR` 的 sex 返回 `501 NOT_SUPPORTED`（提示里写明怎么开）。

- **存储**：`SEX_DATA_DIR/change-tracking.sqlite`（bun:sqlite），每个 (URL, tag) 一行，存最近一次的 markdown（zstd 压缩）。新的抓取直接覆盖旧的，**不过期、不淘汰**，也不是页面缓存（缓存会过期和淘汰，这里存的是下一次比较的唯一依据）。文件打不开时 `changeTracking` 不返回、文档带 `warning`，不会悄悄重建成全部 `new`。URL 是请求的 URL（`sourceURL`），`tag` 为空串等于没给 `tag`。
- **`changeStatus`**（Firecrawl 的规则）：没有上一次是 `new`；页面返回 404 是 `removed`；否则去掉 `[iframe](…)`、把连续空白当成一个空格后，**文本逐字相等**才是 `same`，不然 `changed`（调换段落、改一个字都是 `changed`；Firecrawl 只比较去掉空白后各字符出现的次数，会把这些误判成 `same`，sex 不照搬）。只有 2xx 的页面会写入，所以 404 或错误页不会成为下一次的比较对象。必须同时请求 `markdown`，否则 `400`。上传（`/v2/parse`）不支持。
- **`modes`**（只在 `changed` 时给）：`git-diff` 给 `diff.text`（`previous.md` → `current.md` 的 unified diff，3 行上下文）和 `diff.json`（Firecrawl 的 `{ files: [{ from, to, chunks: [{ content, changes }] }] }` 结构），用 [jsdiff](https://github.com/kpdecker/jsdiff) 生成，页面太大、5 秒内比不完时跳过并加 warning。`json` 需要 LLM（没有是 `501 LLM_NOT_CONFIGURED`）：给了 `schema` 就对两个版本各抽取一次、逐个顶层字段比较（`{ 字段: { previous, current } }`）；没给就让 LLM 按 `prompt` 描述两个版本的差别。LLM 调用失败只丢掉 `json`（带 warning），不影响抓取和写入。
- **`visibility`** 总是 `visible`：Firecrawl 的 `hidden` 是 crawl 里不在范围内的 URL，sex 没有这个概念。
- 和 Firecrawl 的差别：Firecrawl 在带 `changeTracking` 时把 `waitFor` 提到 5 秒、`timeout` 提到 60 秒，sex 不改（`json` 模式照常按 LLM 格式给至少 60 秒）；不带 `changeTracking` 的抓取不会更新记录；`changed` 的判断比 Firecrawl 严格（逐字相等，见上）。
- 同一个 (URL, tag) 并发抓取时后写入的覆盖先写入的，没有锁。

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
- **反复崩溃的任务**：同一个任务被打断 3 次（每次都是进程在它运行时死掉）后，队列不再投递它。下次启动时 sex 读队列的死信队列，给这一页记一条失败（出现在 `/errors` 里，并发 `success: false` 的 `page` webhook）并结算，job 照常结束；crawl 的起始任务或 extract 被放弃时，整个 job 记为 `failed`。运行中因心跳超时进入死信队列的任务，同样在下次启动时处理。
- **单进程**：同一个数据目录同一时间只能有一个 sex 进程在用。
- `SEX_REDIS_URL` / `SEX_REDIS_PREFIX` 已经不再支持，设置了会在启动时报 `CONFIG_INVALID`。

## 任务状态与默认值

`GET /v2/crawl/{id}`、`GET /v2/batch/scrape/{id}` 的响应（与 Firecrawl v2 对齐）：

- 时间：`createdAt`、`completedAt`（job 结束后才有；等于 `expiresAt` 减 `SEX_JOB_TTL_MS`）、`duration`（秒，运行中算到现在）。`failed` 时有 `error`。
- `?limit=N`：本页最多返回 N 个文档（仍受 10 MB 一页的上限约束）；`next` 会带上同样的 `limit`。job 还在 `scraping` 时 `next` 总是有，即使暂时没有新文档（指向下一个还没出现的文档）。
- `warning`（job 结束后）：被 robots.txt 拦掉过页面时提示去看 `/errors` 的 `robotsBlocked`；否则 crawl 只得到不超过 1 条结果、起始 URL 不是站点根路径、也没开 `crawlEntireDomain` 时建议开 `crawlEntireDomain` 或从上一级路径开始。
- **计数口径变了**：`completed` 只数存下来的文档，失败的页面既不进 `completed`，也不进 `total`（只出现在 `/errors`）。以前 batch 的 `completed` 含失败页，crawl 的 `total` 含失败页，所以 `total` 在 job 运行中会随失败页减少。重启后任务被重新投递时不会重复计数（和文档、错误记录一样按 task 只算一次）。`creditsUsed` 等于 `completed`。
- `/errors` 里每条错误多了 `code`（错误码，见下；重启前记下的旧错误没有）。`/v2/crawl/active` 的每项多了 `created_at`。
- 带 `prompt` 的 `POST /v2/crawl` 响应多了 `promptGeneratedOptions`（LLM 从 prompt 得到、通过校验的选项）和 `finalCrawlerOptions`（实际使用的选项，header 值打码）。转换前先 map 站点（sitemap 加起始页链接，不含搜索，整站不限路径，最多 50 个 URL，15 秒内），把 URL 放在 `<site_urls>` 里交给模型，让路径正则对上真实路径；map 失败或只有起始页时只用 prompt。

batch 和 extract 的默认值：

- **`ignoreInvalidURLs` 默认 `true`**（以前是 `false`）：无效 URL 被跳过，列在响应的 `invalidURLs` 里（没有无效 URL 时没有这个字段，以前显式设 `true` 时是 `[]`）；设成 `false` 恢复 400。URL 全部无效时仍是 400。
- **extract 没有 `urls` 时直接搜索 prompt**，不再要求 `enableWebSearch: true`；搜索取 10 条结果（以前 5 条）。有 `urls` 时 `enableWebSearch: true` 仍会把搜索结果加进去。**只想抽给定页面的调用方注意**：现在 `urls` 里的 URL 全部无效时返回 400，不会退化成联网搜索；`enableWebSearch` 没有 `prompt` 也是 400。
- extract 新增 `limit`（`/*` 展开的页数上限，覆盖 `SEX_EXTRACT_WILDCARD_PAGES`）、`includeSubdomains`（`/*` 展开是否含子域名，默认 `true`）、`timeout`（毫秒，整个 extract 的期限，到期 job 记为 `failed`；不设则没有期限）。这三个以前被静默丢掉。
- extract 状态多了 `tokensUsed`（这次运行里所有 LLM 调用的 token 数，含 prompt 注入检查和纠错重试；重新投递的 extract 从零开始数，不累加），`creditsUsed` 是读到的页面数。
- `showSources: true` 时 `sources` 除 `"*"`（用到的全部页面）外，还有数组项的来源，如 `"products[0]": [url, ...]`（只覆盖顶层数组；根是数组时键为 `[0]`）。来源是合并后按"同一个实体"反查的，两个字段都空的对象只在内容完全相同时才算同一个。
- 单答案字段在不同页面的 LLM 回答里取值不同时，仍取第一个，但 `warning` 会列出这些字段。
- extract 的 `total` 和 `completed` 都是成功读到的页数；读不到的页面只在 `/errors` 里。

## Webhook

crawl、batch scrape、extract 的请求都可以带 `webhook`（URL 字符串，或 `{ url, headers, metadata, events }`）。事件类型是 `<kind>.<event>`：`crawl` / `batch_scrape` / `extract` 加上 `started` / `page` / `completed` / `failed`；`events` 不写就是全部。

- **载荷**：`{ success, type, id, webhookId, data, metadata, error? }`。`webhookId` 是这次投递的唯一 id，重试时不变，接收方可以用它去重。
- **`page`**：每页一个，`data` 是该页的 Document。页面失败时同样发 `page`，`success: false`，`error` 是原因，`data` 是 `[{ metadata: { sourceURL } }]`。crawl / batch 都是这样。
- **extract**：`started`、`completed`（`data: [结果]`）、`failed` 各一次。
- **签名**：设了 `SEX_WEBHOOK_SECRET` 就带 `X-Firecrawl-Signature: sha256=<hex>`（对原始请求体的 HMAC-SHA256）。请求里的 `headers` 不能设这个头，否则 400。
- **重试**：每次投递是任务队列里的一个任务（和页面任务一样，进程重启后继续）。2xx 算成功；网络错误、超时、5xx、408、429 会重试，其它 4xx 不重试。一共最多 5 次，间隔 5 s、10 s、20 s、40 s。每次最多 10 s。同时进行的投递最多 2 个（所有 job 共用），接收方慢不会占满页面的 worker。最后一次也失败只记日志，job 不受影响。投递是尽力而为：进程在一次尝试中途崩溃，这次尝试就丢了，不会重发。
- webhook 的 URL 同样经过 SSRF 检查（每次投递、每次重定向都检查）。

## HTTP API（Firecrawl v2 兼容）

| Endpoint | 说明 |
|---|---|
| `GET /health` | 健康检查，返回版本，以及 SearXNG / 浏览器 / LLM / 任务存储 / 文档存储（`documents`，如 `s3://bucket/prefix`）的状态摘要 |
| `POST /v2/scrape` | 单页抓取 |
| `POST /v2/parse` | 上传文件（`multipart/form-data`：`file`，以及 JSON 字符串 `options`，字段同 `/v2/scrape` 的选项），返回 Document。PDF 任何情况下都能解析（不开 `--docs` 走 unpdf）；Office 文档、图片需要 `--docs`，否则 `415`；超过 `SEX_MAX_BODY_BYTES` 返回 `413`。不支持 `rawBase64` 和 `actions`。只有 sex 有，sex-lite 没有（`404`） |
| `POST /v2/search` | 搜索（`sources`: web/news/images，`scrapeOptions` 会顺便抓取结果页） |
| `POST /v2/map` | 列出站点 URL（sitemap + 页面链接 + SearXNG `site:`）；入口重定向后以最终地址为准，`filterByPath` 默认只返回入口路径下的 URL，`includePaths` / `excludePaths` 是路径正则，响应带 `id`，`useIndex` / `ignoreCache` 接受但忽略 |
| `POST /v2/crawl`、`GET/DELETE /v2/crawl/{id}`、`GET /v2/crawl/{id}/errors`、`GET /v2/crawl/active`（别名 `/v2/crawl/ongoing`）、`POST /v2/crawl/params-preview` | 异步爬取 |
| `POST /v2/batch/scrape`、`GET/DELETE /v2/batch/scrape/{id}`、`GET /v2/batch/scrape/{id}/errors` | 批量抓取 |
| `POST /v2/extract`、`GET /v2/extract/{id}` | LLM 结构化抽取 |
| `GET /v2/concurrency-check`、`GET /v2/team/queue-status` | 队列状态：数字直接取自队列（bunqueue）的计数和任务存储，`maxConcurrency` 是 `SEX_CONCURRENCY`。数的是**任务**（每个页面一个，webhook 投递也算），不是 job；`waitingJobsInQueue` 含延迟中的任务和被 `delay` / `maxConcurrency` 压住的任务。`mostRecentSuccess` 是最近一个 completed 的 job（只看还留着的 job，过了 `SEX_JOB_TTL_MS` 就没了），没有则为 `null` |

直接用官方 SDK：

```ts
import Firecrawl from "@mendable/firecrawl-js";
const fc = new Firecrawl({ apiUrl: "http://localhost:3002", apiKey: "anything" });
await fc.scrape("https://example.com", { formats: ["markdown"] });
```

`bun apps/sex/test/sdk-smoke.ts http://localhost:3002` 会用官方 JS SDK 把主要接口跑一遍。

**和 Firecrawl 的差异**

- 不鉴权，`Authorization` 头会被忽略。
- `blockAds` 默认 true 且真的生效，但只在浏览器路径上，用 EasyList / EasyPrivacy 的域名表按 label 匹配（Firecrawl 的 playwright-service 是 13 个域名的子串匹配），见[浏览器](#浏览器)。
- 不支持 `screenshot`、`deterministicJson`、`branding`、`product`、`menu`、`audio`、`video` 这几种格式，以及 `screenshot` / `pdf` 这两种 action，会返回 `501 NOT_SUPPORTED`。`changeTracking` 只有 sex 且有数据目录时支持，见[变更追踪](#变更追踪)，否则同样是 501。
- 没做的参数不会静默丢掉：
  - `redactPII`、`zeroDataRetention`（scrape、search）、`onlyCleanContent` 为真时返回 `501 NOT_SUPPORTED`。
  - `maxAge`、`storeInCache`、`minAge`、`lockdown` 见[页面缓存](#页面缓存)。**默认 `maxAge` 是 0（总是现抓），不是 Firecrawl 的两天**，要默认用缓存设 `SEX_CACHE_MAX_AGE_MS`。sex-lite 和没有数据目录的 sex 没有缓存：`maxAge`、`storeInCache` 接受但没有效果，`lockdown`、`minAge` 返回 Firecrawl 的 `404 SCRAPE_NO_CACHED_DATA`，不去抓活页面。
  - `proxy` 是 `basic` / `stealth` / `enhanced` / `auto` 之一；`enhanced` 没有对应的代理池（`stealth` 在设了 `SEX_STEALTH_PROXY_URL` 时可用，见[出站代理](#出站代理)），`location.country` 不做地域定位，没有浏览器时 `mobile` 只改 User-Agent，这几项在 `warning` 里写 `-- your scrape may be partial`。搜索的 `country` / `location` 和不是 `qdr:` 的 `tbs` 同样不生效，`warning` 里也有说明。`json` 格式的 `model` 被忽略（模型是 `SEX_LLM_MODEL`），也有 warning。
  - `rawBase64` 格式返回原始字节的 base64（`document.rawBase64`），不能和其它格式、`checkPromptInjection`、`actions` 组合（`400`）；有浏览器时也直接 HTTP 抓取，不渲染。
  - `fastMode: true` 跳过浏览器，只做 HTTP 抓取（脚本不会运行），不能和 `actions` 一起用（`400`）。
  - 其它不存在的字段仍被丢掉（官方 SDK 会带 `origin`、`integration` 之类）；设 `SEX_STRICT_REQUESTS=1` 后改为返回 `400`（`Unrecognized key in body: "..."`）。
  - extract 的 `allowExternalLinks` 会接受但忽略。
- `parsers` 只接受 `"pdf"`、`"image"`、`{ "type": "pdf", ... }` 和 `{ "type": "image" }`，拼错或多出字段返回 `400`。PDF parser 用 `maxPages`、`pages`（别名 `pageMarkdown`：`pages: true` 时响应多一个 `pages: [{ pageNumber, markdown }]`，每页一项，空页也在）和 `pageMarkers`（`markdown` 里页与页之间是 `---` 和 `<!-- page N -->`，第一页前没有标记，空页跳过所以页号可能不连续）；unpdf 和 here-docs 两条路径都支持。`mode`、`blocks`、`refresh` 接受但没有效果，设了会在 `warning` 里列出（`mode` 需要 here-docs 先暴露 OCR 开关或每页是否 OCR 的信息）。`parsers` 不含 `pdf` 时 PDF 不解析，`markdown` 和 `html` 是文件的 base64，`metadata.contentType` 为 `application/pdf`（和 Firecrawl 一致，以前是 `415`）。开了 `--docs` 时 PDF 的 `metadata.title` 不再取自 PDF 元数据（here-docs 不提供），标题以正文里的标题为准。
- **`metadata.numPages` 的语义变了**：以前是文件的总页数，现在是实际解析的页数（`min(总页数, maxPages)`，超时只转换了一部分时是已转换的页数），和 Firecrawl 一致；总页数在新增的 `metadata.totalPages` 里。没传 `maxPages` 的请求两者相同；传了的，读 `numPages` 当总页数的调用方要改读 `totalPages`。
- 搜索：SearXNG 请求遇到网络错误或 5xx 时，约 400 ms 后重试 1 次（在整体 deadline 内）；结果为空且 SearXNG 报告了 `unresponsive_engines`（如 Google 被 captcha）时，引擎和原因写进 `warning`。不传 `timeout` 时整个搜索（含 scrape）的 deadline 是 `max(SEX_TIMEOUT × 2, 60000)` ms。`includeDomains` 会去掉首尾空白、转小写并校验主机名（不合法返回 `400`），按域名并发的 SearXNG 查询在整个进程内共享 4 个并发。没有搜索结果缓存。
  - 与 Firecrawl v2 对齐：`safe: true` 对应 SearXNG 的 `safesearch=2`；响应有 `id`（UUID）和 `creditsUsed: 0`（`creditsUsed` 恒为 0）；`web` / `news` 结果带 `category`（github.com → `github`，`.pdf` → `pdf`，`.gov` → `gov`，SearXNG 的 `science` → `research`、`it` → `developer`，其余没有）。`limit` 缺省时 **HTTP `/v2/search` 为 10**（同 Firecrawl），CLI 和 MCP `web_search` 为 5（省 LLM 的 token）。无法支持的参数不会静默忽略：`tbs` 不是 `qdr:h|d|w|m|y`、`country`、`location` 都会写进 `warning`。
  - query 里的 `site:` / `-site:` 会在结果上强制执行（部分引擎忽略它）；query 里同时有 `site:` 和 `inurl:` / `intitle:`（含取反）时，后两者从查询里去掉、改在结果上过滤，靠翻页（最多 5 页）凑满 `limit`。引号里的内容不解析，引号不成对、或 `OR` / `|` 连接了 `site:` 以外的内容时，整条 query 原样交给引擎、不做过滤。单独的 `inurl:` / `intitle:`（没有 `site:`）原样交给引擎。
- `links` / `images` 格式取自整个页面（含导航、页脚），不受 `onlyMainContent` 影响，这一点与 Firecrawl 只取主内容不同。`links` 去掉 `#fragment` 后去重、丢掉纯 `#fragment` 链接、保留 `mailto:`；`images` 包含 `srcset` 的全部候选、`<picture>` 的 `source`、`video[poster]` 以及 `og:image` / `og:image:secure_url` / `twitter:image`。`metadata` 里带映射名的 meta 同时有映射名（`ogTitle`）和原名（`og:title`）；`favicon` 只在页面声明时返回。
- Google Docs / Slides / Sheets / Drive 链接会改写成导出链接再抓取（Docs、Slides → PDF，Sheets → CSV，Drive 文件 → 直接下载），`metadata.sourceURL` 仍是原链接；改写后的 URL 同样要过 SSRF 检查。URL 扩展名是文档（pdf / office / epub / rtf）或图片时不经过浏览器，直接 HTTP 抓取；响应没有 content-type 且开了 `--docs` 时，按扩展名交给 here-docs 转换，否则当作 HTML。
- 调度：每个 job 的页面任务排在自己的队列里，各 job 轮流取用 worker，一个 10000 URL 的 batch 不会挡住别的 job；crawl 起始和 extract 不排队，优先于所有页面任务。`maxConcurrency` 限制单个 job 同时抓取的页面数（仍受 `SEX_CONCURRENCY` 限制）；设了 `delay` 时页面一个接一个地抓，上一页完成后等 `delay` 秒才开始下一页（不再预先分配时间槽）。进程重启后，上一页完成时间不会保留，重启后的第一页可能比 `delay` 早。
- crawl 遵守 robots.txt（RFC 9309）：robots.txt 返回 5xx 时视为全部禁止，返回 4xx 时视为全部允许。
- **一个 deadline**：一次 scrape 只有一个期限，由 `timeout`（默认 `SEX_TIMEOUT`，从开始抓取算起，排队不算）和调用方的取消共同决定；请求用到 LLM（LLM 格式 json / summary / question / highlights，或 `checkPromptInjection`）且没传 `timeout` 时，默认值是 `max(SEX_TIMEOUT, 60000)`（Firecrawl 对 json 同样把 30 秒改成 60 秒）。抓取或渲染、`waitFor`、`wait` action、`executeJavascript`、页面脚本、正文抽取和文档转换都在这个期限内；到期返回 `408 SCRAPE_TIMEOUT`，浏览器页面随即关闭并释放名额。客户端断开或任务被取消返回 `408 TIMEOUT`。
  - LLM 格式（json / summary / question / highlights）和 `checkPromptInjection` 的调用也在这个期限内，到期同样返回 `408 SCRAPE_TIMEOUT`；每次 LLM 调用的预算是 `min(SEX_LLM_TIMEOUT, 期限剩余时间)`。例外：extract 任务自己抓页面时开了 `checkPromptInjection`，它的 LLM 调用不受页面 `timeout` 约束，只受任务取消和 `SEX_LLM_TIMEOUT` 约束。
  - `waitFor` 加上所有 `wait` action 的 `milliseconds` 超过 60000 返回 `400`；`waitFor` 超过 `timeout` 的一半时不拒绝，只在 `warning` 里提醒。`wait` action 的 `milliseconds` 与 `selector` 必须二选一（以前两者都不给时默认等 1 秒）。
- 请求参数有上限，超出时返回 `400 BAD_REQUEST`，例如：`waitFor` 加上所有 `wait` action 的 `milliseconds` ≤ 60000 ms；`timeout` 在 1000–300000 ms；`formats`、`actions`、`includeTags`、`excludeTags`、`includePaths`、`excludePaths`、域名列表 ≤ 20 / 50 / 100 项不等（见 `packages/core/src/schemas.ts` 和 `apps/sex/src/schemas.ts`）；`urls` 批量 ≤ 10000；crawl `limit` ≤ 100000；`delay` ≤ 60 秒。
- `includePaths` / `excludePaths` 的正则会被启发式检查：带无界量词的分组再被无界量词修饰（`(a+)+`）、或分支相互重叠的量词分组（`(a|a)*`）会返回 `400`；每条 ≤ 1000 字符、≤ 100 条，匹配前 URL 截到 2048 字符。look-around 和反向引用仍然允许。
- LLM 相关的格式（json / summary / question / highlights）和 extract：
  - 带 JSON Schema 时，模型输出会按原始 schema 校验（Ajv，按 `$schema` 选择 draft-07 / 2019-09 / 2020-12，未写时按 2020-12；`format` 不校验）。输出不是合法 JSON 或不符合 schema 时，会把错误发回给模型修正一次，仍不符合才返回 `422 LLM_INVALID_OUTPUT`。schema 本身不合法时，在开始抓取之前就返回 `400 BAD_REQUEST`。根节点是数组的 schema 会包成 `{ items }` 发给模型（structured output 要求根节点是对象），返回时再拆开。
  - 页面内容放在 `<page>` 等标签里交给模型，system prompt 声明标签内是不可信内容，页面里的同名标签会被转义。页面超过 `SEX_LLM_MAX_INPUT_CHARS` 时截断，并在 `warning` 里说明。
  - `highlights` 和 `query` 格式的 `mode: "directQuote"` 让模型只返回编号，再从页面原文取出对应的内容，结果一定是原文。编号按行切，但代码围栏和表格整块算一个编号（超过 2000 字符的按整行分组），超过 400 字符的长行按句子切开（用运行时的 `Intl.Segmenter`，ICU 规则，中日文句号和 "e.g." 这类缩写都能处理；"Dr. Smith" 这类仍可能被切开）。`question` 和默认的 `query` 是自由回答。
  - `checkPromptInjection: true` 时，先用 LLM 检查送给模型的全部内容（标题加页面 markdown，按 32000 字符分块、块间重叠 2000），发现后返回 `403 SCRAPE_PROMPT_INJECTION_DETECTED`。页面超过 200 万字符时只检查前 200 万字符，其余部分不会送给模型，`warning` 里会说明。检查调用本身失败时放行，并在 `warning` 里说明有内容没检查到。extract 的 `scrapeOptions` 里也可以开；各页面的 `warning` 会带上页面 URL，汇总到 extract 状态的 `warning` 字段。
  - extract 的 URL 以 `/*` 结尾且有 `prompt` 时：先 map 取最多 200 个候选（按 prompt 关键词排序），再用一次小模型调用，根据 `url | title | description` 选出最相关的 `limit` 个（候选放在 `<links>` 标签里，模型只返回编号，所以不会多出候选以外的页面）。模型调用失败或一个都没选时，退回 map 的前 `limit` 个页面，并在 `warning` 里说明；没有 `prompt` 时不调用模型。这次调用计入 `tokensUsed`。
  - extract 的流程沿用 Firecrawl：只有 prompt 时先让模型生成 schema；schema 里有数组时，先判断是"单一答案"还是"多实体"。多实体的数组字段逐页抽取（每页带 `is_content_relevant`，不相关的页丢掉），其余字段把所有页面一起抽取；多份结果在代码里合并（数组拼接、去重，同一实体的空字段互相补全；标量取第一个非空值），不再让 LLM 合并。
  - 模型输出被截断（达到 token 上限）、被内容过滤拦截或没有内容时返回 `422 LLM_INCOMPLETE_OUTPUT`，模型拒答时返回 `422 LLM_REFUSED`，不会把不完整的结果当作正常结果返回。这几种重试结果不会变，所以不是 502（SDK 会自动重试 502，LLM 费用和延迟会翻几倍）。
  - 单个 LLM 格式失败不会让整个 scrape 失败：失败的 `json` 返回 `null`，`summary` / `question` / `highlights` 省略，原因追加到 `warning`（如 `JSON extraction failed: ...`），已抓到的 markdown 等内容照常返回。`403 SCRAPE_PROMPT_INJECTION_DETECTED`、`501 LLM_NOT_CONFIGURED` 和请求取消仍直接报错。extract 本身仍是失败即报错。
  - LLM 接口返回 429（或带 `retry-after` 的 503）时，按 `retry-after` 等待后最多重试 2 次，等待时间算在 `SEX_LLM_TIMEOUT` 内；仍然失败时返回 `429 LLM_RATE_LIMITED`。错误详情里带上游的 request id。
- 任务取消后，正在执行的页面会跑完，但结果会被丢弃；还在队列里的任务会被跳过。
- 不支持 SDK 的 `watcher()`（WebSocket 推送任务进度），只能轮询。
- 出于 SSRF 防护，`serve` 默认拒绝抓取内网和回环地址，可以用 `--allow-private-network` 放开。`search` 和 `fetch` 这两个 CLI 命令默认允许。
  - 域名解析后，连接只使用已经通过检查的 IP，因此 DNS rebinding 无法在检查后把请求转到内网。每次重定向都会重新检查。
  - 配了 `SEX_PROXY_URL` 时由代理解析域名，无法固定 IP，见[出站代理](#出站代理)。
  - 浏览器模式下，页面发出的子请求同样经过检查，指向内网的请求会被拦截；检查的位置按浏览器不同（Lightpanda 自带的选项、本机浏览器的 `EgressProxy`、远程浏览器的 CDP request guard），见[浏览器](#浏览器)的表。
  - 绑定到非回环地址时（如 Docker 里的 `--host 0.0.0.0`），默认不做 Host 检查，需要自己设置 `SEX_ALLOWED_HOSTS`。
- 跨域和 Host 检查：
  - CORS 默认关闭。只有设置 `SEX_CORS_ORIGINS` 后，列出的 origin 才能跨域调用。
  - 请求带 `Origin` 头时，必须属于 `SEX_CORS_ORIGINS`，或与 `Host` 同源，否则返回 `403 ORIGIN_NOT_ALLOWED`。不带 `Origin` 的非浏览器客户端不受影响。
  - 设置 `SEX_ALLOWED_HOSTS` 后，`Host` 头的主机名必须在列表里，否则返回 `403 HOST_NOT_ALLOWED`；未设置时，只有回环绑定会检查 `Host` 是否为 localhost 名。
- 浏览器模式下，PDF 等非 HTML 响应会回退为普通 HTTP 抓取；`skipTlsVerification` 在 Chrome 上生效。

### 错误码

错误响应是 `{ "success": false, "code", "error", "retryable", "details"? }`（请求体校验失败的 400 没有 `retryable`），HTTP 状态码表示错误类别：不管重试几次结果都一样的失败不会用 502/503，因为官方 SDK 会自动重试 502（LLM 费用和延迟会翻几倍）。`retryable` 表示重试同一个请求是否可能成功。所有错误码、状态码和 `retryable` 集中定义在 `packages/errors/src/index.ts` 的 `ERRORS` 里。

| 状态 | code | 说明 | `retryable` |
|---|---|---|---|
| 400 | `BAD_REQUEST`、`CONFIG_INVALID` | 请求参数不合法（含 `waitFor` + `wait` 超过 60000、`wait` 缺 / 同时给 `milliseconds` 和 `selector`） | 否 |
| 400 | `ACTION_FAILED` | 浏览器 action 执行失败（选择器不存在、脚本报错）；到期则是 `SCRAPE_TIMEOUT` | 否 |
| 403 | `PRIVATE_NETWORK_BLOCKED`、`SCRAPE_PROMPT_INJECTION_DETECTED` | 内网地址被拦截；注入检查命中 | 否 |
| 404 | `SCRAPE_NO_CACHED_DATA` | `lockdown` / `minAge` 只读缓存，而没有缓存，或缓存里没有符合的页面 | 否 |
| 408 | `SCRAPE_TIMEOUT` | scrape 的 deadline 到期 | 是 |
| 408 | `TIMEOUT` | 调用方取消；或单个 LLM 调用、SearXNG 请求超过自己的限制 | 否 |
| 413 / 415 / 508 | `RESPONSE_TOO_LARGE`、`UNSUPPORTED_FILE`、`TOO_MANY_REDIRECTS` | 响应太大、文件类型不支持、重定向过多 | 否 |
| 422 | `LLM_REFUSED`、`LLM_INVALID_OUTPUT`、`LLM_INCOMPLETE_OUTPUT` | 模型拒答、输出不合法、输出被截断 / 过滤 / 为空 | 否 |
| 422 | `DOCUMENT_PARSE_FAILED`、`PDF_PARSE_FAILED`、`EXTRACT_TIMEOUT` | 文档无法解析；正文抽取超过 worker 的上限 | 否 |
| 429 | `LLM_RATE_LIMITED` | LLM 限流（已按 `retry-after` 重试过） | 是 |
| 500 | `LLM_REQUEST_REJECTED` | LLM 接口返回 4xx（400 / 401 / 403 / 404 等：key 错、模型名错、请求被拒），是配置错误，重试没用；检查 `SEX_LLM_MODEL` / `SEX_LLM_BASE_URL` / `SEX_LLM_API_KEY` | 否 |
| 500 | `SCRAPE_DNS_RESOLUTION_ERROR` | 域名解析失败（`ENOTFOUND` / `EAI_AGAIN` / `net::ERR_NAME_NOT_RESOLVED`） | 否 |
| 500 | `SCRAPE_SSL_ERROR` | TLS 证书无效或握手失败；证书问题的提示里会说明可以传 `skipTlsVerification: true` | 否 |
| 500 | `SCRAPE_SITE_ERROR` | 连接被拒绝 / 重置 / 中断，或浏览器报告其它 `net::ERR_*` | 是 |
| 500 | `FETCH_FAILED` | 其它抓取失败 | 否 |
| 500 | `EXTRACT_FAILED`、`DOCUMENT_CONVERT_FAILED`、`INTERNAL_ERROR` | 内部错误 | 否 |
| 501 | `NOT_SUPPORTED`、`BROWSER_NOT_CONFIGURED`、`LLM_NOT_CONFIGURED`、`BROWSER_INTERCEPTION_UNSUPPORTED` | 功能不支持或没配置 | 否 |
| 502 | `LLM_ERROR`、`SEARCH_BACKEND_ERROR` | 上游（LLM 服务、SearXNG）自己返回了 5xx 或其它错误；SearXNG 的 5xx 可重试 | 是 / 否 |
| 502 | `BROWSER_UNAVAILABLE`、`DOCS_UNAVAILABLE`、`LLM_UNAVAILABLE`、`SEARCH_BACKEND_UNAVAILABLE` | 后端起不来或连不上 | 是 |

和 Firecrawl 的差异：DNS 解析失败时 Firecrawl 返回 HTTP 200 加 `success: false`，sex 仍用 HTTP 状态码表示错误（`500 SCRAPE_DNS_RESOLUTION_ERROR`），错误码相同。`ACTION_FAILED` 没有改名成 `SCRAPE_ACTION_ERROR`。

## MCP

工具：`web_fetch`、`web_search`、`web_map`、`web_crawl`、`web_crawl_status`、`web_crawl_cancel`、`web_batch_scrape`、`web_batch_status`、`web_extract`、`web_extract_status`。参数沿用 firecrawl-mcp，只是把 `firecrawl_` 前缀换成了 `web_`（例如 `firecrawl_scrape` → `web_fetch`）。`SEX_MCP_TOOL_NAMES=firecrawl` 把 firecrawl-mcp 里也有的六个工具改回它的名字（`firecrawl_scrape`、`firecrawl_search`、`firecrawl_map`、`firecrawl_crawl`、`firecrawl_check_crawl_status`、`firecrawl_extract`，核对自 firecrawl/firecrawl-mcp-server 的 `src/server.ts`），按工具名写的权限白名单和提示词可以沿用；firecrawl-mcp 现在没有 batch、取消 crawl 和 extract 状态这几个工具，它们仍叫 `web_*`。服务端基于 `@modelcontextprotocol/server` v2。

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
- `web_extract` 最多等待 5 分钟，超时后取消任务并返回错误；`async: true` 时只返回任务 id，用 `web_extract_status` 查结果。
- `web_batch_status` 的分页和截断同 `web_crawl_status`。MCP 的 batch / extract 沿用 HTTP 的 schema，包括 `webhook`。

HTTP 传输（`serve`，端点 `/mcp`）始终是无状态的（SDK v2 的行为）。它和 HTTP API 在同一个进程、同一个端口上，所以 `/health`（JSON）、Host / Origin 检查和 CORS 设置也是同一套，见上文。

## 开发

```bash
bun run verify    # bun check && bun run lint && bun run test
bun run format    # biome --write
bun run test      # 即 bun test --conditions sex-source（monorepo 内的包经 sex-source 条件解析到 src/）；单元 + 集成测试（本地 fixture 站点、mock SearXNG、mock LLM，不依赖外网；apps/sex/test/docs.test.ts 会真的跑 here-docs，平台不支持时自动跳过）
```

可选的集成测试需要外部服务，没有设置对应变量时会跳过：

```bash
SEX_TEST_CDP_URL=http://127.0.0.1:9222 bun test --conditions sex-source apps/sex/test/browser.test.ts apps/sex/test/egress-browser.test.ts   # 需要一个正在运行的 CDP 浏览器（Chrome）；egress-browser 是真浏览器经 EgressProxy 的 SSRF 用例
SEX_TEST_SEARXNG=1 bun test --conditions sex-source packages/searxng/test/searxng.test.ts                   # 启动真的 SearXNG 二进制（可用 SEX_TEST_SEARXNG_PATH 指定），需要外网
SEX_TEST_LIGHTPANDA_PATH=./lightpanda bun test --conditions sex-source apps/sex/test/browser.test.ts    # 让 sex 自己 spawn 这个 Lightpanda 二进制（取法见「浏览器」一节），跑同一套用例，另加子进程用例：首次 spawn、被杀后重启、close 后无残留、sex 被 SIGKILL 后无孤儿
```

其它检查：`bun check`（类型检查），`bun run lint`（Biome）。`bun run build:packages` 用 tsdown 构建要发布的包，`bun run test:node` 在 Node 上对 dist 跑它们的测试（目前还没有发布包，两者都是空操作）；版本用 changesets 管理（`bun run changeset`）。
