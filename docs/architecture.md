# 仓库架构：packages 与 apps

讨论和进度在 issue #94，本文与其正文保持一致。

## 目标

把仓库拆成可单独安装的包，让外部项目在 Node 或 Bun 上只引入 sex 的某几项能力。

- `packages/*`：库。发布到 npm 的用 scope `@searxng-js`，包名 `@searxng-js/sex-<name>`。
- `apps/sex`、`apps/sex-lite`：两个产品，私有，只跑在 Bun 上。它们只做组装：读 `SEX_*` 配置、拼出 `Engine`、注册路由和 MCP 工具、CLI、把 SearXNG / Lightpanda / here-docs 嵌进单文件二进制。

## 包的三类

### 第一类：功能包

用户为了这个功能而安装它。

**独立功能**

| 包 | 装它是为了 | 依赖 |
|---|---|---|
| `sex-scrape` | 抓一个 URL，得到 Markdown、HTML、links 等（Firecrawl 的 scrape） | `sex-egress`、`sex-page`；p-limit、zod |
| `sex-search` | 用 SearXNG 搜索，可以顺带抓取结果 | `sex-scrape`、`sex-searxng`；p-limit、zod |
| `sex-map` | 找出一个站点的 URL（sitemap、页面链接、搜索） | `sex-scrape`、`sex-search`、`sex-egress`；zod |
| `sex-jobs` | crawl、batch scrape、extract 任务，文档存文件或 S3 | `sex-scrape`、`sex-map`、`sex-egress`；zod。Node 上用 S3 需装可选 peer `@aws-sdk/client-s3` |
| `sex-egress` | SSRF 安全的出站请求：`EgressPolicy`、`safeFetch` | ipaddr.js |

**`sex-scrape` 的能力插件**

装上后传给 `sex-scrape`，让抓取多一种能力。对 `sex-scrape` 是 peer 依赖，保证全程只有一份。

| 包 | 装它是为了 | 依赖 |
|---|---|---|
| `sex-browser` | 用浏览器渲染页面（Lightpanda 或 CDP），含 adblock、`EgressProxy` | peer `sex-scrape`；`sex-egress`、`sex-page`；puppeteer-core |
| `sex-llm` | LLM 格式（json、summary、问答、highlights）和注入防护；`sex-jobs` 的 extract 也用它 | peer `sex-scrape`；xsai、ajv |
| `sex-docs` | PDF、Office 文档、图片的转换和 OCR | peer `sex-scrape`；here-docs。Node 上能否用取决于 here-docs |
| `sex-store` | 页面缓存（`maxAge`）和 change tracking | peer `sex-scrape`；diff |

### 第二类：依赖包

会发布，用户会装上，但不是冲着它装的，是功能包把它带进来的。

| 包 | 被谁带进来 | 内容 | 依赖 |
|---|---|---|---|
| `sex-page` | `sex-scrape`、`sex-browser` | HTML 和 PDF 提取：Defuddle、page-script、unpdf、extract worker 池、Markdown 转 HTML | defuddle、linkedom、unpdf。Node 上 Markdown 库是可选 peer |
| `sex-searxng` | `sex-search` | 连接外部 SearXNG，或作为子进程托管一个 | @searxng-js/searxng。Node 上 `yaml` 是可选 peer |

### 第三类：私有库

不发布。构建时打包进用到它的地方：第一类、第二类包，或者 apps。打包进发布包的私有库要能在 Node 上跑；只给 apps 用的只需要支持 Bun。

| 包 | 打包进 | 内容 |
|---|---|---|
| `sex-errors` | 所有发布包 | `AppError`、错误目录、`badRequest` 等辅助函数。类上带 `Symbol.for` 标记，见下方「错误」 |
| `sex-documents-s3` | `sex-jobs` | S3 胶水：Bun 上用 `Bun.S3Client`，Node 上动态 import `@aws-sdk/client-s3`，没装就报错 |
| `sex-server` | `apps/sex`、`apps/sex-lite` | 两个 app 共用的脚手架：Hono + oRPC、`/v2/scrape` 和 `/v2/search` 路由、`web_fetch` / `web_search` MCP 工具、`BaseEngine`、citty 的公共 flag。只跑在 Bun 上，直接用 `Bun.serve` |

