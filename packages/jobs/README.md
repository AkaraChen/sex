# @searxng-js/sex-jobs

Long-running scrape work behind Firecrawl v2's job endpoints: **crawl**, **batch scrape** and **extract**, with a SQLite job store, webhooks, and the scraped documents kept in JSONL files, S3 or memory.

- `startCrawl(ctx, request)` / `startBatchScrape(ctx, request)` / `startExtract(ctx, request)` create a job and queue its first task; `runTask` (through `startWorker(ctx)`) runs the tasks. A crawl discovers pages from the start URL, the sitemaps ([`sex-map`](../map/README.md)) and each page's links, within `limit`, depth, path filters, robots.txt and `delay` / `maxConcurrency`. An extract maps `/*` URLs, optionally searches the web, scrapes the pages and has an LLM answer a prompt or JSON Schema from them (Single-Answer and Multi-Entity, merged in code).
- Jobs are crash-safe: every side effect of a task (its document, its failure, its settlement, a webhook) is claimed once per `(job, taskId, effect)`, so a queue that delivers a task twice stores, counts and notifies once. Webhooks (`started`, `page`, `completed`, `failed`) are tasks too, retried with backoff, and signed with `X-Firecrawl-Signature: sha256=<hmac>` when `webhookSecret` is set.
- Parts, each behind a small interface you can replace: `JobStore` (`SqliteJobStore`, on `node:sqlite`), `TaskQueue` (`MemoryTaskQueue` here; the Bun app uses bunqueue for tasks that survive a restart), `DocumentLog` (`FsDocumentLog`, `S3DocumentLog`, `MemoryDocumentLog`; `createDocumentLog` picks one from a `file://` or `s3://` URL), and `JobScheduler`, which decides order and pace (lanes served in turn, per-job caps and cooldowns, a shared webhook lane).
- The request and response shapes (`CrawlRequest`, `BatchScrapeRequest`, `ExtractRequest`, `WebhookConfig`, the status responses, `ParseRequest`) are zod schemas and types.

The context (`JobsContext`) is a [`sex-map`](../map/README.md) context (a `sex-scrape` context plus SearXNG) with `jobs` (store, queue and scheduler: `createJobBackend({ store, queue })`), `jobSettings` (`concurrency`, `extractWildcardPages`, `webhookSecret`), a `search` function and, for extract and crawl `prompt`s, an `llm`. [`sex-llm`](../llm/README.md)'s `Llm` is one; anything with the same methods works. The package reads no environment variables. Log lines go to its [diagnostics channel](#diagnostics).

## Install

```sh
npm install @searxng-js/sex-jobs @searxng-js/sex-scrape @searxng-js/sex-map
```

On Node, documents on S3 also need the optional peer dependency `@aws-sdk/client-s3` (`npm install @aws-sdk/client-s3`); without it an `s3://` document location fails with an error that says so. On Bun the built-in `Bun.S3Client` is used.

## Example

```ts
import {
  createDocumentLog,
  createJobBackend,
  MemoryTaskQueue,
  SqliteJobStore,
  startBatchScrape,
  startWorker,
} from "@searxng-js/sex-jobs";

const store = new SqliteJobStore("./data/jobs.sqlite", 24 * 3600_000, createDocumentLog({ dataDir: "./data" }));
const jobs = createJobBackend({ store, queue: new MemoryTaskQueue({ concurrency: 4 }) });
const ctx = { /* the sex-scrape context: settings, scrapeLimit, extractPool, ... */ jobs, jobSettings: { concurrency: 4, extractWildcardPages: 10 } /* ... */ };

startWorker(ctx);
const { job } = await startBatchScrape(ctx, { urls: ["https://example.com/a", "https://example.com/b"] });
// Poll `await jobs.store.get(job.id)` until its status leaves "scraping", then read `await jobs.store.documents(job.id, 0, 10_000_000)`.
```

## Node
 On Node, outbound requests go through [`undici`](https://www.npmjs.com/package/undici), an optional peer dependency of `sex-egress`: run `npm install undici` (without it a fetch fails with a `NOT_SUPPORTED` error that names the package).
Works on Node 24 and Bun. The job store uses `node:sqlite`; on Bun it measured within noise of `bun:sqlite` on the hot path (per operation: scheduling a crawled URL 22–25 µs against 19–22, storing a document 71–79 µs against 68–70, settling a task 49–55 µs against 49–52). A `jobs.sqlite` written by the earlier `bun:sqlite` version opens as it is. `MemoryTaskQueue` keeps tasks in memory only: they are gone when the process ends. Tasks that must survive a restart need a persistent `TaskQueue` of your own; the sex app's is bunqueue (Bun only), in `apps/sex`.

## Diagnostics

The package writes no log output itself. It publishes `{ level, msg, fields? }` on the [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) channel `searxng-js:sex:jobs`, where `level` is `"debug" | "info" | "warn" | "error"`, `msg` a string and `fields` a plain object (absent when there are none). Nothing is built or published while the channel has no subscriber. The channel name and the message shape are part of the package's public interface. Works on Node and Bun.

```ts
import { subscribe } from "node:diagnostics_channel";

subscribe("searxng-js:sex:jobs", ({ level, msg, fields }: any) => console.error(level, msg, fields));
```
