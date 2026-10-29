# @searxng-js/sex-llm

The LLM side of [`sex-scrape`](../scrape/README.md), on any OpenAI-compatible `/chat/completions` endpoint ([xsai](https://github.com/moeru-ai/xsai)).

- `new Llm({ endpoint, maxInputChars, timeoutMs })` implements `ScrapeLlm`: the `json` format (validated against your JSON Schema, one correction turn for a reply that fails it), `summary`, question answering, `highlights` / direct quotes (the model picks line numbers, the text is copied from the page), change tracking's `json` mode, and Firecrawl's prompt injection guard (`SCRAPE_PROMPT_INJECTION_DETECTED`). Without an `endpoint` it is not `enabled` and every call is a `501`.
- `endpoint.smallModel` (same endpoint and key) serves the auxiliary calls (`planExtract`, `generateSchema`, `crawlOptions`, `selectLinks`); the guard, extraction and the formats stay on the main model.
- Page content goes inside tags in the prompts, escaped, and every system prompt that sees it ends with an untrusted-content notice. `escapeTags`, `splitSegments`, `compileJsonSchema` and `describeSchemaErrors` are exported for code that builds on the same pieces (the extract flow of `apps/sex` does).
- Time: every call takes `{ signal, deadlineAt }`. A call gets `min(timeoutMs, what is left)`, rate limits (429, or 503 with `retry-after`) are waited out only if the wait fits, and a call cut by the caller's time is `SCRAPE_TIMEOUT` where its own `timeoutMs` is `TIMEOUT`. Token usage of the calls inside `llm.metered(meter, fn)` is added to the `TokenMeter`.

The package reads no environment variables; log lines (retries, guard failures, debug lines) go to its [diagnostics channel](#diagnostics). Errors are `AppError`s, which this package exports (`import { AppError } from "@searxng-js/sex-llm"`; every `@searxng-js/sex-*` package exports the same class; check them with `AppError.isInstance(e)`, never `instanceof`): an endpoint's 4xx is `LLM_REQUEST_REJECTED` (500), a 5xx `LLM_ERROR`, an unreachable endpoint `LLM_UNAVAILABLE`.

## Install

```sh
npm install @searxng-js/sex-llm @searxng-js/sex-scrape
```

## Example

```ts
import { Llm } from "@searxng-js/sex-llm";

const llm = new Llm({
  endpoint: { baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY, model: "gpt-5-mini" },
  maxInputChars: 200_000,
  timeoutMs: 120_000,
});
const ctx = { /* settings, scrapeLimit, extractPool, ... */ llm };
// scrapeUrl(ctx, url, { formats: [{ type: "json", schema }], checkPromptInjection: true })
```

## Node

Works on Node 24 and Bun; it uses no Bun API.

## Diagnostics

The package writes no log output itself. It publishes `{ level, msg, fields? }` on the [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) channel `searxng-js:sex:llm`, where `level` is `"debug" | "info" | "warn" | "error"`, `msg` a string and `fields` a plain object (absent when there are none). Nothing is built or published while the channel has no subscriber. The channel name and the message shape are part of the package's public interface. Works on Node and Bun.

```ts
import { subscribe } from "node:diagnostics_channel";

subscribe("searxng-js:sex:llm", ({ level, msg, fields }: any) => console.error(level, msg, fields));
```