### 不属于三类

- `sex-testing`：fixture 站点、mock SearXNG、mock LLM、counting proxy。只给测试用。
- bunqueue 实现的 `TaskQueue`：放在 `apps/sex/src`，只给 apps 用。等有外部的 Bun 项目要跑持久化任务，再提成功能包。

### 依赖图

实线是普通依赖，虚线是 peer 依赖，粗线是打包进去。

```mermaid
flowchart TB
  subgraph T1["第一类：功能包"]
    jobs["sex-jobs"]
    map["sex-map"]
    search["sex-search"]
    scrape["sex-scrape"]
    egress["sex-egress"]
    browser["sex-browser"]
    llm["sex-llm"]
    docs["sex-docs"]
    store["sex-store"]
  end
  subgraph T2["第二类：依赖包"]
    page["sex-page"]
    searxng["sex-searxng"]
  end
  subgraph T3["第三类：私有库"]
    errors["sex-errors<br/>打包进所有发布包"]
    s3["sex-documents-s3"]
    server["sex-server<br/>只给 apps 用"]
  end
  server --> scrape
  server --> search
  jobs --> scrape
  jobs --> map
  jobs --> egress
  map --> search
  map --> scrape
  map --> egress
  search --> scrape
  search --> searxng
  scrape --> egress
  scrape --> page
  browser --> egress
  browser --> page
  browser -.->|peer| scrape
  llm -.->|peer| scrape
  docs -.->|peer| scrape
  store -.->|peer| scrape
  s3 ==>|打包进| jobs
```

## 规则

### 代码

1. **库不读配置。** 每个包只接自己的 options。`SEX_*` 环境变量和 CLI flag 只在 apps 里解析。
2. **接口由使用方定义。** 比如 `ScrapeBrowser` 在 `sex-scrape` 里，`TaskQueue`、`DocumentLog` 在 `sex-jobs` 里。实现放在别的包，不会出现所有包都依赖的底座包。
3. **依赖通过普通对象传入。** 不用 DI 容器，不用 class 装饰器，不用 Effect。上下文参数写成小接口的交集，比如 `scrapeUrl(ctx: Fetcher & Extractor & Partial<Browser>)`，少传一项就是编译错误。
4. **生命周期用 `AsyncDisposable`。** 有资源的对象实现 `Symbol.asyncDispose`，组装处用 `AsyncDisposableStack` 逆序释放。
5. **schema 归各自的包。** 每个包导出自己输入、输出的 zod schema 和类型。用到别人的 schema，就依赖那个包。

### 错误

参照 AI SDK：`AppError` 带 `Symbol.for("searxng-js.sex.error")` 标记，`AppError.isInstance(e)` 检查标记。`Symbol.for` 走全局注册表，每个包各打包一份类也能互相识别（Node 和 Bun 已验证）。

- 跨包判断错误只用 `AppError.isInstance`，不用 `instanceof`。
- `status`、`retryable`、`blocked`、`fallback` 在构造时写到实例上。判断时读实例字段，不按 `code` 回查目录，因为不同包可能打包了不同版本的目录。
- 标记名和实例字段的形状是跨版本契约。做不兼容的改动时换一个标记名。

### 超时和取消

- 包的边界只传 `AbortSignal`。要把时间交给不认 signal 的 API（puppeteer 的 `timeout`、docs 的“剩余时间的 90%”）时，再传一个 `deadlineAt` 数字。
- 包的入口用 `AbortSignal.any([signal, AbortSignal.timeout(ms)])` 合并自己的超时。
- 超时还是取消，看 `signal.reason`：`TimeoutError` 是超时，`AbortError` 是取消。每个包翻译成自己的错误码。
- `sex-scrape` 内部要不要留一个 `Deadline` 小工具由它决定，不导出。

