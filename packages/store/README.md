# @searxng-js/sex-store

The page cache and the change tracking store for [`sex-scrape`](../scrape/README.md), on SQLite.

- `SqliteScrapeCache(path, options)` implements `ScrapeCache`: the fetched page (HTTP body, or a browser's rendered HTML) per `(url, variant)`, zstd-compressed, for the `maxAge` / `minAge` / `lockdown` options. Entries expire after `ttlMs`, `maxBytes` evicts the least recently used, a file that is not a database is replaced (it is only a copy).
- `SqliteChangeTracker(path)` implements `ChangeTracker`: the markdown of the latest scrape per `(url, tag)` for the `changeTracking` format, plus the line diff (`git-diff` mode, jsdiff, cut after 5 s). It never expires or evicts a row, and a file that will not open is an error, not recreated, because it is the only copy.
- `markdownDiff(previous, current, timeoutMs)` is that diff on its own.

`sex-scrape` is a peer dependency: install the one copy your code uses. The package reads no environment variables; a `logger` option (`debug` / `info` / `warn` / `error`, `console` fits) is the only place it writes, and without one it is silent.

## Install

```sh
npm install @searxng-js/sex-store @searxng-js/sex-scrape
```

## Example

```ts
import { scrapeUrl } from "@searxng-js/sex-scrape";
import { SqliteChangeTracker, SqliteScrapeCache } from "@searxng-js/sex-store";

const cache = new SqliteScrapeCache("./data/cache.sqlite", { defaultMaxAge: 0, ttlMs: 2 * 24 * 3600_000, maxBytes: 256 * 1024 * 1024 });
const changeTracker = new SqliteChangeTracker("./data/change-tracking.sqlite");
const ctx = { /* settings, scrapeLimit, extractPool, ... */ cache, changeTracker };

await scrapeUrl(ctx, "https://example.com/", { maxAge: 60_000, formats: ["markdown", { type: "changeTracking", modes: ["git-diff"] }] });
cache.close();
changeTracker.close();
```

## Node

Works on Node 24 and Bun: the stores use `node:sqlite` and the zstd functions of `node:zlib`, which both have. The files are the same ones the earlier Bun-only version wrote (`user_version` 1, zstd bodies), so an existing `cache.sqlite` / `change-tracking.sqlite` opens as it is. On Bun, `node:sqlite` with prepared statements kept per connection measured about the same as `bun:sqlite` (about 50 µs per `put` or `get` of a 9 KB page, compression included).
