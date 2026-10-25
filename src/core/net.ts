import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { DEFAULT_MAX_BODY_BYTES } from "../config.ts";
import { AppError, badRequest } from "../errors.ts";

const MAX_REDIRECTS = 10;
const MAX_PINNED_ADDRESSES = 4;

export interface FetchOptions {
  headers?: Record<string, string>;
  timeout: number;
  signal?: AbortSignal;
  allowPrivateNetwork: boolean;
  skipTlsVerification?: boolean;
  userAgent: string;
  method?: "GET" | "POST";
  body?: string;
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

const v4Blocked = (a: ipaddr.IPv4) => a.range() !== "unicast";
const fromParts = (hi: number, lo: number) => new ipaddr.IPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);

/** True for anything that is not a globally routable unicast address (IPv6 forms embedding IPv4 are unwrapped). */
export function isPrivateIp(ip: string): boolean {
  if (!isIP(ip)) return false;
  const addr = ipaddr.parse(ip);
  if (addr.kind() === "ipv4") return v4Blocked(addr as ipaddr.IPv4);
  const v6 = addr as ipaddr.IPv6;
  if (v6.isIPv4MappedAddress()) return v4Blocked(v6.toIPv4Address());
  const p = v6.parts;
  if (p.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1 and deprecated IPv4-compatible ::a.b.c.d
  const range = v6.range();
  if (range === "rfc6052") return v4Blocked(fromParts(p[6] ?? 0, p[7] ?? 0)); // NAT64 64:ff9b::/96
  if (range === "6to4") return v4Blocked(fromParts(p[1] ?? 0, p[2] ?? 0)); // 2002:AABB:CCDD::/48
  return range !== "unicast"; // teredo, ULA, link-local, multicast, reserved, ...
}

/**
 * Resolves the URL's host and rejects it if any address is loopback/private/link-local (unless allowed). Returns the
 * validated addresses of a DNS name so the caller can connect to exactly those; empty for IP literals, or when private
 * networks are allowed or the name does not resolve.
 */
export async function resolvePublicAddresses(url: URL, allowPrivateNetwork: boolean): Promise<string[]> {
  if (allowPrivateNetwork) return [];
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new AppError(403, "PRIVATE_NETWORK_BLOCKED", `Refusing to fetch private address: ${url.href}`);
  }
  const literal = isIP(host) !== 0;
  const addresses = literal ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.some(isPrivateIp)) {
    throw new AppError(
      403,
      "PRIVATE_NETWORK_BLOCKED",
      `Refusing to fetch private address: ${url.href} (start with --allow-private-network to permit)`,
    );
  }
  return literal ? [] : addresses;
}

/** Rejects URLs that point at loopback/private/link-local hosts unless allowed. */
export async function assertPublicUrl(url: URL, allowPrivateNetwork: boolean): Promise<void> {
  await resolvePublicAddresses(url, allowPrivateNetwork);
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
      throw new AppError(413, "RESPONSE_TOO_LARGE", `Response body exceeds ${maxBytes} bytes`);
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

/** fetch() with SSRF checks on every redirect hop, a timeout and a body size cap. */
export async function safeFetch(rawUrl: string, opts: FetchOptions): Promise<FetchedResponse> {
  const timeoutSignal = AbortSignal.timeout(opts.timeout);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  let url = parseHttpUrl(rawUrl);
  let method = opts.method ?? "GET";
  let body: string | undefined = opts.body;
  const headers: Record<string, string> = {
    "user-agent": opts.userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    ...lowerKeys(opts.headers ?? {}),
  };
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const addresses = await resolvePublicAddresses(url, opts.allowPrivateNetwork);
      // Connect to the validated addresses themselves (first one that connects wins), not to a fresh DNS answer.
      // Without a lookup result (IP literal, private networks allowed) the URL is fetched as is.
      const targets = addresses.length ? addresses.slice(0, MAX_PINNED_ADDRESSES) : [undefined];
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
      const bytes = await readLimited(res, signal, opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      return {
        url: url.href,
        status: res.status,
        headers: res.headers,
        contentType: res.headers.get("content-type") ?? "",
        body: bytes,
      };
    }
    throw new AppError(508, "TOO_MANY_REDIRECTS", `Too many redirects: ${rawUrl}`);
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new AppError(408, "SCRAPE_TIMEOUT", `Timed out after ${opts.timeout}ms fetching ${rawUrl}`);
    }
    if (err instanceof AppError) throw err;
    if (opts.signal?.aborted) throw new AppError(408, "TIMEOUT", `Request cancelled while fetching ${rawUrl}`);
    throw new AppError(502, "FETCH_FAILED", `Failed to fetch ${rawUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

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
