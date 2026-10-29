# @searxng-js/sex-docs

PDF, Office document and image conversion for [`sex-scrape`](../scrape/README.md), through [here-docs](https://github.com/AkaraChen/here-docs): structured text where the file has it, local OCR where it does not.

- `new DocsConverter({ enabled, concurrency })` implements `ScrapeDocs`. Pass it as `docs` in the scrape context; with `enabled: false` the scrape falls back to unpdf for PDFs and refuses other files with `415`.
- The engine (native addons plus an OCR model, about 200 MB) starts on first use or on `warmup()` and is shared by every conversion in the process. `concurrency` bounds simultaneous conversions (light-ocr has one recognition thread per engine); waiting for a slot counts against the call's time.
- Time: `convert(bytes, { signal, deadlineAt, maxPages, filename })`. The conversion gets 90% of what is left; if that runs out after some pages, those pages are returned with a `timeout` warning, with none it is `SCRAPE_TIMEOUT`. Cancelling is `TIMEOUT`.
- `registerEmbeddedDocs(digest, files)` is for a Bun single-file executable that embeds here-docs and its native engines (see `apps/sex/scripts/build.ts`): the files are extracted once to `$XDG_CACHE_HOME/sex/docs-<digest>` and loaded from there.

The package reads no environment variables; log lines go to its [diagnostics channel](#diagnostics). Errors are `AppError`s, which this package exports (`import { AppError } from "@searxng-js/sex-docs"`; every `@searxng-js/sex-*` package exports the same class): check them with `AppError.isInstance(e)`, never `instanceof`; `e.code`, `e.status` and `e.retryable` are plain fields.

## Install

```sh
npm install @searxng-js/sex-docs @searxng-js/sex-scrape
```

## Example

```ts
import { DocsConverter } from "@searxng-js/sex-docs";

const docs = new DocsConverter({ enabled: true, concurrency: 2 });
await docs.warmup(); // optional: a broken install fails here instead of on the first document
const ctx = { /* settings, scrapeLimit, extractPool, ... */ docs };
// scrapeUrl(ctx, "https://example.com/report.docx") now converts the file; parsers: [{ type: "pdf", maxPages: 5 }] stops early.
await docs.close();
```

## Node

here-docs (on npm, MIT) runs on Node 22+ and on Bun: its own CI converts files with the real engines on Linux (glibc and musl), macOS and Windows under Node 22 and 24, and under Bun. This package's Node tests use a stand-in for here-docs; the repository's `e2e/packages` suite starts the real engine from the published tarballs on Node and Bun. If `here-docs` cannot be loaded (an unsupported host, optional platform packages omitted) the converter fails with `DOCS_UNAVAILABLE` and says why; nothing is worked around.

## Diagnostics

The package writes no log output itself. It publishes `{ level, msg, fields? }` on the [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) channel `searxng-js:sex:docs`, where `level` is `"debug" | "info" | "warn" | "error"`, `msg` a string and `fields` a plain object (absent when there are none). Nothing is built or published while the channel has no subscriber. The channel name and the message shape are part of the package's public interface. Works on Node and Bun.

```ts
import { subscribe } from "node:diagnostics_channel";

subscribe("searxng-js:sex:docs", ({ level, msg, fields }: any) => console.error(level, msg, fields));
```