### 日志（待确认）

每个包接一个可选的 `logger` 选项，接口是 `debug`、`info`、`warn`、`error`，`console` 直接满足。不传时库不输出。原因：模块级的日志级别打包成多份后，app 设的级别传不到各个包。

### Bun 和 Node

| 情况 | 做法 | 例子 |
|---|---|---|
| 两边都有的 `node:` 内置模块 | 直接用，不设接口 | `node:sqlite`、`node:zlib` 的 zstd、`node:child_process`、`node:fs`、`node:timers/promises` |
| 只有 Bun 有内置实现 | `typeof Bun` 分支：Bun 用内置 API，Node 动态 import 可选 peer，没装就报错 | Markdown、YAML、S3 |
| 部署选择 | 接口加单独实现 | `TaskQueue` |

包里不能静态 import `bun:*` 或 `"bun"`。

```mermaid
flowchart TD
  call["包内调用 Markdown / YAML / S3"] --> isBun{"typeof Bun 存在？"}
  isBun -->|是| bunApi["Bun.markdown / Bun.YAML / Bun.S3Client"]
  isBun -->|否| imp["动态 import 可选 peer"]
  imp -->|已安装| lib["Markdown 库 / yaml / @aws-sdk/client-s3"]
  imp -->|未安装| err["抛错：告诉用户要装哪个包"]
```

### 依赖

Bun 用户不下载任何只给 Node 用的依赖。

- Node 专用的库只写进 `peerDependencies`，并在 `peerDependenciesMeta` 里标 optional。`bun install` 和 `npm install` 都不会自动装可选 peer（已验证）。
- 可选 peer 声明在含有这段 import 的发布包上。私有胶水打包进哪个包，就声明在哪个包上，否则 pnpm 解析不到。
- `.d.ts` 里不出现这些库的类型。
- 每个包的 README 写明 Node 上要多装什么、Node 上用不了什么。

## 构建和发布

- 每个发布包都打包，Bun 用户也一样，只发一份 `dist/index.js` 和 `dist/index.d.ts`。`files` 只有 `dist` 和 `README.md`。
- `exports`：

```json
{
  ".": {
    "sex-source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```

- `sex-source` 只在 monorepo 内部用。dev、test 和 apps 的二进制构建都带 `--conditions sex-source`，tsconfig 的 `customConditions` 也加上。`bun` 运行、`bun test`、`bun build` 都认这个条件，Node 不认（已验证）。
- tsdown 打包：私有库一律内联，发布包和 peer 依赖一律外部。
- changesets 管理版本，各包独立版本号，GitHub Actions 带 provenance 发布。Node 最低 24。

```mermaid
flowchart LR
  src["packages/*/src"] --> tsdown["tsdown 打包"]
  priv["第三类私有库的源码"] -->|内联| tsdown
  tsdown --> dist["dist/index.js<br/>dist/index.d.ts"]
  dist --> npm["npm @searxng-js/sex-*"]
  npm --> bunUser["Bun 用户"]
  npm --> nodeUser["Node 用户"]
  src -->|"--conditions sex-source"| mono["monorepo 内：apps 和 bun test"]
```

## 测试

- 包的测试用 `node:test` 和 `node:assert` 写，`bun test` 和 `node --test` 都能跑（已验证）。
- 测试按包名 import。Bun 带 `sex-source` 跑源码，Node 跑要发布的 `dist`。
- 测试文件只用可擦除的 TS 语法，因为 Node 只剥离类型，不支持 enum 和构造函数参数属性。
- apps、只给 apps 用的私有库（`sex-server`）和跨包集成测试保持 `bun:test`，只在 Bun 上跑。
- CI 两个 job：Bun 跑 `bun test --conditions sex-source`；Node 24 先 `bun run build:packages`，再对发布包和打包进发布包的私有库的测试跑 `node --test`。

