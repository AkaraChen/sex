# @searxng-js/searchkit

Normalized multi-provider web search: one `SearchProvider` contract, thirteen adapters, and a
`createSearch` orchestrator that is a ~100-line loop — explicit fallback and two time budgets,
nothing else. Zero runtime dependencies, no build step, `sideEffects: false` so a bundle keeps
only the adapters it imports.

A fork of [Belweave/searchSDK](https://github.com/Belweave/searchSDK) (MIT), copied at rev `05f9324`
and ours to change since; `NOTICE` keeps the attribution, the forked-from revision, and a log of
what we changed. Upstream's cache, deduplication, batch and in-provider retry were dropped — the
sex chain owns fallback, and YAGNI applies. Upstream is a reference, not a master.

```ts
import { createSearch, tavily, brave } from "@searxng-js/searchkit";

const search = createSearch({
  provider: tavily({ apiKey: process.env.TAVILY_API_KEY! }),
  fallback: [brave({ apiKey: process.env.BRAVE_API_KEY! })],
});
const response = await search.web.search({ query: "SQLite write concurrency", limit: 5 });
// response.results: { url, title?, snippet?, provenance }[]  ·  response.provider  ·  response.attempts
```

The contract is deliberately smaller than any provider's: `query`, `limit` (1–20),
`includeDomains`, `excludeDomains`. Each adapter declares what it can honour (`capabilities`),
and a request no configured provider can serve is refused before anything dispatches. Only
transient failures (network, unavailable, rate limit, attempt timeout) move a search to a
fallback provider; auth failures, invalid responses and empty results do not.

sex consumes this package through `@searxng-js/sex-search`, which translates the Firecrawl v2
search shape into it and back — `ProviderBackend.search` is refuse, call, transform, in that
order. Nothing else in the repository imports searchkit directly.
