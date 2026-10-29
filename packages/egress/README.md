# @searxng-js/sex-egress

SSRF-safe outbound requests for servers that fetch URLs a user supplied.

- `EgressPolicy`: resolves a host and refuses it when any address is not a globally routable unicast address (loopback, private, link-local including cloud metadata `169.254.169.254`, ULA, IPv4-in-IPv6 forms). Answers are cached for 30 s.
- `safeFetch`: `fetch` that applies the policy to every redirect hop and connects to the address that was validated, so a second DNS lookup (rebinding) cannot send the request elsewhere. It also caps the body size and names failures (`SCRAPE_DNS_RESOLUTION_ERROR`, `SCRAPE_SSL_ERROR`, ...).
- `assertPublicUrl`, `parseHttpUrl`, `networkError`, `decodeBody`, `rewriteUrl` (Google Docs / Sheets / Slides / Drive links to export URLs) and `fileKindOf`.

Errors are `AppError`s from the private `sex-errors` library, bundled in; they carry `code`, `status` and `retryable`.

## Install

```sh
npm install @searxng-js/sex-egress
```

## Example

```ts
import { safeFetch } from "@searxng-js/sex-egress";

const res = await safeFetch("https://example.com/", {
  signal: AbortSignal.timeout(10_000), // SCRAPE_TIMEOUT when it times out, TIMEOUT when you abort it
  allowPrivateNetwork: false,
  proxy: undefined, // required, so a call site decides; Bun only
  userAgent: "my-bot/1.0",
});
console.log(res.status, res.contentType, res.body.byteLength);
```

A URL that points at a private address rejects with `code: "PRIVATE_NETWORK_BLOCKED"` before any connection is made.

## Node

Works on Node 24 and Bun. On Node:

- Requests to a validated address go through `node:http(s)` (Node's `fetch` cannot set the TLS server name), with the original host in `Host` and SNI.
- The `proxy` option is Bun only. Passing one on Node throws instead of connecting directly.
