# @searxng-js/sex-search

Web search through [SearXNG](https://github.com/searxng/searxng): Firecrawl v2's `search`, optionally scraping the results.

- `search(ctx, request, signal?)` queries SearXNG (web, news and images; categories, `includeDomains` / `excludeDomains`, `site:` / `inurl:` / `intitle:` operators enforced on the results, a time filter), retries a 5xx once, and returns Firecrawl-shaped `{ data, warning? }`. With `scrapeOptions.formats` every web and news result is scraped with [`sex-scrape`](../scrape/README.md) in the time the search has left.
- `SearchRequest`, `SearchData` and the other request / response shapes are exported as zod schemas and types.
- Parameters SearXNG cannot honour (`country`, `location`, odd `tbs`) are named in `warning`, not dropped silently.

The context is a `SearchContext`: a `sex-scrape` context plus `searxng` (anything with `url(): Promise<string>`, such as a [`SearxngService`](../searxng/README.md), or `{ url: async () => "http://localhost:8080" }`) and `searchDomainLimit` (a p-limit that caps the per-domain queries of `includeDomains` across searches). The package reads no environment variables and logs nothing unless the context has a `logger`.

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

## Node

Works on Node 24 and Bun. Hosting the SearXNG process itself is `sex-searxng`; on Node, Markdown for scraped results follows the notes of `sex-scrape`.
