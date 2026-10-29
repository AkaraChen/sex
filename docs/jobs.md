# 任务：crawl / batch / extract

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
- `/errors` 里每条错误多了 `code`（错误码，见 [API 的错误码](api.md#错误码)；重启前记下的旧错误没有）。`/v2/crawl/active` 的每项多了 `created_at`。
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
