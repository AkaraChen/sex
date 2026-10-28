import { DEFAULT_MAX_BODY_BYTES } from "./config.ts";
import type { Deadline } from "./deadline.ts";
import { egressFor, MAX_PINNED_ADDRESSES } from "./egress.ts";
import { AppError, badRequest, type ErrorCode } from "./errors.ts";

const MAX_REDIRECTS = 10;

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Bounds the whole fetch (redirects and body included). Pass `deadline.slice(ms)` for a step budget of its own. */
  deadline: Deadline;
  allowPrivateNetwork: boolean;
  /**
   * Outbound proxy (`config.proxyUrl`). Required so a call site cannot forget it: pass `undefined` for a direct connection.
   * With a proxy the proxy resolves the host name, so the request cannot be pinned to the validated address; see `safeFetch`.
   */
  proxy: string | undefined;
  skipTlsVerification?: boolean;
  userAgent: string;
  method?: "GET" | "POST" | "HEAD";
  body?: string;
  /** Return after the final response's headers: the body is cancelled unread and `body` is empty. */
  headersOnly?: boolean;
  /** Body size cap; defaults to DEFAULT_MAX_BODY_BYTES. Callers pass engine.config.maxBodyBytes. */
  maxBodyBytes?: number;
}

export interface FetchedResponse {
  /** Final URL after redirects. */
  url: string;
  status: number;
  headers: Headers;
  contentType: string;
  body: Uint8Array;
}

export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest(`Only http(s) URLs are supported: ${raw}`);
  }
  return url;
}

/** Rejects URLs that point at loopback/private/link-local hosts unless allowed (see `EgressPolicy.resolve`). */
export async function assertPublicUrl(url: URL, allowPrivateNetwork: boolean, requireResolvable = false): Promise<void> {
  await egressFor(allowPrivateNetwork).resolve(url, requireResolvable);
}

/**
 * Rewrites a request to connect to an already-validated IP, so a second DNS lookup (DNS rebinding) cannot send it
 * elsewhere. The original host stays in the Host header and, for https, in the TLS SNI / certificate check.
 */
export function pinToAddress(url: URL, address: string): { url: URL; host: string; serverName?: string } {
  const pinned = new URL(url);
  pinned.hostname = address.includes(":") ? `[${address}]` : address;
  return { url: pinned, host: url.host, ...(url.protocol === "https:" ? { serverName: url.hostname } : {}) };
}

