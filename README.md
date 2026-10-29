<div align="center">

# sex

**自托管的 Web 搜索 + 网页抓取，Firecrawl v2 API 的 drop-in 替代品**

一个二进制文件，开箱即用：CLI、HTTP API、MCP Server 三合一。不需要 API key，也不需要外部服务。

[![CI](https://github.com/AkaraChen/sex/actions/workflows/ci.yml/badge.svg)](https://github.com/AkaraChen/sex/actions/workflows/ci.yml)
![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)
![Firecrawl v2 compatible](https://img.shields.io/badge/Firecrawl-v2%20compatible-orange)
![MCP](https://img.shields.io/badge/MCP-streamable%20HTTP-blue)

[对比 Firecrawl](#和-firecrawl-官方自托管方案的对比) · [快速开始](#快速开始) · [使用方式](#使用方式) · [功能](#功能) · [配置](#配置) · [文档](#文档)

</div>

---

## 为什么用 sex

- **直接换掉 Firecrawl**：实现 Firecrawl v2 的 `/v2/scrape`、`/v2/search`、`/v2/map`、`/v2/crawl`、`/v2/batch/scrape`、`/v2/extract` 等接口。官方 SDK 把 `apiUrl` 指过来就能用，不用改代码。
- **给 AI Agent 用的搜索和抓取**：内置 MCP Server（streamable HTTP），Claude Code、Cursor 等客户端加一行配置就能联网。
- **完全自托管**：搜索用 [SearXNG](https://github.com/searxng/searxng)，正文提取用 [Defuddle](https://github.com/kepano/defuddle)，都在本机跑。SearXNG、浏览器、文档转换引擎全部打包进一个可执行文件，由 sex 自己启动和管理。
- **按需开启高级能力**：JS 渲染（Lightpanda / Chrome）、PDF 和 Office 文档的结构化转换与本地 OCR、基于任意 OpenAI 兼容接口的 LLM 结构化抽取。不开就不占资源。
- **默认安全**：服务模式下默认拒绝内网、回环和云元数据地址（SSRF 防护覆盖每一跳重定向和浏览器里的每个子请求），支持出站代理和被拦截时自动换代理重试。

## 和 Firecrawl 官方自托管方案的对比

| | Firecrawl 自托管 | sex |
|---|---|---|
| 部署 | Docker Compose 起一组服务：API 和 worker、Playwright、Redis、RabbitMQ、PostgreSQL（NuQ 队列），以及可选的 FoundationDB | 一个进程：单文件可执行或一个容器，SearXNG 和浏览器由它作为子进程启动 |
| 数据持久化 | 官方 compose 没有给 PostgreSQL、Redis、RabbitMQ 定义 volume，需要自己加并做好备份 | 任务、队列、缓存存在一个数据目录里（compose 已挂好 volume），进程重启后任务接着跑 |
| 浏览器 | Playwright 服务（Chromium） | 内置 Lightpanda（轻量，空闲约 13 MB），也可以连接已有的 Chrome |
| 被网站拦截时 | 需要另外接入 Fire-engine 之类的抓取引擎 | 可配置一个 stealth 代理，遇到 403 / 429 时自动换代理重试 |
| MCP | 另装 firecrawl-mcp | 内置在同一个端口的 `/mcp` 上 |
| API | Firecrawl v2 原版 | 兼容 Firecrawl v2，差异见[下文](#和-firecrawl-的差异) |

两者的 API 默认都不鉴权，对外暴露前都需要自己加鉴权。

## 快速开始

### Docker Compose（推荐）

```bash
git clone https://github.com/AkaraChen/sex.git && cd sex
cp .env.example .env      # 可选：填写 SEX_LLM_* 开启 LLM 功能，SEX_DOCS=1 开启文档转换
docker compose up -d
```

启动后：

- HTTP API：<http://localhost:3002>（交互式文档在 [`/docs`](http://localhost:3002/docs)，OpenAPI 在 `/openapi.json`）
- MCP：<http://localhost:3002/mcp>

镜像里已经开启了浏览器（Lightpanda），任务数据保存在 `sex-data` volume 里，重启不丢。

### 从源码运行

需要 [Bun](https://bun.sh) 1.4+。

```bash
bun install                                   # 会同时装上本平台的 SearXNG 二进制
bun run dev search "defuddle"                 # 搜索
bun run dev fetch https://stephango.com/saw   # 抓取网页，输出 Markdown
bun run dev serve                             # 启动 HTTP API + MCP，默认 http://127.0.0.1:3002
```

### 构建单文件可执行

```bash
bun run build          # → dist/sex，内置 SearXNG、Lightpanda 和 here-docs
./dist/sex serve
```

## 使用方式

### 命令行

```bash
sex search "bun sqlite" -n 10 --sources web,news
sex search "rust async" --scrape                       # 顺便把每个结果抓成 Markdown
sex fetch https://example.com -f markdown,links
sex fetch https://example.com --json-prompt "提取页面里所有的价格" --llm-model gpt-4o-mini
```

`sex <command> --help` 查看全部参数。

### 用 Firecrawl SDK 调用 HTTP API

```ts
import Firecrawl from "@mendable/firecrawl-js";

const fc = new Firecrawl({ apiUrl: "http://localhost:3002", apiKey: "anything" });

await fc.scrape("https://example.com", { formats: ["markdown"] });
await fc.search("self-hosted search engine", { limit: 5 });
await fc.crawl("https://docs.example.com", { limit: 50 });
```

或者直接用 curl：

```bash
curl -s localhost:3002/v2/scrape -H 'content-type: application/json' \
  -d '{"url": "https://example.com", "formats": ["markdown"]}'
```

### 接入 MCP 客户端

先运行 `sex serve`（或 `docker compose up -d`），然后以 Claude Code 为例：

```bash
claude mcp add --transport http sex http://127.0.0.1:3002/mcp
```

或写进 `.mcp.json`：

```json
{
  "mcpServers": {
    "sex": { "type": "http", "url": "http://127.0.0.1:3002/mcp" }
  }
}
```

提供的工具：`web_search`、`web_fetch`、`web_map`、`web_crawl`、`web_crawl_status`、`web_crawl_cancel`、`web_batch_scrape`、`web_batch_status`、`web_extract`、`web_extract_status`。参数和 firecrawl-mcp 一致；设 `SEX_MCP_TOOL_NAMES=firecrawl` 可以直接沿用 firecrawl-mcp 的工具名。详见 [docs/mcp.md](docs/mcp.md)。

## 功能

| | 功能 | 需要 |
|---|---|---|
| 🔍 | 网页 / 新闻 / 图片搜索，支持 `site:`、时间过滤、域名过滤，可顺便抓取结果页 | — |
| 📄 | 网页转 Markdown / HTML / 链接 / 图片列表，自动识别正文 | — |
| 📑 | PDF 文本抽取，按页返回、可限制页数 | — |
| 🗺️ | `map`：通过 sitemap、页面链接和搜索列出站点 URL | — |
| 🕷️ | `crawl` / `batch scrape`：异步任务，进程重启后继续，支持 webhook | — |
| 💾 | 页面缓存（`maxAge`）和变更追踪（`changeTracking`，git-diff 模式） | 数据目录 |
| 🌐 | JS 渲染、页面交互（`actions`）、广告与追踪器拦截 | 浏览器 |
| 🧾 | PDF 结构化转换、扫描件 OCR、Word / PowerPoint / Excel / EPUB / 图片 | 文档转换 |
| 🤖 | `json` / `summary` / `highlights` 等 LLM 格式、`/v2/extract` 结构化抽取、用自然语言描述 crawl、提示词注入检测 | LLM |

可选能力的开启方式：

| 能力 | 开启 | 说明 |
|---|---|---|
| 浏览器 | `--lightpanda`（`SEX_LIGHTPANDA=1`）或 `--cdp-url ws://...` | Lightpanda 已内置在 `dist/sex` 和 Docker 镜像里；也可以连接已有的 Chrome。[详细说明](docs/browser.md) |
| 文档转换 | `--docs`（`SEX_DOCS=1`） | 基于 [here-docs](https://github.com/AkaraChen/here-docs)，完全本地运行。[详细说明](docs/documents.md) |
| LLM | `--llm-model`（`SEX_LLM_MODEL`）+ `SEX_LLM_BASE_URL` / `SEX_LLM_API_KEY` | 任意 OpenAI 兼容的 `/chat/completions` 接口 |

没开启却用到对应功能时，返回 `501` 并说明怎么开启。

## sex 与 sex-lite

只需要搜索和抓取的话，可以用更小的 **sex-lite**：

| | sex | sex-lite |
|---|---|---|
| 搜索、抓取（CLI / HTTP / MCP） | ✅ | ✅ |
| 浏览器、LLM、文档转换 | ✅ | — |
| map / crawl / batch / extract、缓存、变更追踪 | ✅ | — |
| 二进制大小 | 约 330 MB | 约 130 MB |

```bash
bun run dev:lite serve                 # 从源码运行
bun run build:lite                     # → dist/sex-lite
docker build --target lite -t sex-lite .
```

sex-lite 的用法和配置变量与 sex 相同；需要浏览器或 LLM 的请求会返回 `501` 并提示改用 sex。

## 配置

所有设置都可以用命令行参数或 `SEX_*` 环境变量给出（优先级：参数 > 环境变量 > 默认值）。常用的几项：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3002` / `127.0.0.1` | `serve` 监听的地址 |
| `SEX_SEARXNG_URL` | 无（sex 自己运行 SearXNG） | 使用已部署的 SearXNG 实例 |
| `SEX_LIGHTPANDA` / `SEX_CDP_URL` | 关 | 开启浏览器 |
| `SEX_DOCS` | 关 | 开启文档转换 |
| `SEX_LLM_MODEL` / `SEX_LLM_BASE_URL` / `SEX_LLM_API_KEY` | 无 | 开启 LLM 功能 |
| `SEX_DATA_DIR` | `~/.local/share/sex` | 任务、缓存的存储目录 |
| `SEX_PROXY_URL` | 无 | 出站代理（[说明](docs/proxy.md)） |
| `SEX_ALLOWED_HOSTS` / `SEX_CORS_ORIGINS` | 无 | 对外暴露服务时的 Host 白名单和 CORS |

完整列表见 [docs/configuration.md](docs/configuration.md)。

> [!IMPORTANT]
> HTTP API 不做鉴权。`serve` 默认只监听 `127.0.0.1`；对外暴露时请放在带鉴权的反向代理后面，并设置 `SEX_ALLOWED_HOSTS`。

## 和 Firecrawl 的差异

sex 尽量做到和 Firecrawl v2 行为一致，主要差别：

- 不鉴权，`Authorization` 头会被忽略。
- 不支持 `screenshot`、`branding`、`audio`、`video` 等格式和 `screenshot` / `pdf` action，返回 `501`；实现不了的参数会报错或在 `warning` 里说明，不会静默丢掉。
- 页面缓存默认关闭（Firecrawl 默认 `maxAge` 两天），可用 `SEX_CACHE_MAX_AGE_MS` 打开。
- 不支持 SDK 的 `watcher()`（WebSocket 推送），任务进度只能轮询。

完整的差异列表、接口说明和错误码见 [docs/api.md](docs/api.md)。

## 平台支持

| 平台 | 内置 SearXNG | 内置 Lightpanda | 文档转换 |
|---|---|---|---|
| Linux x64（glibc ≥ 2.35） | ✅ | ✅ | ✅ |
| Linux arm64（glibc ≥ 2.35） | 需 `SEX_SEARXNG_URL` | ✅ | ✅ |
| macOS arm64 | ✅ | ✅ | ✅ |
| macOS x64 | 需 `SEX_SEARXNG_URL` | ✅ | — |
| Windows x64 | ✅ | — | ✅ |

没有内置 SearXNG 的平台可以用 `SEX_SEARXNG_URL` 连接自己部署的实例（需开启 JSON 输出），见 [docs/searxng.md](docs/searxng.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [HTTP API](docs/api.md) | 接口列表、与 Firecrawl 的差异、错误码 |
| [MCP](docs/mcp.md) | 工具列表、客户端配置、默认值 |
| [配置](docs/configuration.md) | 全部环境变量和命令行参数 |
| [任务](docs/jobs.md) | crawl / batch / extract 的队列、持久化、状态字段和 webhook |
| [页面缓存与变更追踪](docs/cache.md) | `maxAge`、`changeTracking` |
| [浏览器](docs/browser.md) | Lightpanda / Chrome、SSRF 执行点、请求头、广告拦截 |
| [文档转换](docs/documents.md) | PDF、Office、图片 OCR |
| [出站代理](docs/proxy.md) | `SEX_PROXY_URL`、stealth 重试和安全边界 |
| [SearXNG](docs/searxng.md) | 内置 SearXNG 的运行方式和自定义配置 |
| [开发](docs/development.md) | 测试、检查和可选的集成测试 |

## 参与开发

```bash
bun install
bun run verify    # 类型检查 + lint + 测试
bun run format    # 格式化
```

仓库是 Bun workspace：`packages/core`（两个产品共用的搜索、抓取和服务框架）、`packages/sex`（完整版）、`packages/sex-lite`（轻量版）。测试不依赖外网，需要真实浏览器或 SearXNG 的集成测试见 [docs/development.md](docs/development.md)。

欢迎提 Issue 和 Pull Request。

## 致谢与第三方许可

sex 建立在这些项目之上：[SearXNG](https://github.com/searxng/searxng)、[Defuddle](https://github.com/kepano/defuddle)、[Lightpanda](https://github.com/lightpanda-io/browser)、[here-docs](https://github.com/AkaraChen/here-docs)、[bunqueue](https://bunqueue.dev)、[EasyList](https://easylist.to/)，以及 [Firecrawl](https://firecrawl.dev) 的 API 设计。

- **SearXNG** 二进制采用 AGPL-3.0-or-later。分发 `dist/sex` 或 Docker 镜像时需要同时提供对应源码（固定版本的 SearXNG 加 [AkaraChen/searxng](https://github.com/AkaraChen/searxng) 的构建脚本），见 `node_modules/@searxng-js/<平台>/THIRD-PARTY-NOTICES.md`。
- **广告域名表** 派生自 EasyList 和 EasyPrivacy（[easylist/easylist](https://github.com/easylist/easylist)），双许可 GPLv3 / CC BY-SA 3.0，随 `dist/sex` 一起分发；具体提交和校验和见 `packages/sex/scripts/adblock.ts`。
