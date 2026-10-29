# @searxng-js/sex-page

HTML and PDF content extraction, and Markdown to HTML.

- `extractFromHtmlInline(html, options)`: main-content extraction with [Defuddle](https://github.com/kepano/defuddle) on a linkedom document, returning cleaned HTML, Markdown, metadata, links, images and attribute values. `PAGE_SCRIPT` is the same extractor as a string, for injection into a browser page.
- `pdfToMarkdown(bytes, maxPages?)` (unpdf) and `joinPages`: text per page, with `---` separators or `<!-- page N -->` markers.
- `ExtractPool`: runs both in worker threads so a large page cannot block the event loop (`size: 0` runs on the calling thread). A job is cut by an `AbortSignal` (`SCRAPE_TIMEOUT` when its reason is a `TimeoutError`, `TIMEOUT` otherwise) and by `taskTimeoutMs` (`EXTRACT_TIMEOUT`); the worker that ran it is replaced.
- `markdownToHtml(markdown)`: GFM (tables, strikethrough, task lists). Raw HTML inside the Markdown is escaped, never passed through.

Errors are `AppError`s from the private `sex-errors` library, bundled in.

## Install

```sh
npm install @searxng-js/sex-page
```

## Example

```ts
import { ExtractPool } from "@searxng-js/sex-page";

const pool = new ExtractPool({ size: 2, taskTimeoutMs: 30_000 });
const page = await pool.html(html, { url: "https://example.com/", onlyMainContent: true, removeBase64Images: true, wantLinks: true, wantImages: false }, AbortSignal.timeout(10_000));
console.log(page.markdown);
await pool.close();
```

## Node

Works on Node 24 and Bun.

- The worker is `dist/extract-worker.js`, next to `dist/index.js`. Bundle both if you bundle the package, or pass `workerUrl`.
- On Bun, `markdownToHtml` uses `Bun.markdown`. On Node it needs the optional peer dependency [`marked`](https://www.npmjs.com/package/marked): `npm install marked`. Without it `markdownToHtml` throws a `NOT_SUPPORTED` error that says so. Nothing else needs it.

## Diagnostics

The package writes no log output itself. It publishes `{ level, msg, fields? }` on the [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) channel `searxng-js:sex:page`, where `level` is `"debug" | "info" | "warn" | "error"`, `msg` a string and `fields` a plain object (absent when there are none). Nothing is built or published while the channel has no subscriber. The channel name and the message shape are part of the package's public interface. Works on Node and Bun.

```ts
import { subscribe } from "node:diagnostics_channel";

subscribe("searxng-js:sex:page", ({ level, msg, fields }: any) => console.error(level, msg, fields));
```
