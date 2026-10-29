# @searxng-js/sex-search

Web search through [SearXNG](https://github.com/searxng/searxng): Firecrawl v2's `search`, optionally scraping the results.

- `search(ctx, request, signal?)` queries SearXNG (web, news and images; categories, `includeDomains` / `excludeDomains`, `site:` / `inurl:` / `intitle:` operators enforced on the results, a time filter), retries a 5xx once, and returns Firecrawl-shaped `{ data, warning? }`. With `scrapeOptions.formats` every web and news result is scraped with [`sex-scrape`](../scrape/README.md) in the time the search has left.
- `SearchRequest`, `SearchData` and the other request / response shapes are exported as zod schemas and types.
- Parameters SearXNG cannot honour (`country`, `location`, odd `tbs`) are named in `warning`, not dropped silently.

The context is a `SearchContext`: a `sex-scrape` context plus `searxng` (anything with `url(): Promise<string>`, such as a [`SearxngService`](../searxng/README.md), or `{ url: async () => "http://localhost:8080" }`) and `searchDomainLimit` (a p-limit that caps the per-domain queries of `includeDomains` across searches). The package reads no environment variables. Log lines go to its [diagnostics channel](#diagnostics).

Time: `signal` is the caller's cancellation, and the search merges its own timeout (`request.timeout`, default `max(2 * settings.timeout, 60 s)`) into it. Cancelling or running out of time is `TIMEOUT`.

## Install

```sh
npm install @searxng-js/sex-search
```

## Example

```ts
import { ExtractPool } from "@searxng-js/sex-page";
import { search } from "@searxng-js/sex-search";
import pLimit from "p-limit";

const extractPool = new ExtractPool({ size: 2, taskTimeoutMs: 30_000 });
const ctx = {
  settings: { allowPrivateNetwork: false, userAgent: "my-bot/1.0", timeout: 30_000, maxBodyBytes: 10 * 1024 * 1024 },
  scrapeLimit: pLimit(8),
  searchDomainLimit: pLimit(4),
  extractPool,
  searxng: { url: async () => "http://localhost:8080" },
};

const { data } = await search(ctx, { query: "defuddle", limit: 5 });
console.log(data.web?.map((r) => r.url));
await extractPool.close();
```

## Errors

Failures are `AppError`s, which this package exports (`import { AppError } from "@searxng-js/sex-search"`; every `@searxng-js/sex-*` package exports the same class, so one recognises another's): check them with `AppError.isInstance(e)`, never `instanceof`. `e.code` (for example `TIMEOUT`, `PRIVATE_NETWORK_BLOCKED`, `SEARCH_BACKEND_UNAVAILABLE`), `e.status` (the HTTP status a server would answer with) and `e.retryable` are plain fields.

## Node
Works on Node 24 and Bun. On Node, outbound requests go through [`undici`](https://www.npmjs.com/package/undici), an optional peer dependency of `sex-egress`: run `npm install undici` (without it a fetch fails with a `NOT_SUPPORTED` error that names the package). Hosting the SearXNG process itself is `sex-searxng`; on Node, Markdown for scraped results follows the notes of `sex-scrape`.

## Diagnostics

The package writes no log output itself. It publishes `{ level, msg, fields? }` on the [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) channel `searxng-js:sex:search`, where `level` is `"debug" | "info" | "warn" | "error"`, `msg` a string and `fields` a plain object (absent when there are none). Nothing is built or published while the channel has no subscriber. The channel name and the message shape are part of the package's public interface. Works on Node and Bun.

```ts
import { subscribe } from "node:diagnostics_channel";

subscribe("searxng-js:sex:search", ({ level, msg, fields }: any) => console.error(level, msg, fields));
```
