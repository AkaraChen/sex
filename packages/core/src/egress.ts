/**
 * The one outbound rule: where sex may connect to. `EgressPolicy` resolves a host, refuses it when any address is not a
 * globally routable unicast one (loopback, private, link-local incl. cloud metadata, ...), and returns the addresses the
 * caller must connect to, so a second DNS lookup (rebinding) cannot send the request somewhere else.
 *
 * Enforcement points differ by what can be enforced where, not by rule: `safeFetch` (plain HTTP), the browser's CDP request
 * guard, and sex's `EgressProxy` all ask this class. Core only defines the rule; it knows nothing about browsers.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { AppError } from "./errors.ts";

/** How many of a name's addresses a connection tries, in order. */
export const MAX_PINNED_ADDRESSES = 4;
/** How long a host's addresses are reused: short, so a changed record is noticed, long enough for a page's subresources. */
const TTL_MS = 30_000;
/** A name that did not resolve is asked again sooner. */
const NEGATIVE_TTL_MS = 5_000;
const MAX_CACHED_HOSTS = 1024;

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

/** A host name to its addresses; an empty list when it does not resolve. */
export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = (host) => lookup(host, { all: true }).then((all) => all.map((a) => a.address));

export interface EgressPolicyOptions {
  /** Skip every check (`--allow-private-network`): nothing is refused and nothing is pinned. */
  allowPrivateNetwork: boolean;
  /** Tests swap the resolver and the clock. */
  resolver?: Resolver;
  now?: () => number;
}

export class EgressPolicy {
  readonly allowPrivateNetwork: boolean;
  private readonly resolver: Resolver;
  private readonly now: () => number;
  private readonly cache = new Map<string, { expires: number; addresses: Promise<string[]> }>();

  constructor(opts: EgressPolicyOptions) {
    this.allowPrivateNetwork = opts.allowPrivateNetwork;
    this.resolver = opts.resolver ?? systemResolver;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Resolves the URL's host and refuses it (`PRIVATE_NETWORK_BLOCKED`) if any address is not public. Returns the validated
   * addresses of a DNS name, which the caller connects to instead of looking the name up again; empty for an IP literal, when
   * private networks are allowed, or when the name does not resolve. With `requireResolvable` (a proxy will resolve the name on
   * its own) a name that does not resolve here is refused: a name only the proxy's resolver knows could be an internal one.
   */
  async resolve(url: Pick<URL, "hostname" | "href">, requireResolvable = false): Promise<readonly string[]> {
    if (this.allowPrivateNetwork) return [];
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) {
      throw new AppError("PRIVATE_NETWORK_BLOCKED", `Refusing to fetch private address: ${url.href}`);
    }
    const literal = isIP(host) !== 0;
    const addresses = literal ? [host] : await this.addressesOf(host);
    if (addresses.some(isPrivateIp)) {
      throw new AppError(
        "PRIVATE_NETWORK_BLOCKED",
        `Refusing to fetch private address: ${url.href} (start with --allow-private-network to permit)`,
      );
    }
    if (requireResolvable && !addresses.length) {
      throw new AppError(
        "SCRAPE_DNS_RESOLUTION_ERROR",
        `Could not resolve the host name of ${url.href} to check it before sending it through the proxy. Check that the domain exists.`,
      );
    }
    return literal ? [] : addresses;
  }

  /** `resolve` as a yes / no, for callers that abort a request instead of reporting why. */
  async allows(url: Pick<URL, "hostname" | "href">, requireResolvable = false): Promise<boolean> {
    return this.resolve(url, requireResolvable).then(
      () => true,
      () => false,
    );
  }

  private addressesOf(host: string): Promise<string[]> {
    const now = this.now();
    const hit = this.cache.get(host);
    if (hit && hit.expires > now) return hit.addresses;
    const entry = { expires: now + TTL_MS, addresses: this.resolver(host).catch(() => [] as string[]) };
    entry.addresses.then((found) => {
      if (!found.length) entry.expires = Math.min(entry.expires, this.now() + NEGATIVE_TTL_MS);
    });
    this.cache.delete(host);
    this.cache.set(host, entry);
    if (this.cache.size > MAX_CACHED_HOSTS) this.cache.delete(this.cache.keys().next().value as string);
    return entry.addresses;
  }
}

const shared = new Map<boolean, EgressPolicy>();

/** The process-wide policy for a mode, so every enforcement point shares one address cache. */
export function egressFor(allowPrivateNetwork: boolean): EgressPolicy {
  let policy = shared.get(allowPrivateNetwork);
  if (!policy) {
    policy = new EgressPolicy({ allowPrivateNetwork });
    shared.set(allowPrivateNetwork, policy);
  }
  return policy;
}
