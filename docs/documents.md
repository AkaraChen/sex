# 文档转换（here-docs）

`--docs`（`SEX_DOCS=1`）开启后，PDF、Office 文档和图片交给 [here-docs](https://github.com/AkaraChen/here-docs)，它在本地跑 Firecrawl 的 pdf-inspector / anydoc 和 PP-OCR，不依赖任何外部服务：

- **PDF**：能抽出文字的页输出带标题、列表、表格的 Markdown；扫描页和图片页逐页 OCR，按页序合并。`metadata.numPages` 是实际转换的页数，`metadata.totalPages` 是文件的总页数（不设 `maxPages` 时两者相同；这是语义变化，见 [HTTP API](api.md)）。
- **Office 等文档**：Word、PowerPoint、Excel、OpenDocument、EPUB、RTF 转成结构化 Markdown，内嵌图片的 OCR 文字插在原位置。
- **CSV**：`text/csv` 也交给 here-docs 转成 Markdown 表格；不开 `--docs` 时仍按纯文本返回。
- **图片**（`image/*`）：OCR。请求里显式传了 `parsers` 但不含 `"image"` 时仍返回 415，和 Firecrawl 一致。
- **页数上限**：`parsers: [{ "type": "pdf", "maxPages": N }]` 只转换前 N 页，后面的页不会被解析或 OCR，`warning` 里会说明实际转换了几页。不开 `--docs` 时 unpdf 路径同样遵守 `maxPages`：逐页抽取，到 `maxPages` 就停，后面的页不会被解析。
- **`html` / `rawHtml`**：文档的这两个字段是它的 Markdown 经 Bun 内置的 Markdown 渲染器（`Bun.markdown`）得到的 HTML，两者相同；Markdown 里的原始 HTML 会被转义，不会原样输出。链接地址照原样保留，调用方要自己做净化。
- **超时和取消**：转换受请求的 `timeout`（默认 `SEX_TIMEOUT`）约束，超时时已转换出若干页就返回这部分，`warning` 里写明只转换到第几页；一页都没转换出来才返回 `408 SCRAPE_TIMEOUT`（转换最多用掉剩余时间的 90%，留一点给后面的步骤）；排队等待转换的时间也算在 `timeout` 里；客户端断开或任务被取消时立即停止，返回 408。OCR 一页大约几百毫秒，长扫描件需要调大 `timeout` 或用 `maxPages`。
- **资源**：引擎在 `serve` 启动时加载（约 1–3 秒），每个进程一份，空闲时大约 200 MB 内存；OCR 吃 CPU，但跑在原生线程里，不阻塞事件循环。light-ocr 每个引擎只有一个识别线程，所以同时转换的文档数由 `SEX_DOCS_CONCURRENCY` 限制，超出的排队。加载失败时 `serve` 直接以 `error: DOCS_UNAVAILABLE: ...` 退出。

**运行方式**：`bun run build` 把 here-docs 和当前平台的原生引擎（约 160 MiB）一起打进 `dist/sex`（约 260 MiB）。原生库只能从磁盘上的真实文件加载，所以开了 `--docs` 后，第一次用到时会把它们解压到 `$XDG_CACHE_HOME/sex/docs-<hash>`（默认 `~/.cache/sex`，约 0.3–0.6 秒，之后复用；换版本自动换目录）。从源码运行（`bun run dev`）时直接用 `node_modules` 里的 here-docs。`bun apps/sex/scripts/build.ts --target bun-linux-arm64` 等可以构建其它平台，前提是 `node_modules` 里装了那个平台的原生包。支持的平台：Linux x64 / arm64（glibc 和 musl）、macOS arm64、Windows x64；Intel Mac 不支持。
