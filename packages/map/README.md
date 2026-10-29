# @searxng-js/sex-map

Find the URLs of a site: Firecrawl v2's `map`.

- `mapSite(ctx, request, signal?)` collects URLs from the robots.txt and `/sitemap.xml` sitemaps (indexes and gzip included), the links of the start page (scraped with [`sex-scrape`](../scrape/README.md)) and a SearXNG `site:` search, keeps the ones in scope (same site, `includeSubdomains`, `filterByPath`, `includePaths` / `excludePaths`), and with `search` ranks them by relevance to the term. The start URL is resolved through redirects first; every fetch goes through [`sex-egress`](../egress/README.md), so private addresses are refused unless the context allows them.
- `MapRequest`, `MapResult` and `MapLink` are exported as zod schemas and types.
- The pieces the crawl of [`sex-jobs`](../jobs/README.md) shares are exported too: `sitemapUrls`, `fetchRobots` / `parseRobots` (RFC 9309: longest match wins, a 5xx robots.txt disallows everything), `normalizeUrl`, and the include / exclude regex helpers (`compilePatterns` refuses patterns that risk catastrophic backtracking; `isSkippableFile` tells pages from archives and media).

The context is a `SearchContext` from [`sex-search`](../search/README.md), which is a `sex-scrape` context plus a SearXNG. Pass `sitemap: "only"` or `"skip"` to skip the search and the page, and the sex-only `{ skipSearch: true }` to leave out just the SearXNG query. The package reads no environment variables and logs nothing unless the context has a `logger`.

Time: `request.timeout` (default 60 s) is the whole map; `signal` is the caller's cancellation. Both end the map with `TIMEOUT`.

## Install

```sh
npm install @searxng-js/sex-map @searxng-js/sex-search @searxng-js/sex-scrape
```

## Example

```ts
import { ExtractPool } from "@searxng-js/sex-page";
import { mapSite } from "@searxng-js/sex-map";
import pLimit from "p-limit";

const extractPool = new ExtractPool({ size: 2, taskTimeoutMs: 30_000 });
const ctx = {
  settings: { allowPrivateNetwork: false, userAgent: "my-bot/1.0", timeout: 30_000, maxBodyBytes: 10 * 1024 * 1024 },
  scrapeLimit: pLimit(8),
  searchDomainLimit: pLimit(4),
  extractPool,
  searxng: { url: async () => "http://localhost:8080" },
};

const { links } = await mapSite(ctx, { url: "https://example.com/docs", limit: 100, sitemap: "include" });
console.log(links.map((l) => l.url));
await extractPool.close();
```

## Node
 On Node, outbound requests go through [`undici`](https://www.npmjs.com/package/undici), an optional peer dependency of `sex-egress`: run `npm install undici` (without it a fetch fails with a `NOT_SUPPORTED` error that names the package).
Works on Node 24 and Bun. On Node, Markdown for the scraped start page follows the notes of `sex-scrape`.
