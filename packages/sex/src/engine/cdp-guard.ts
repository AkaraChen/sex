import { randomBytes, timingSafeEqual } from "node:crypto";
import type { LookupAddress, lookup } from "node:dns";
import { isIP } from "node:net";
import { AppError } from "@sex/core/errors.ts";
import { log } from "@sex/core/log.ts";
import { resolvePublicAddresses } from "@sex/core/net.ts";
import { RequestError, Server } from "proxy-chain";
import type { Config } from "../config.ts";

/**
 * The network-layer SSRF guard for an external CDP browser: a local forward proxy the browser's contexts are pointed at.
 * It resolves the target's host name with `resolvePublicAddresses` (the same check as `safeFetch`), refuses anything that is
 * not public, and makes the connection to exactly the addresses it validated (proxy-chain's `dnsLookup` hook), so a DNS
 * answer that changes between check and connect (rebinding) cannot send the request to a private address. It is the second
 * line behind the `requestGuard` interception, and covers what that cannot see: sub-requests the browser makes before the
 * interceptor is attached, service workers, and the connect itself.
 */

// proxy-chain tells its own error (which carries the HTTP status, e.g. the 407 challenge and our 403) from a crash by
// `error.name === "RequestError"`, and sets that name from the class's. `bun build --minify` renames the class, so in `dist/sex`
// every refusal would become a 500 and Chrome would never be asked to authenticate. Pin the name.
Object.defineProperty(RequestError, "name", { value: "RequestError" });

/** Why the guard is not used, or `undefined` when it is. Each condition is one the guard cannot do without. */
export function cdpGuardSkipReason(config: Pick<Config, "cdpUrl" | "allowPrivateNetwork" | "proxyUrl">): string | undefined {
  if (!config.cdpUrl) return "no external CDP browser (a spawned Lightpanda has --block-private-networks)";
  if (config.allowPrivateNetwork) return "private networks are allowed";
  if (config.proxyUrl) return "SEX_PROXY_URL is set (the upstream proxy resolves host names, so there is no address to pin)";
  if (!isLoopbackHost(new URL(config.cdpUrl).hostname)) {
    return "the CDP browser is not on this machine (it could not connect to a guard listening on 127.0.0.1)";
  }
  return undefined;
}

/** True for `localhost`, 127.0.0.0/8 and ::1: the browser shares the machine, so a 127.0.0.1 listener is reachable. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return host === "::1" || host === "0:0:0:0:0:0:0:1";
}

/** One browser context's view of the guard: its proxy credentials, and the hosts the guard refused for it. */
export interface GuardSession {
  server: string;
  credentials: { username: string; password: string };
  /** Hosts the guard refused, in order; lets a failed navigation be reported as `PRIVATE_NETWORK_BLOCKED`. */
  blocked: string[];
  release(): void;
}

/** Chrome keeps loopback (and link-local, which holds the cloud metadata address) off the proxy unless told otherwise. */
export const GUARD_BYPASS_LIST = ["<-loopback>"];

/** `resolvePublicAddresses`; a parameter so tests can stand in for DNS. */
export type GuardResolver = typeof resolvePublicAddresses;

export class CdpGuard {
  private readonly password = randomBytes(24).toString("base64url");
  private readonly sessions = new Map<string, string[]>();
  private nextSession = 0;
  private readonly server: Server;

  private constructor(private readonly resolve: GuardResolver) {
    this.server = new Server({
      host: "127.0.0.1",
      port: 0,
      prepareRequestFunction: (opts) => this.prepare(opts),
    });
    this.server.on("requestFailed", ({ error }: { error: Error }) => log.debug("cdp guard request failed", { error: error.message }));
  }

  /** Starts listening on a random port of 127.0.0.1. */
  static async start(resolve: GuardResolver = resolvePublicAddresses): Promise<CdpGuard> {
    const guard = new CdpGuard(resolve);
    await guard.server.listen();
    log.info("cdp guard started", { port: guard.server.port });
    return guard;
  }

  get port(): number {
    return this.server.port;
  }

  /** Credentials for one browser context: the user name identifies the context, the password is the process's secret. */
  session(): GuardSession {
    const username = `c${++this.nextSession}`;
    const blocked: string[] = [];
    this.sessions.set(username, blocked);
    return {
      server: `http://127.0.0.1:${this.port}`,
      credentials: { username, password: this.password },
      blocked,
      release: () => void this.sessions.delete(username),
    };
  }

  private authenticated(username: string, password: string): string[] | undefined {
    const expected = Buffer.from(this.password);
    const given = Buffer.from(password);
    // Compared in constant time; the length is not a secret worth hiding (it is fixed).
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    return this.sessions.get(username);
  }

  private async prepare(opts: { username: string; password: string; hostname: string; port: number }) {
    const blocked = this.authenticated(opts.username, opts.password);
    if (!blocked) return { requestAuthentication: true, failMsg: "Proxy credentials required." };
    const host = opts.hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];
    try {
      // `requireResolvable`: a name that does not resolve here is refused too, not looked up again by the connect.
      addresses = await this.resolve(new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}`), false, true);
    } catch (err) {
      if (err instanceof AppError && err.code === "SCRAPE_DNS_RESOLUTION_ERROR") {
        throw new RequestError(`Could not resolve ${host}`, 502, { "x-sex-guard": "unresolved" });
      }
      blocked.push(host.toLowerCase());
      log.warn("cdp guard refused a request", { host });
      throw new RequestError(`Refusing to connect to private address: ${host}`, 403, { "x-sex-guard": "blocked" });
    }
    // IP literals come back empty: they were checked, and need no lookup. Names connect to the addresses just validated.
    return addresses.length ? { dnsLookup: pinnedLookup(addresses) as unknown as typeof lookup } : {};
  }

  async close(): Promise<void> {
    this.sessions.clear();
    await this.server.close(true).catch(() => {});
  }
}

type LookupCallback = (err: Error | null, address: string | LookupAddress[], family?: number) => void;

/** A `dns.lookup` that answers with the validated addresses whatever the name is asked for, instead of asking DNS again. */
function pinnedLookup(addresses: string[]): (hostname: string, options: unknown, callback: LookupCallback) => void {
  const entries: LookupAddress[] = addresses.map((address) => ({ address, family: isIP(address) }));
  return (_hostname, options, callback) => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback;
    const opts = (typeof options === "object" && options ? options : {}) as { all?: boolean; family?: number | string };
    const family = opts.family === "IPv4" ? 4 : opts.family === "IPv6" ? 6 : Number(opts.family ?? 0);
    const usable = family ? entries.filter((e) => e.family === family) : entries;
    if (!usable.length) {
      const err = Object.assign(new Error("no validated address of that family"), { code: "ENOTFOUND" });
      return void process.nextTick(cb, err, opts.all ? [] : "");
    }
    if (opts.all) return void process.nextTick(cb, null, usable);
    process.nextTick(cb, null, usable[0]!.address, usable[0]!.family);
  };
}
