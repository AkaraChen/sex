# @searxng-js/sex-docs

PDF, Office document and image conversion for [`sex-scrape`](../scrape/README.md), through [here-docs](https://github.com/AkaraChen/here-docs): structured text where the file has it, local OCR where it does not.

- `new DocsConverter({ enabled, concurrency, logger? })` implements `ScrapeDocs`. Pass it as `docs` in the scrape context; with `enabled: false` the scrape falls back to unpdf for PDFs and refuses other files with `415`.
- The engine (native addons plus an OCR model, about 200 MB) starts on first use or on `warmup()` and is shared by every conversion in the process. `concurrency` bounds simultaneous conversions (light-ocr has one recognition thread per engine); waiting for a slot counts against the call's time.
- Time: `convert(bytes, { signal, deadlineAt, maxPages, filename })`. The conversion gets 90% of what is left; if that runs out after some pages, those pages are returned with a `timeout` warning, with none it is `SCRAPE_TIMEOUT`. Cancelling is `TIMEOUT`.
- `registerEmbeddedDocs(digest, files)` is for a Bun single-file executable that embeds here-docs and its native engines (see `apps/sex/scripts/build.ts`): the files are extracted once to `$XDG_CACHE_HOME/sex/docs-<digest>` and loaded from there.

The package reads no environment variables; the `logger` option (`debug` / `info` / `warn` / `error`, `console` fits) is the only place it writes. Errors are `AppError`s from the private `sex-errors` library, bundled in.

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

here-docs declares Node 22+ and ships a `dist/`, so it should run on Node, but this repository only exercises it on Bun: it is installed from git (`github:AkaraChen/here-docs`), and a git install under Bun has TypeScript source and no `dist/`, so the `import("here-docs")` of this package's own tests on Node is not run against the real engines. The Node tests here use a stand-in for here-docs. If `here-docs` cannot be loaded the converter fails with `DOCS_UNAVAILABLE` and says why; nothing is worked around.
