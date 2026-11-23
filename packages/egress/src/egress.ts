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
import { AppError } from "@searxng-js/sex-errors";
import {
  allowlistAllows,
  classifyAddress,
  type ParsedAllowlist,
  type PrivateNetworkAccess,
  type PrivateNetworkAllowlist,
  parsePrivateNetworkAllowlist,
} from "./private-network.ts";

/** How many of a name's addresses a connection tries, in order. */
export const MAX_PINNED_ADDRESSES = 4;
/** How long a host's addresses are reused: short, so a changed record is noticed, long enough for a page's subresources. */
const TTL_MS = 30_000;
/** A name that did not resolve is asked again sooner. */
const NEGATIVE_TTL_MS = 5_000;
const MAX_CACHED_HOSTS = 1024;

export { isPrivateIp } from "./private-network.ts";

/** A host name to its addresses; an empty list when it does not resolve. */
export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = (host) => lookup(host, { all: true }).then((all) => all.map((a) => a.address));

export interface EgressPolicyOptions {
  /**
   * `false`: only public addresses. `true`: skip every check (`--allow-private-network`): nothing is refused and nothing is
   * pinned. An allowlist: public addresses plus what it opens, checked and pinned like public ones (see private-network.ts).
   */
  allowPrivateNetwork: PrivateNetworkAccess;
  /** Tests swap the resolver and the clock. */
  resolver?: Resolver;
  now?: () => number;
}

export class EgressPolicy {
  /** True only when every check is off; an allowlist still checks (and is in `allowlist`). */
  readonly allowPrivateNetwork: boolean;
  /** The parsed allowlist, when there is one; entries that did not parse are in its `errors` and have no effect. */
  readonly allowlist: ParsedAllowlist | undefined;
  private readonly resolver: Resolver;
  private readonly now: () => number;
  private readonly cache = new Map<string, { expires: number; addresses: Promise<string[]> }>();

  constructor(opts: EgressPolicyOptions) {
    const access = opts.allowPrivateNetwork;
    this.allowPrivateNetwork = access === true;
    this.allowlist = typeof access === "object" ? parsePrivateNetworkAllowlist(access) : undefined;
    this.resolver = opts.resolver ?? systemResolver;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Resolves the URL's host and refuses it (`PRIVATE_NETWORK_BLOCKED`) if any address may not be connected to: anything not
   * public, unless the allowlist opens it. Returns the validated addresses of a DNS name, which the caller connects to
   * instead of looking the name up again; empty for an IP literal, when every check is off, or when the name does not
   * resolve. With `requireResolvable` (a proxy will resolve the name on its own) a name that does not resolve here is
   * refused: a name only the proxy's resolver knows could be an internal one.
   *
   * The error's `details` say why: `{ host, address?, reason }`, `reason` being `private` (no rule opens it), `loopback`
   * (the loopback switch is off) or `never` (link-local or cloud metadata, which no rule opens).
   */
  async resolve(url: Pick<URL, "hostname" | "href">, requireResolvable = false): Promise<readonly string[]> {
    if (this.allowPrivateNetwork) return [];
    const host = url.hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase()
      .replace(/\.$/, "");
    if ((host === "localhost" || host.endsWith(".localhost")) && !this.allowlist?.loopback) {
      throw blocked(url, { host, reason: "loopback" });
    }
    const literal = isIP(host) !== 0;
    const addresses = literal ? [host] : await this.addressesOf(host);
    for (const address of addresses) {
      const reason = this.refusal(url, host, address);
      if (reason) throw blocked(url, { host, address, reason });
    }
    if (requireResolvable && !addresses.length) {
      throw new AppError(
        "SCRAPE_DNS_RESOLUTION_ERROR",
        `Could not resolve the host name of ${url.href} to check it before sending it through the proxy. Check that the domain exists.`,
      );
    }
    return literal ? [] : addresses;
  }

  /** Why `address` (one of `host`'s) is refused, or undefined when it may be connected to. */
  private refusal(url: Pick<URL, "href">, host: string, address: string): BlockReason | undefined {
    const cls = classifyAddress(address);
    if (cls === "public") return undefined;
    if (!this.allowlist) return cls === "never" ? "never" : "private";
    return allowlistAllows(this.allowlist, new URL(url.href), host, address) ? undefined : cls;
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

type BlockReason = "private" | "loopback" | "never";

function blocked(url: Pick<URL, "href">, details: { host: string; address?: string; reason: BlockReason }): AppError {
  const what =
    details.reason === "never"
      ? "link-local and cloud metadata addresses are never fetched"
      : details.reason === "loopback"
        ? "loopback is not allowed"
        : "the address is in a private network";
  return new AppError("PRIVATE_NETWORK_BLOCKED", `Refusing to fetch private address: ${url.href} (${what})`, details);
}

const shared = new Map<boolean, EgressPolicy>();
const sharedAllowlists = new WeakMap<PrivateNetworkAllowlist, EgressPolicy>();

/**
 * The process-wide policy for a mode, so every enforcement point shares one address cache. An allowlist gets one policy per
 * object: pass the same object for as long as the list is unchanged, and a new one when it changes.
 */
export function egressFor(access: PrivateNetworkAccess): EgressPolicy {
  if (typeof access === "object") {
    let policy = sharedAllowlists.get(access);
    if (!policy) {
      policy = new EgressPolicy({ allowPrivateNetwork: access });
      sharedAllowlists.set(access, policy);
    }
    return policy;
  }
  let policy = shared.get(access);
  if (!policy) {
    policy = new EgressPolicy({ allowPrivateNetwork: access });
    shared.set(access, policy);
  }
  return policy;
}
