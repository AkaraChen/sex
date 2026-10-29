# HTTP API（Firecrawl v2 兼容）

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

`bun packages/sex/test/sdk-smoke.ts http://localhost:3002` 会用官方 JS SDK 把主要接口跑一遍。

**和 Firecrawl 的差异**

- 不鉴权，`Authorization` 头会被忽略。
- `blockAds` 默认 true 且真的生效，但只在浏览器路径上，用 EasyList / EasyPrivacy 的域名表按 label 匹配（Firecrawl 的 playwright-service 是 13 个域名的子串匹配），见[浏览器](browser.md)。
- 不支持 `screenshot`、`deterministicJson`、`branding`、`product`、`menu`、`audio`、`video` 这几种格式，以及 `screenshot` / `pdf` 这两种 action，会返回 `501 NOT_SUPPORTED`。`changeTracking` 只有 sex 且有数据目录时支持，见[变更追踪](cache.md#变更追踪)，否则同样是 501。
- 没做的参数不会静默丢掉：
  - `redactPII`、`zeroDataRetention`（scrape、search）、`onlyCleanContent` 为真时返回 `501 NOT_SUPPORTED`。
  - `maxAge`、`storeInCache`、`minAge`、`lockdown` 见[页面缓存](cache.md#页面缓存)。**默认 `maxAge` 是 0（总是现抓），不是 Firecrawl 的两天**，要默认用缓存设 `SEX_CACHE_MAX_AGE_MS`。sex-lite 和没有数据目录的 sex 没有缓存：`maxAge`、`storeInCache` 接受但没有效果，`lockdown`、`minAge` 返回 Firecrawl 的 `404 SCRAPE_NO_CACHED_DATA`，不去抓活页面。
  - `proxy` 是 `basic` / `stealth` / `enhanced` / `auto` 之一；`enhanced` 没有对应的代理池（`stealth` 在设了 `SEX_STEALTH_PROXY_URL` 时可用，见[出站代理](proxy.md)），`location.country` 不做地域定位，没有浏览器时 `mobile` 只改 User-Agent，这几项在 `warning` 里写 `-- your scrape may be partial`。搜索的 `country` / `location` 和不是 `qdr:` 的 `tbs` 同样不生效，`warning` 里也有说明。`json` 格式的 `model` 被忽略（模型是 `SEX_LLM_MODEL`），也有 warning。
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
- 请求参数有上限，超出时返回 `400 BAD_REQUEST`，例如：`waitFor` 加上所有 `wait` action 的 `milliseconds` ≤ 60000 ms；`timeout` 在 1000–300000 ms；`formats`、`actions`、`includeTags`、`excludeTags`、`includePaths`、`excludePaths`、域名列表 ≤ 20 / 50 / 100 项不等（见 `packages/core/src/schemas.ts` 和 `packages/sex/src/schemas.ts`）；`urls` 批量 ≤ 10000；crawl `limit` ≤ 100000；`delay` ≤ 60 秒。
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
  - 配了 `SEX_PROXY_URL` 时由代理解析域名，无法固定 IP，见[出站代理](proxy.md)。
  - 浏览器模式下，页面发出的子请求同样经过检查，指向内网的请求会被拦截；检查的位置按浏览器不同（Lightpanda 自带的选项、本机浏览器的 `EgressProxy`、远程浏览器的 CDP request guard），见[浏览器](browser.md)的表。
  - 绑定到非回环地址时（如 Docker 里的 `--host 0.0.0.0`），默认不做 Host 检查，需要自己设置 `SEX_ALLOWED_HOSTS`。
- 跨域和 Host 检查：
  - CORS 默认关闭。只有设置 `SEX_CORS_ORIGINS` 后，列出的 origin 才能跨域调用。
  - 请求带 `Origin` 头时，必须属于 `SEX_CORS_ORIGINS`，或与 `Host` 同源，否则返回 `403 ORIGIN_NOT_ALLOWED`。不带 `Origin` 的非浏览器客户端不受影响。
  - 设置 `SEX_ALLOWED_HOSTS` 后，`Host` 头的主机名必须在列表里，否则返回 `403 HOST_NOT_ALLOWED`；未设置时，只有回环绑定会检查 `Host` 是否为 localhost 名。
- 浏览器模式下，PDF 等非 HTML 响应会回退为普通 HTTP 抓取；`skipTlsVerification` 在 Chrome 上生效。

## 错误码

错误响应是 `{ "success": false, "code", "error", "retryable", "details"? }`（请求体校验失败的 400 没有 `retryable`），HTTP 状态码表示错误类别：不管重试几次结果都一样的失败不会用 502/503，因为官方 SDK 会自动重试 502（LLM 费用和延迟会翻几倍）。`retryable` 表示重试同一个请求是否可能成功。所有错误码、状态码和 `retryable` 集中定义在 `packages/core/src/errors.ts` 的 `ERRORS` 里。

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
