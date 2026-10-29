# 开发

## 仓库结构

仓库是 Bun workspace，`packages/` 放库，`apps/` 放两个产品（架构和拆分计划见 [docs/architecture.md](architecture.md)）：

| 目录 | 内容 |
|---|---|
| `packages/scrape`（`@searxng-js/sex-scrape`，发布到 npm） | 抓一个 URL，得到 Markdown、HTML、links 等（Firecrawl 的 scrape），浏览器、LLM、文档转换、缓存、change tracking 以接口形式传入。Bun 和 Node 24 都能用；Node 上转 Markdown 需要装可选 peer `marked`，用法见 [packages/scrape/README.md](../packages/scrape/README.md) |
| `packages/search`（`@searxng-js/sex-search`，发布到 npm） | 用 SearXNG 搜索（Firecrawl 的 search），可以顺带抓取结果。Bun 和 Node 24 都能用，用法见 [packages/search/README.md](../packages/search/README.md) |
| `packages/server`（`@searxng-js/sex-server`，私有） | 两个产品共用的脚手架：`BaseEngine`、配置解析、`/v2/scrape` 和 `/v2/search` 路由、`web_fetch` / `web_search` 两个 MCP 工具、CLI 的公共部分。只跑在 Bun 上 |
| `packages/testing`（`@searxng-js/sex-testing`，私有） | 测试夹具：fixture 站点、mock SearXNG、计数代理。只给测试用 |
| `packages/egress`（`@searxng-js/sex-egress`，发布到 npm） | SSRF 安全的出站请求：`EgressPolicy`、`safeFetch`、`rewriteUrl`。Bun 和 Node 24 都能用，用法见 [packages/egress/README.md](../packages/egress/README.md) |
| `packages/page`（`@searxng-js/sex-page`，发布到 npm） | HTML 和 PDF 提取（Defuddle、unpdf、worker 线程池）、Markdown 转 HTML。Bun 和 Node 24 都能用；Node 上转 Markdown 需要装可选 peer `marked`，用法见 [packages/page/README.md](../packages/page/README.md) |
| `packages/searxng`（`@searxng-js/sex-searxng`，发布到 npm） | 连接外部 SearXNG，或把预编译的 SearXNG 作为子进程托管。Node 上给托管实例配代理需要装可选 peer `yaml`，用法见 [packages/searxng/README.md](../packages/searxng/README.md) |
| `packages/browser`（`@searxng-js/sex-browser`，发布到 npm） | 用浏览器渲染页面（Lightpanda 子进程或任意 CDP 浏览器），含 SSRF 执行、广告拦截和 `EgressProxy`；传给 sex-scrape 的 `browser`。Bun 和 Node 24 都能用，用法见 [packages/browser/README.md](../packages/browser/README.md) |
| `packages/llm`（`@searxng-js/sex-llm`，发布到 npm） | LLM 格式（json、summary、问答、highlights）、change tracking 的 json 描述和注入防护，任何 OpenAI 兼容端点；传给 sex-scrape 的 `llm`。Bun 和 Node 24 都能用，用法见 [packages/llm/README.md](../packages/llm/README.md) |
| `packages/docs`（`@searxng-js/sex-docs`，发布到 npm） | PDF、Office 文档和图片的转换与 OCR（here-docs）；传给 sex-scrape 的 `docs`。Node 上能否用取决于 here-docs，用法见 [packages/docs/README.md](../packages/docs/README.md) |
| `packages/store`（`@searxng-js/sex-store`，发布到 npm） | 页面缓存（`maxAge`）和 change tracking 的 SQLite 存储（`node:sqlite`）；传给 sex-scrape 的 `cache` / `changeTracker`。Bun 和 Node 24 都能用，用法见 [packages/store/README.md](../packages/store/README.md) |
| `packages/map`（`@searxng-js/sex-map`，发布到 npm） | 找出一个站点的 URL（Firecrawl 的 map）：sitemap、起始页的链接、SearXNG 的 `site:` 搜索，带 robots.txt 和路径过滤。Bun 和 Node 24 都能用，用法见 [packages/map/README.md](../packages/map/README.md) |
| `packages/jobs`（`@searxng-js/sex-jobs`，发布到 npm） | crawl、batch scrape、extract 任务：SQLite 任务存储（`node:sqlite`）、内存任务队列、webhook，文档存文件或 S3。Bun 和 Node 24 都能用；Node 上用 S3 需装可选 peer `@aws-sdk/client-s3`，用法见 [packages/jobs/README.md](../packages/jobs/README.md) |
| `packages/documents-s3`（`@searxng-js/sex-documents-s3`，私有） | 文档存 S3 的胶水：Bun 上 `Bun.S3Client`，Node 上动态 import `@aws-sdk/client-s3`；打包进 sex-jobs |
| `packages/deadline`（`@searxng-js/sex-deadline`，私有） | `Deadline`：一次操作剩下的时间加调用方的取消，打包进用到它的包；包的边界只传 `signal` 和可选的 `deadlineAt` |
| `packages/errors`（`@searxng-js/sex-errors`，私有） | `AppError` 和错误目录（`ERRORS`），打包进用到它的包；跨包判断错误用 `AppError.isInstance` |
| `apps/sex` | 完整版：在 sex-server 上装配 sex-browser、sex-llm、sex-docs、sex-store、sex-map 和 sex-jobs；bunqueue 的持久任务队列在 `apps/sex/src/engine/jobs/queue.ts`，只给这个 app 用 |
| `apps/sex-lite` | 轻量版：只用 sex-server、sex-scrape、sex-search |

## 命令

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

其它检查：`bun check`（类型检查），`bun run lint`（Biome）。`bun run build:packages` 用 tsdown 构建要发布的包，`bun run test:node` 在 Node 上对 dist 跑它们的测试（包的测试用 `node:test`，Bun 和 Node 都能跑；需要整个引擎、`Bun.serve` 或真浏览器的测试留在 `apps/sex/test`，用 `bun:test`）；版本用 changesets 管理（`bun run changeset`）。
