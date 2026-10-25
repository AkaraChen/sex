import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError, badRequest } from "../errors.ts";

const MAX_REDIRECTS = 10;
const MAX_BODY_BYTES = Number(process.env.SEX_MAX_BODY_BYTES ?? 25 * 1024 * 1024);

export interface FetchOptions {
  headers?: Record<string, string>;
  timeout: number;
  signal?: AbortSignal;
  allowPrivateNetwork: boolean;
  skipTlsVerification?: boolean;
  userAgent: string;
  method?: "GET" | "HEAD";
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

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
];

export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateIp(mapped[1]);
    if (lower === "::" || lower === "::1") return true;
    // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast
    return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
  }
  return false;
}

/** Rejects URLs that point at loopback/private/link-local hosts unless allowed. */
export async function assertPublicUrl(url: URL, allowPrivateNetwork: boolean): Promise<void> {
  if (allowPrivateNetwork) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new AppError(403, "PRIVATE_NETWORK_BLOCKED", `Refusing to fetch private address: ${url.href}`);
  }
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.some(isPrivateIp)) {
    throw new AppError(
      403,
      "PRIVATE_NETWORK_BLOCKED",
      `Refusing to fetch private address: ${url.href} (start with --allow-private-network to permit)`,
    );
  }
}

async function readLimited(res: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    if (signal.aborted) throw signal.reason;
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new AppError(413, "RESPONSE_TOO_LARGE", `Response body exceeds ${MAX_BODY_BYTES} bytes`);
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
  const headers: Record<string, string> = {
    "user-agent": opts.userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    ...lowerKeys(opts.headers ?? {}),
  };
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(url, opts.allowPrivateNetwork);
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        redirect: "manual",
        signal,
        // Bun-specific TLS option; ignored by other runtimes.
        ...(opts.skipTlsVerification ? { tls: { rejectUnauthorized: false } } : {}),
      } as RequestInit);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = parseHttpUrl(new URL(location, url).href);
        continue;
      }
      const body = opts.method === "HEAD" ? new Uint8Array() : await readLimited(res, signal);
      return {
        url: url.href,
        status: res.status,
        headers: res.headers,
        contentType: res.headers.get("content-type") ?? "",
        body,
      };
    }
    throw new AppError(508, "TOO_MANY_REDIRECTS", `Too many redirects: ${rawUrl}`);
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new AppError(408, "SCRAPE_TIMEOUT", `Timed out after ${opts.timeout}ms fetching ${rawUrl}`);
    }
    if (err instanceof AppError) throw err;
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
