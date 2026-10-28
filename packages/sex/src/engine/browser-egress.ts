/**
 * Where each browser's outbound rules are enforced. The rules themselves are `EgressPolicy`'s (core); what differs is the
 * place that can enforce them for a given browser:
 *
 * | browser                         | SSRF                                 | ads            | credentials / media |
 * |---------------------------------|--------------------------------------|----------------|---------------------|
 * | Lightpanda (spawned)            | `--block-private-networks`; behind   | CDP            | CDP, when needed    |
 * |                                 | `SEX_PROXY_URL` the `EgressProxy`    |                |                     |
 * | Chrome on this machine (--cdp)  | `EgressProxy`                        | `EgressProxy`  | CDP, when needed    |
 * | Chrome elsewhere (--cdp)        | CDP request guard                    | CDP            | CDP, when needed    |
 *
 * A browser on this machine can be pointed at a loopback proxy, which sees every connection the browser makes, however it
 * got there. A remote one cannot reach it, so the only place left is CDP request interception, which misses requests made
 * before interception is on, service workers and WebSockets. Lightpanda enforces the rule in its own network layer, but that
 * layer refuses the loopback proxy as well, so behind `SEX_PROXY_URL` (the proxy is what chains to the upstream) the flag is
 * left off and the `EgressProxy` takes over. With `--allow-private-network` no SSRF check exists anywhere.
 */

import type { Config } from "../config.ts";

export type BrowserKind = "lightpanda" | "local-cdp" | "remote-cdp";

/** Whether a host name or address is this machine's loopback, i.e. a port there is reachable from a proxy sex listens on. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare.endsWith(".localhost") || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

export function browserKind(config: Pick<Config, "cdpUrl">): BrowserKind {
  if (!config.cdpUrl) return "lightpanda";
  try {
    return isLoopbackHost(new URL(config.cdpUrl).hostname) ? "local-cdp" : "remote-cdp";
  } catch {
    return "remote-cdp";
  }
}

/** How a remote browser reaches `SEX_PROXY_URL` itself: per context, credentials answered through `page.authenticate`. */
export function contextProxy(proxyUrl: string): { server: string; credentials?: { username: string; password: string } } {
  const url = new URL(proxyUrl);
  const credentials = url.username ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : undefined;
  return { server: `${url.protocol}//${url.host}`, ...(credentials ? { credentials } : {}) };
}

export interface EgressPlan {
  kind: BrowserKind;
  /** The page's context is pointed at the `EgressProxy`, with a lease of its own. */
  proxy: boolean;
  /** What the `EgressProxy` chains to (`SEX_PROXY_URL`), if anything. */
  upstream?: string;
  /** The `EgressProxy` refuses ad and tracker domains. */
  adsInProxy: boolean;
  /** The browser is pointed at `SEX_PROXY_URL` itself (a remote browser has no `EgressProxy` to chain through). */
  direct?: ReturnType<typeof contextProxy>;
  /** CDP interception asks `EgressPolicy` about every request. */
  requestGuard: boolean;
  /** CDP interception blocks ad and tracker domains. */
  adsInCdp: boolean;
}

export function planEgress(kind: BrowserKind, rules: { checkPrivateNetwork: boolean; proxyUrl?: string }, blockAds: boolean): EgressPlan {
  const checks = rules.checkPrivateNetwork;
  switch (kind) {
    case "lightpanda": {
      const proxy = !!rules.proxyUrl;
      return { kind, proxy, upstream: rules.proxyUrl, adsInProxy: false, requestGuard: false, adsInCdp: blockAds };
    }
    case "local-cdp": {
      const proxy = checks || blockAds || !!rules.proxyUrl;
      return { kind, proxy, upstream: rules.proxyUrl, adsInProxy: blockAds, requestGuard: false, adsInCdp: false };
    }
    case "remote-cdp":
      return {
        kind,
        proxy: false,
        adsInProxy: false,
        ...(rules.proxyUrl ? { direct: contextProxy(rules.proxyUrl) } : {}),
        requestGuard: checks,
        adsInCdp: blockAds,
      };
  }
}
