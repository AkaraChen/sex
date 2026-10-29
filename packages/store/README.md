# @searxng-js/sex-store

The page cache and the change tracking store for [`sex-scrape`](../scrape/README.md), on SQLite.

- `SqliteScrapeCache(path, options)` implements `ScrapeCache`: the fetched page (HTTP body, or a browser's rendered HTML) per `(url, variant)`, zstd-compressed, for the `maxAge` / `minAge` / `lockdown` options. Entries expire after `ttlMs`, `maxBytes` evicts the least recently used, a file that is not a database is replaced (it is only a copy).
- `SqliteChangeTracker(path)` implements `ChangeTracker`: the markdown of the latest scrape per `(url, tag)` for the `changeTracking` format, plus the line diff (`git-diff` mode, jsdiff, cut after 5 s). It never expires or evicts a row, and a file that will not open is an error, not recreated, because it is the only copy.
- `markdownDiff(previous, current, timeoutMs)` is that diff on its own.

`sex-scrape` is a peer dependency: install the one copy your code uses. The package reads no environment variables; log lines go to its [diagnostics channel](#diagnostics).

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

## Errors

Failures are `AppError`s, which this package exports (`import { AppError } from "@searxng-js/sex-store"`; every `@searxng-js/sex-*` package exports the same class, so one recognises another's): check them with `AppError.isInstance(e)`, never `instanceof`. `e.code` (for example `TIMEOUT`, `PRIVATE_NETWORK_BLOCKED`, `SEARCH_BACKEND_UNAVAILABLE`), `e.status` (the HTTP status a server would answer with) and `e.retryable` are plain fields.

## Node

Works on Node 24 and Bun: the stores use `node:sqlite` and the zstd functions of `node:zlib`, which both have. The files are the same ones the earlier Bun-only version wrote (`user_version` 1, zstd bodies), so an existing `cache.sqlite` / `change-tracking.sqlite` opens as it is. On Bun, `node:sqlite` with prepared statements kept per connection measured about the same as `bun:sqlite` (about 50 µs per `put` or `get` of a 9 KB page, compression included).

## Diagnostics

The package writes no log output itself. It publishes `{ level, msg, fields? }` on the [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) channel `searxng-js:sex:store`, where `level` is `"debug" | "info" | "warn" | "error"`, `msg` a string and `fields` a plain object (absent when there are none). Nothing is built or published while the channel has no subscriber. The channel name and the message shape are part of the package's public interface. Works on Node and Bun.

```ts
import { subscribe } from "node:diagnostics_channel";

subscribe("searxng-js:sex:store", ({ level, msg, fields }: any) => console.error(level, msg, fields));
```
