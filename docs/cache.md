# 页面缓存与变更追踪

## 页面缓存

`maxAge`、`storeInCache`、`minAge`、`lockdown` 按 Firecrawl 的含义工作（只有 sex，sex-lite 没有缓存）。缓存存在 `SEX_DATA_DIR/cache.sqlite`（`node:sqlite`，和任务数据库分开，大块内容和它的 WAL 不进 `jobs.sqlite`）；没有数据目录时（一次性 CLI 命令）没有缓存。

- **缓存什么**：抓到的内容，不是最后的 Document：HTTP 响应体（HTML、PDF、文件字节），浏览器渲染的页面则是渲染后的 HTML，zstd 压缩后一个 (URL, 变体) 一行。`formats`、选择器、`parsers`（含 `maxPages`）、LLM 格式都是对取出来的内容再做一遍，所以一条缓存可以回答所有格式的请求，命中时仍会解析（省掉的是下载和渲染）。只缓存 2xx 响应。
- **缓存键**：抓取用的 URL（重写后、去掉 `#` 片段）加变体：有没有走浏览器渲染、`blockAds: false`、`waitFor`、`mobile`、`skipTlsVerification`、`location.languages`。
- **不读也不写**：带 `actions` 或 `headers` 的请求，`rawBase64`，上传；以及请求没给 `maxAge`、而 `SEX_CACHE_MAX_AGE_MS` 是 0 的请求。
- **读写**：`maxAge`（毫秒）内的缓存命中；没命中就现抓，并写入缓存，除非 `storeInCache: false`。请求里明确给 `maxAge: 0`（和 Firecrawl 一致）是不读缓存、照常现抓，但仍然写入，用来刷新一条缓存。`metadata.cacheState` 是 `hit` / `miss`，命中时还有 `metadata.cachedAt`（写入时间，ISO 8601）。`lockdown` 和 `minAge` 只读缓存，永远不抓页面：`minAge` 要求缓存至少这么旧，没给 `maxAge` 时上限是 `SEX_CACHE_TTL_MS`，没有符合的缓存（或请求本来就不缓存）返回 `404 SCRAPE_NO_CACHED_DATA`。
- **过期与容量**：超过 `SEX_CACHE_TTL_MS` 的在启动时和之后每 10 分钟（写入时检查）删除；总大小超过 `SEX_CACHE_MAX_BYTES` 时删最久没被用到的；压缩后超过上限 1/8 的单个页面不缓存。缓存文件打不开或不是数据库时重建。
- **命中和现抓的差别**：浏览器渲染的页面存的是渲染后的 HTML，命中时在 Node 里用 linkedom 重新解析，而现抓是在浏览器里跑页面脚本，个别页面的结果会有细微差别；命中时 `mobile` 没有浏览器的 warning 也不再出现。crawl、batch 和 search 的 `scrapeOptions` 里给 `maxAge` 同样生效。

## 变更追踪

`formats: ["markdown", { "type": "changeTracking", "modes": ["git-diff", "json"], "tag": "daily" }]` 把这次抓到的页面和同一个 URL（和 `tag`）上一次抓到的比较，结果在文档的 `changeTracking` 里，字段和 Firecrawl 一样：`changeStatus`（`new` / `same` / `changed` / `removed`）、`previousScrapeAt`（上一次抓取时间，ISO 8601，第一次是 `null`）、`visibility`、`diff`、`json`。只有 sex 支持；sex-lite 和没有 `SEX_DATA_DIR` 的 sex 返回 `501 NOT_SUPPORTED`（提示里写明怎么开）。

- **存储**：`SEX_DATA_DIR/change-tracking.sqlite`（`node:sqlite`），每个 (URL, tag) 一行，存最近一次的 markdown（zstd 压缩）。新的抓取直接覆盖旧的，**不过期、不淘汰**，也不是页面缓存（缓存会过期和淘汰，这里存的是下一次比较的唯一依据）。文件打不开时 `changeTracking` 不返回、文档带 `warning`，不会悄悄重建成全部 `new`。URL 是请求的 URL（`sourceURL`），`tag` 为空串等于没给 `tag`。
- **`changeStatus`**（Firecrawl 的规则）：没有上一次是 `new`；页面返回 404 是 `removed`；否则去掉 `[iframe](…)`、把连续空白当成一个空格后，**文本逐字相等**才是 `same`，不然 `changed`（调换段落、改一个字都是 `changed`；Firecrawl 只比较去掉空白后各字符出现的次数，会把这些误判成 `same`，sex 不照搬）。只有 2xx 的页面会写入，所以 404 或错误页不会成为下一次的比较对象。必须同时请求 `markdown`，否则 `400`。上传（`/v2/parse`）不支持。
- **`modes`**（只在 `changed` 时给）：`git-diff` 给 `diff.text`（`previous.md` → `current.md` 的 unified diff，3 行上下文）和 `diff.json`（Firecrawl 的 `{ files: [{ from, to, chunks: [{ content, changes }] }] }` 结构），用 [jsdiff](https://github.com/kpdecker/jsdiff) 生成，页面太大、5 秒内比不完时跳过并加 warning。`json` 需要 LLM（没有是 `501 LLM_NOT_CONFIGURED`）：给了 `schema` 就对两个版本各抽取一次、逐个顶层字段比较（`{ 字段: { previous, current } }`）；没给就让 LLM 按 `prompt` 描述两个版本的差别。LLM 调用失败只丢掉 `json`（带 warning），不影响抓取和写入。
- **`visibility`** 总是 `visible`：Firecrawl 的 `hidden` 是 crawl 里不在范围内的 URL，sex 没有这个概念。
- 和 Firecrawl 的差别：Firecrawl 在带 `changeTracking` 时把 `waitFor` 提到 5 秒、`timeout` 提到 60 秒，sex 不改（`json` 模式照常按 LLM 格式给至少 60 秒）；不带 `changeTracking` 的抓取不会更新记录；`changed` 的判断比 Firecrawl 严格（逐字相等，见上）。
- 同一个 (URL, tag) 并发抓取时后写入的覆盖先写入的，没有锁。
