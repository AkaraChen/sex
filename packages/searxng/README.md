# @searxng-js/sex-searxng

The SearXNG a search runs against: an external instance, or one this package runs as a child process (the prebuilt binary of [`@searxng-js/searxng`](https://www.npmjs.com/package/@searxng-js/searxng)).

`SearxngService` starts the child on first use (or `warmup()`), starts it again after it exits, pauses restarts for a cooldown after repeated failed starts (`SEARCH_BACKEND_UNAVAILABLE`), and stops it on `close()`. The child exits when its stdin pipe closes, so it dies with its parent even on SIGKILL. With a `proxyUrl` and no `settingsPath` it writes settings with `outgoing.proxies` to a private temporary file (mode `0600`) that is deleted once SearXNG is up; proxy credentials are redacted from logs and errors.

Errors are `AppError`s from the private `sex-errors` library, bundled in. The package logs nothing unless you pass `logger` (`debug` / `info` / `warn` / `error`, `console` fits).

## Install

```sh
npm install @searxng-js/sex-searxng
```

## Example

```ts
import { SearxngService } from "@searxng-js/sex-searxng";

const searxng = new SearxngService({ proxyUrl: "http://user:pass@proxy.example:3128" }); // or { url: "http://searxng:8080" }
const base = await searxng.url(); // starts the child process
const res = await fetch(`${base}/search?q=bun&format=json`);
await searxng.close();
```

Options: `url` (external instance; nothing is started), `binaryPath`, `settingsPath` (your own settings.yml, used as it is), `proxyUrl`, `logger`.

## Node

Works on Node 24 and Bun. Generating the proxy settings parses and writes YAML: Bun uses `Bun.YAML`; on Node install the optional peer dependency [`yaml`](https://www.npmjs.com/package/yaml) (`npm install yaml`), otherwise that one step throws a `NOT_SUPPORTED` error that says so. Without `proxyUrl` nothing needs it. The prebuilt binary exists for linux-x64 (glibc 2.35+), darwin-arm64 and win32-x64; elsewhere pass `url` or `binaryPath`.