async function readLimited(res: Response, signal: AbortSignal, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    if (signal.aborted) throw signal.reason;
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AppError("RESPONSE_TOO_LARGE", `Response body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * fetch() with SSRF checks on every redirect hop, a deadline and a body size cap.
 *
 * Without a proxy each hop connects to the address that was validated (`pinToAddress`). With `opts.proxy` the proxy
 * connects and resolves the host name itself, so the request cannot be pinned: the host is still resolved and checked here
 * before every hop (a name that does not resolve here is refused), which stops a URL that points at a private address but
 * not a DNS answer that changes between this check and the proxy's own lookup (rebinding). Closing that gap is the proxy's job.
 */
export async function safeFetch(rawUrl: string, opts: FetchOptions): Promise<FetchedResponse> {
  const { signal } = opts.deadline;
  let url = parseHttpUrl(rawUrl);
  let method = opts.method ?? "GET";
  let body: string | undefined = opts.body;
  const headers: Record<string, string> = {
    "user-agent": opts.userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    ...lowerKeys(opts.headers ?? {}),
  };
  // Headers the caller sets must not reach (or authenticate to) the proxy; the proxy's own credentials come from its URL.
  if (opts.proxy) for (const name of ["proxy-authorization", "proxy-connection"]) delete headers[name];
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const addresses = await egressFor(opts.allowPrivateNetwork).resolve(url, !!opts.proxy);
      // Connect to the validated addresses themselves (first one that connects wins), not to a fresh DNS answer.
      // Without a lookup result (IP literal, private networks allowed) the URL is fetched as is, and so is every URL
      // behind a proxy, which does its own lookup.
      const targets = addresses.length && !opts.proxy ? addresses.slice(0, MAX_PINNED_ADDRESSES) : [undefined];
      let res: Response | undefined;
      let connectError: unknown;
      for (const address of targets) {
        const pin = address ? pinToAddress(url, address) : undefined;
        try {
          res = await fetch(pin?.url ?? url, {
            method,
            ...(body !== undefined ? { body } : {}),
            headers: pin ? { host: pin.host, ...headers } : headers,
            redirect: "manual",
            signal,
            ...(opts.proxy ? { proxy: opts.proxy } : {}),
            // Bun-specific TLS options; ignored by other runtimes.
            ...(opts.skipTlsVerification || pin?.serverName
              ? {
                  tls: {
                    ...(opts.skipTlsVerification ? { rejectUnauthorized: false } : {}),
                    ...(pin?.serverName ? { serverName: pin.serverName } : {}),
                  },
                }
              : {}),
          } as RequestInit);
          break;
        } catch (err) {
          if (signal.aborted) throw err;
          connectError = err;
        }
      }
      if (!res) throw connectError;
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        const next = parseHttpUrl(new URL(location, url).href);
        // 301/302/303 turn a POST into a bodiless GET; 307/308 keep method and body.
        if (method === "POST" && [301, 302, 303].includes(res.status)) {
          method = "GET";
          body = undefined;
        }
        // Credentials are never forwarded to a different origin (same rule browsers apply).
        if (next.origin !== url.origin) {
          delete headers.authorization;
          delete headers.cookie;
          delete headers["proxy-authorization"];
        }
        url = next;
        continue;
      }
      if (opts.headersOnly) await res.body?.cancel();
      const bytes = opts.headersOnly ? new Uint8Array() : await readLimited(res, signal, opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      return {
        url: url.href,
        status: res.status,
        headers: res.headers,
        contentType: res.headers.get("content-type") ?? "",
        body: bytes,
      };
    }
    throw new AppError("TOO_MANY_REDIRECTS", `Too many redirects: ${rawUrl}`);
  } catch (err) {
    opts.deadline.throwIfAborted(`while fetching ${rawUrl}`);
    if (err instanceof AppError) throw err;
    throw networkError(err, rawUrl, { skipTlsVerification: opts.skipTlsVerification });
  }
}

const DNS_FAILURES = /^(ENOTFOUND|EAI_\w+|ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|CouldntResolveHost)$/;
/** Problems with the certificate itself, which `skipTlsVerification` accepts. */
const CERT_FAILURES =
  /^(CERT_\w+|ERR_CERT_\w+|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_(GET_ISSUER_CERT(_LOCALLY)?|VERIFY_LEAF_SIGNATURE)|ERR_SSL_(UNKNOWN_CA|BAD_CERT\w*|CERTIFICATE\w*)|PeerFailedVerification|SslCertproblem|SslIssuerError|SslInvalidcertstatus)$/;
/** Other failures of the TLS handshake (wrong protocol, no shared cipher, a plain-HTTP port): skipping verification does not help. */
const TLS_FAILURES = /^(EPROTO|ERR_SSL_\w+|ERR_TLS_\w+|ERR_BAD_SSL_CLIENT_AUTH_CERT|Ssl\w+|TlsConnectionTruncated)$/;
const CONNECTION_FAILURES =
  /^(ECONN\w+|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|ConnectionRefused|ConnectionClosed|FailedToOpenSocket|UND_ERR_\w+|ERR_CONNECTION_\w+|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT|ERR_ADDRESS_\w+|ERR_NETWORK_\w+|ERR_INTERNET_DISCONNECTED|ERR_INVALID_HTTP_RESPONSE|ERR_HTTP2_\w+|ERR_PROXY_\w+|CouldntConnect|ConnectionFailed|GotNothing|RecvError|SendError|OperationTimedout)$/;
/** Lightpanda names a failed request after the libcurl error, then " at <url>". */
const LIGHTPANDA_ERROR =
  /^(Couldnt\w+|ConnectionFailed|GotNothing|RecvError|SendError|OperationTimedout|PeerFailedVerification|Ssl\w+|TlsConnectionTruncated) at /;

/** The error code of a failed request: Node / Bun `code` (also on `cause`), or the name a browser puts in the message (Chromium `net::ERR_*`, Lightpanda's libcurl names). */
function networkErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof e.code === "string") return e.code;
  const message = typeof e.message === "string" ? e.message : "";
  return /net::(ERR_[A-Z0-9_]+)/.exec(message)?.[1] ?? LIGHTPANDA_ERROR.exec(message)?.[1] ?? networkErrorCode(e.cause);
}

/**
 * Names a failure to fetch a page: what `fetch()` throws, or what a CDP browser reports (`net::ERR_*`, or libcurl names from Lightpanda). Deterministic
 * problems get their own code so the client does not retry them: an unknown host is `SCRAPE_DNS_RESOLUTION_ERROR`, a bad
 * certificate `SCRAPE_SSL_ERROR` (with a hint to `skipTlsVerification`), a refused or dropped connection and any other
 * browser network error `SCRAPE_SITE_ERROR`. Anything unrecognised is `FETCH_FAILED`.
 * Does not look at aborts: callers translate those with their `Deadline` first.
 */
export function networkError(err: unknown, url: string, opts: { skipTlsVerification?: boolean } = {}): AppError {
  const reason = networkErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  const details = reason ? { reason } : undefined;
  const make = (code: ErrorCode, text: string) => new AppError(code, text, details);
  if (reason && DNS_FAILURES.test(reason)) {
    return make("SCRAPE_DNS_RESOLUTION_ERROR", `Could not resolve the host name of ${url} (${reason}). Check that the domain exists.`);
  }
  if (reason && CERT_FAILURES.test(reason)) {
    const hint = opts.skipTlsVerification ? "" : " To scrape it anyway, set skipTlsVerification to true.";
    return make("SCRAPE_SSL_ERROR", `The TLS certificate of ${url} was rejected (${reason}).${hint}`);
  }
  if (reason && TLS_FAILURES.test(reason)) return make("SCRAPE_SSL_ERROR", `The TLS handshake with ${url} failed (${reason}).`);
  // Every other `net::ERR_*` is the browser failing to get a response from the site.
  if (reason && (CONNECTION_FAILURES.test(reason) || message.includes(`net::${reason}`))) {
    return make("SCRAPE_SITE_ERROR", `Could not load ${url}: the connection failed (${reason}).`);
  }
  return make("FETCH_FAILED", `Failed to fetch ${url}: ${message}`);
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

/** HTML and XML content types (incl. `+xml` such as XHTML), but not OOXML office documents (`application/vnd.openxmlformats-...`). */
export const MARKUP_TYPE = /html|^\s*(text|application)\/xml\b|\+xml\b/i;

/** Decodes a response body using the charset from the header or an HTML <meta> tag. */
export function decodeBody(body: Uint8Array, contentType: string): string {
  let charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(body.subarray(0, 4096));
    charset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  }
  try {
    return new TextDecoder((charset ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0]).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
