# @searxng-js/sex-egress

SSRF-safe outbound requests for servers that fetch URLs a user supplied.

- `EgressPolicy`: resolves a host and refuses it when any address is not a globally routable unicast address (loopback, private, link-local including cloud metadata `169.254.169.254`, ULA, IPv4-in-IPv6 forms). Answers are cached for 30 s.
- `safeFetch`: `fetch` that applies the policy to every redirect hop and connects to the address that was validated, so a second DNS lookup (rebinding) cannot send the request elsewhere. It also caps the body size and names failures (`SCRAPE_DNS_RESOLUTION_ERROR`, `SCRAPE_SSL_ERROR`, ...).
- `assertPublicUrl`, `parseHttpUrl`, `networkError`, `decodeBody`, `rewriteUrl` (Google Docs / Sheets / Slides / Drive links to export URLs) and `fileKindOf`.

Errors are `AppError`s, which this package exports (`import { AppError } from "@searxng-js/sex-egress"`; every `@searxng-js/sex-*` package exports the same class): check them with `AppError.isInstance(e)`, never `instanceof`; `e.code`, `e.status` and `e.retryable` are plain fields.

## Install

```sh
npm install @searxng-js/sex-egress
npm install undici # Node only, optional peer
```

## Example

```ts
import { safeFetch } from "@searxng-js/sex-egress";

const res = await safeFetch("https://example.com/", {
  signal: AbortSignal.timeout(10_000), // SCRAPE_TIMEOUT when it times out, TIMEOUT when you abort it
  allowPrivateNetwork: false,
  proxy: undefined, // required, so a call site decides
  userAgent: "my-bot/1.0",
});
console.log(res.status, res.contentType, res.body.byteLength);
```

A URL that points at a private address rejects with `code: "PRIVATE_NETWORK_BLOCKED"` before any connection is made.

## Private networks

`allowPrivateNetwork` takes three forms:

- `false`: only public addresses.
- `true`: no checks at all, and no pinning (tests, a tool run against `localhost`).
- an allowlist, which opens exactly what it names and keeps every check and the pinning:

```ts
const intranet = { allow: ["192.168.1.0/24", "fd12:3456::/32", "10.0.0.5:8080", "docs.corp.internal", "*.lab.internal"], loopback: false };
await safeFetch("http://docs.corp.internal/handbook", { ...opts, allowPrivateNetwork: intranet });
```

After the host is resolved, every address must be public, or be opened by the list; otherwise the request is refused:

- a network entry (CIDR, IPv4 or IPv6, or one address) opens the private addresses inside it; IPv4 embedded in IPv6 (mapped, NAT64, 6to4) is judged as IPv4;
- a host-name entry (`*.name` for the names under it) opens the private addresses that name resolves to;
- `:port` (`[v6]:port` for IPv6) limits an entry to that port; without it every port is open. A URL without a port is on 80 / 443;
- loopback (`127.0.0.0/8`, `::1`, the unspecified address, `localhost`) only with `loopback: true`, never through an entry;
- link-local (`169.254.0.0/16`, `fe80::/10`) and the metadata addresses in `NEVER_ALLOWED` (`fd00:ec2::254`, `100.100.100.200`, `168.63.129.16`) are refused whatever the list says. `NEVER_ALLOWED` is refused with `allowPrivateNetwork: false` as well.

An allowed address is pinned like a public one, and every redirect hop is checked again, so a redirect or a second DNS answer outside the list is refused. The error's `details` are `{ host, address?, reason }`, `reason` being `private`, `loopback` or `never`.

`parsePrivateNetworkAllowlist(list)` returns the rules and the entries it could not use (`errors`, each with a message); those are left out and the rest apply. `parseAllowEntry(entry)` checks one entry, for a settings form. `egressFor(list)` keeps one policy, and its address cache, per list object: pass the same object while the list is unchanged.

With a `proxy` the proxy connects, so an allowed request is not pinned (as for public addresses): the proxy must be able to reach the address, and rebinding between this check and its own lookup is for the proxy to stop.

## Node

Works on Node 24 and Bun. On Node:

- Requests go through [`undici`](https://www.npmjs.com/package/undici), an optional peer dependency: run `npm install undici`. Without it a request fails with a `NOT_SUPPORTED` error that names the package. (Bun uses its own `fetch` and needs nothing.)
- A request to a validated address keeps its URL, so `Host`, SNI and the certificate check use the real host name; the dispatcher's `connect.lookup` answers with the validated address.
- The `proxy` option goes through undici's `ProxyAgent` with the Bun semantics: the request is not pinned, the host is still resolved and checked first (a name that does not resolve locally is refused), a caller-set `Proxy-Authorization` / `Proxy-Connection` is dropped and the credentials in the proxy URL are used.
- Each request has its own dispatcher, closed when the response body is read to the end, cancelled, fails or the signal aborts, so nothing keeps a process alive.

## Diagnostics

The package publishes no log messages. The `searxng-js:sex:*` diagnostics channels of the other sex packages are listed in their READMEs.