## 落地顺序

自底向上：先第三类，再第二类，最后第一类。每步一个 PR，Bun 和 Node 的测试都要通过，同一个 PR 里更新 CLAUDE.md 的 Layout 和 README 的仓库结构表。

- [ ] 1. **骨架**：`apps/` 目录、tsdown、changesets、`sex-source` 条件、CI 的 Bun 和 Node 两个 job、Dockerfile 路径。
- [x] 2. **第三类 `sex-errors`**：`Symbol.for` 标记和 `isInstance`；11 处跨包的 `instanceof AppError` 换掉。（`log` 改成 `logger` 选项随各包抽出时做，不在本步。）
- [x] 3. **`sex-egress`**：边界改为 `signal`。它不依赖别的包，先做。
- [x] 4. **第二类 `sex-page`、`sex-searxng`**：Markdown、YAML 按运行时分支。
- [x] 5. **`sex-scrape`、`sex-search`、`sex-server`**：完成后 `apps/sex-lite` 完全基于新包，删除 `packages/core`。
- [ ] 6. **能力插件 `sex-browser`、`sex-llm`、`sex-docs`、`sex-store`**：SQLite、zstd 换成 `node:` 内置，换之前先测 SQLite 在 Bun 上的性能。
- [ ] 7. **`sex-map`、`sex-jobs`、第三类 `sex-documents-s3`**：bunqueue 队列移进 `apps/sex/src`。完成后 `apps/sex` 迁移完毕。
- [ ] 8. **首次发布到 npm。**

## 风险和待确认

- **SQLite 性能**：jobs 存储从 `bun:sqlite` 换成 `node:sqlite` 后，在 Bun 上可能变慢。如果明显变慢，jobs 的 SQLite 也改成按运行时分支。
- **类型内联**（第 2 步已确认，可行）：发布包引用私有库（`sex-errors`）时，tsdown 把 JS 和 `.d.ts` 里的 `AppError` 等都内联，dist 里没有私有包名。需要的配置：
  - `deps: { alwaysBundle: [/^@searxng-js\/sex-errors/] }`：私有库在 `dependencies` 里（`workspace:*`），默认会被当外部依赖，必须强制内联。
  - `inputOptions.resolve.conditionNames: ["sex-source", "import", "default"]`：私有库没有 dist 时也能从 `src` 解析。
  - `tsconfig: "../tsconfig.build.json"`：tsgo 生成 `.d.ts` 时，rolldown-plugin-dts 以 tsconfig 所在目录为根去找每个源文件的声明，所以 tsconfig 必须在包含所有被内联的包的目录里（`packages/tsconfig.build.json`，include `*/src`），不能用发布包自己目录里的。
  - `fixedExtension: false`，输出 `dist/index.js` 和 `dist/index.d.ts`，不是 `.mjs` / `.d.mts`；`format: "esm"`、`dts: true`。
  - 私有库自己也有 `tsdown.config.ts`，并设 `"sexNodeTests": true`：Node 测试按包名 import，Node 读 dist，所以 `build:packages` 也构建它。
- **日志**：`logger` 选项的方案待确认。

## 要改的现有约定

- CLAUDE.md「新错误码先进目录，按目录判断、不看 AppError 自己的 403」改为：判断读实例字段，跨包用 `isInstance`。
- CLAUDE.md「步骤里不许建 `AbortSignal.timeout` / `AbortSignal.any`，一律用 `Deadline`」改为：边界传 `signal` 和可选的 `deadlineAt`，包的入口可以合并自己的超时。
- CLAUDE.md「Markdown 只用 `Bun.markdown`」只在 Bun 分支成立，Node 分支用库。

## 当前进度

分支 `wip/package-split-v1` 上有一版按旧方案做的尝试（公开的 `sex-kit`、`sex-schemas`），只供参考 `apps/` 搬迁等机械步骤，不按它的包划分。


