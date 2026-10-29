# @searxng-js/sex-browser

Renders pages for [`sex-scrape`](../scrape/README.md) in a browser: a [Lightpanda](https://lightpanda.io) child process, or any browser you point it at over CDP (Chrome), with the outbound rules enforced for each.

- `new BrowserPool(options)` implements `ScrapeBrowser`. `options`: `concurrency`, `allowPrivateNetwork`, `proxyUrl`, `lightpanda` (+ `lightpandaPath`), `cdpUrl`, `blockMedia`. Each page gets its own browser context, closed when the page's time (`signal` + `deadlineAt`) ends. `warmup()` starts the browser early; `close()` stops the child and the proxy.
- Lightpanda is spawned lazily, spawned again after it exits, not respawned for a cooldown after repeated failed starts (`BROWSER_UNAVAILABLE`), and on Linux with `setpriv` it dies with its parent even on SIGKILL. The binary is the explicit `lightpandaPath`, else one embedded by `registerEmbeddedLightpanda` (a Bun single-file executable), else `PATH`.
- Where the SSRF rules are enforced depends on the browser (`planEgress`): Lightpanda's own `--block-private-networks`; for Chrome on this machine an `EgressProxy` (a forward proxy on a loopback port that resolves every name through `sex-egress`'s `EgressPolicy` and connects to the validated address); for Chrome elsewhere a CDP request guard. `EgressProxy` also blocks ad hosts and chains to `proxyUrl`.
- `blockAds`: EasyList / EasyPrivacy domains (`AdBlockList.parse(table)`: one `domain`, `~domain` for third-party only, or `@domain` for an exception per line). The package does not ship the list (GPLv3 / CC BY-SA 3.0): from a source checkout it is derived by `scripts/adblock.ts` from a pinned easylist commit; in an application pass your own `adBlockList: async () => AdBlockList.parse(text)`, or call `registerEmbeddedAdblock` with a zstd file. Without a list `blockAds` has no effect.
- `applyRequestPolicies(page, ...)` and the policies it is made of (`PrivateNetworkPolicy`, `AdBlockPolicy`, `MediaBlockPolicy`, `OriginScopedCredentialsPolicy`) are exported for code that drives a puppeteer page itself.

The package reads no environment variables; log lines go to its [diagnostics channel](#diagnostics). Errors are `AppError`s from the private `sex-errors` library, bundled in. `puppeteer-core` is a dependency; Defuddle's browser bundle is inlined into `dist/index.js` as a string, so `defuddle` is not needed at runtime.

## Install

```sh
npm install @searxng-js/sex-browser @searxng-js/sex-scrape
```

## Example

```ts
import { BrowserPool } from "@searxng-js/sex-browser";

const browser = new BrowserPool({
  concurrency: 4,
  allowPrivateNetwork: false,
  blockMedia: false,
  lightpanda: true,
  lightpandaPath: "/usr/local/bin/lightpanda", // or cdpUrl: "http://127.0.0.1:9222"
});
const ctx = { /* settings, scrapeLimit, extractPool, ... */ browser };
// scrapeUrl(ctx, url, { waitFor: 1000, formats: ["markdown"] }) now renders the page first
await browser.close();
```

## Node
 On Node, outbound requests go through [`undici`](https://www.npmjs.com/package/undici), an optional peer dependency of `sex-egress`: run `npm install undici` (without it a fetch fails with a `NOT_SUPPORTED` error that names the package).
Works on Node 24 and Bun: the child process is `node:child_process` (with the same `setpriv --pdeathsig` wrapper on Linux), the executable lookup is a `PATH` walk, and the embedded Lightpanda is decompressed with `node:zlib`. Scripts for maintainers (`scripts/lightpanda.ts`, `scripts/adblock.ts`, `scripts/bench-*.ts`) run on Bun from a checkout and are not part of the published package.

## Diagnostics

The package writes no log output itself. It publishes `{ level, msg, fields? }` on the [`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html) channel `searxng-js:sex:browser`, where `level` is `"debug" | "info" | "warn" | "error"`, `msg` a string and `fields` a plain object (absent when there are none). Nothing is built or published while the channel has no subscriber. The channel name and the message shape are part of the package's public interface. Works on Node and Bun.

```ts
import { subscribe } from "node:diagnostics_channel";

subscribe("searxng-js:sex:browser", ({ level, msg, fields }: any) => console.error(level, msg, fields));
```
