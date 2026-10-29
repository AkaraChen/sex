# @searxng-js/sex-scrape

Fetch a URL and get Markdown, HTML, links, images and more: Firecrawl v2's `scrape`, without a server.

- `scrapeUrl(ctx, url, options?, { signal?, deadlineAt? })` fetches through an SSRF-safe client ([`sex-egress`](../egress/README.md)), extracts the main content ([`sex-page`](../page/README.md)) and returns a Firecrawl-shaped `Document`. `scrapeUpload` does the same for a `File` you already have.
- `ScrapeOptions`, `ScrapeRequest`, `Document` and the rest of the request / response shapes are exported as zod schemas and types.
- Browser rendering, LLM formats (`json`, `summary`, `question`, `highlights`, the prompt injection guard), PDF / Office / image conversion, a page cache and `changeTracking` are not in this package. Pass an object that implements `ScrapeBrowser`, `ScrapeLlm`, `ScrapeDocs`, `ScrapeCache` or `ChangeTracker` in the context; without one, the option that needs it is refused with a `501` (`NOT_SUPPORTED`, `BROWSER_NOT_CONFIGURED`, `LLM_NOT_CONFIGURED`) or, for `lockdown` / `minAge`, a `404`.
- Options that cannot be honoured are refused or reported in `warning`, never dropped.

The package reads no environment variables and no config object: everything it needs is in the context you pass. Log lines go to its [diagnostics channel](#diagnostics). Errors are `AppError`s from the private `sex-errors` library, bundled in: check them with `AppError.isInstance(e)`; `e.status`, `e.code` and `e.retryable` are plain fields.

Time: a call takes an `AbortSignal` and optionally `deadlineAt` (epoch ms). Together with the request's own `timeout` they bound the whole scrape. If the signal aborts with a `TimeoutError` reason the error is `SCRAPE_TIMEOUT`; any other reason is a cancel, `TIMEOUT`. Capabilities receive the same pair (`CallTime`).

## Install

```sh
npm install @searxng-js/sex-scrape
```

## Example

```ts
import { ExtractPool } from "@searxng-js/sex-page";
import { scrapeUrl } from "@searxng-js/sex-scrape";
import pLimit from "p-limit";

const extractPool = new ExtractPool({ size: 2, taskTimeoutMs: 30_000 });
const ctx = {
  settings: { allowPrivateNetwork: false, userAgent: "my-bot/1.0", timeout: 30_000, maxBodyBytes: 10 * 1024 * 1024 },
  scrapeLimit: pLimit(8), // most scrapes at once
  extractPool,
};

const { document } = await scrapeUrl(ctx, "https://example.com/", { formats: ["markdown", "links"] });
console.log(document.markdown);
await extractPool.close();
```

`settings.proxyUrl` sends every fetch through an HTTP proxy; `settings.stealthProxyUrl` is a second proxy that a fetch the site blocked (403, 429, a reset connection) is retried through once.

## Node

Works on Node 24 and Bun. On Node, Markdown to HTML (for PDFs and other converted documents when `html` / `rawHtml` is asked for) needs the optional peer dependency [`marked`](https://www.npmjs.com/package/marked), as in `sex-page`. On Node, outbound requests go through [`undici`](https://www.npmjs.com/package/undici), an optional peer dependency of `sex-egress`: run `npm install undici` (without it a fetch fails with a `NOT_SUPPORTED` error that names the package). Proxies work on both runtimes.

## Diagnostics

The package writes no log output itself. It publishes `{ level, msg, fields? }` on the [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) channel `searxng-js:sex:scrape`, where `level` is `"debug" | "info" | "warn" | "error"`, `msg` a string and `fields` a plain object (absent when there are none). Nothing is built or published while the channel has no subscriber. The channel name and the message shape are part of the package's public interface. Works on Node and Bun.

```ts
import { subscribe } from "node:diagnostics_channel";

subscribe("searxng-js:sex:scrape", ({ level, msg, fields }: any) => console.error(level, msg, fields));
```
