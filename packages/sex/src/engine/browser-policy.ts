/**
 * Request policies: what the browser may do with each request a page makes.
 *
 * A policy looks at one request and answers "go on", "go on with these header changes" or "abort". Policies run in order
 * (`RequestPolicyPipeline`); header changes accumulate, so a later policy sees what an earlier one did, and the first abort
 * wins. Request interception is switched on when at least one policy is active, and only then.
 *
 * To add behaviour, write a `RequestPolicy` and add it to the `policies` list in `applyRequestPolicies`. The pipeline and
 * `applyRequestPolicies` (the only code that touches Puppeteer's request objects) stay as they are.
 */

import { AppError } from "@sex/core/errors.ts";
import { log } from "@sex/core/log.ts";
import type { HTTPRequest, Page } from "puppeteer-core";
import { type AdBlockList, siteOf } from "./adblock.ts";

/** What a policy gets to see. `headers` are lowercase and already include the changes of earlier policies. */
export interface PolicyRequest {
  url: URL;
  method: string;
  /** CDP resource type: `document`, `script`, `image`, `media`, `xhr`, ... */
  resourceType: string;
  /** A navigation of the page's main frame (the target page and its redirects), not of an iframe. */
  isMainFrameNavigation: boolean;
  /**
   * The headers the browser has put on the request so far, without `cookie`: cookies belong to the browser's cookie jar, and
   * Lightpanda 1.0.2 reports them one character short, so passing them back would corrupt them.
   */
  headers: Readonly<Record<string, string>>;
}

export type PolicyDecision =
  /** Nothing to say; the next policy decides. */
  | { type: "continue" }
  /** Add or replace headers (`set`, lowercase names) and drop others (`remove`), then go on with the next policy. */
  | { type: "headers"; set?: Record<string, string>; remove?: readonly string[] }
  /** Stop here: the request never reaches the network. */
  | { type: "abort"; reason?: "blockedbyclient" | "failed" };

export interface RequestPolicy {
  readonly name: string;
  /** What breaks without interception, for the error when the browser cannot intercept ("private-network protection"). */
  readonly purpose: string;
  /** How to proceed on a browser without interception, appended to that error. */
  readonly remedy?: string;
  /** Nice to have, not a safeguard: on a browser that cannot intercept the policy is dropped instead of failing the scrape. */
  readonly optional?: boolean;
  decide(req: PolicyRequest): PolicyDecision | Promise<PolicyDecision>;
}

export type PolicyOutcome =
  | {
      type: "continue" /** Set when a policy changed the headers: the complete header set to send (still without `cookie`). */;
      headers?: Record<string, string>;
    }
  | { type: "abort"; reason: "blockedbyclient" | "failed"; policy: string };

export class RequestPolicyPipeline {
  constructor(readonly policies: readonly RequestPolicy[]) {}

  /** Interception is needed as soon as one policy exists. */
  get active(): boolean {
    return this.policies.length > 0;
  }

  async run(req: PolicyRequest): Promise<PolicyOutcome> {
    let headers = { ...req.headers };
    let changed = false;
    for (const policy of this.policies) {
      const decision = await policy.decide({ ...req, headers });
      if (decision.type === "abort") return { type: "abort", reason: decision.reason ?? "blockedbyclient", policy: policy.name };
      if (decision.type === "headers") {
        if (decision.set && Object.keys(decision.set).length) {
          headers = { ...headers, ...decision.set };
          changed = true;
        }
        for (const name of decision.remove ?? []) {
          if (!(name in headers)) continue;
          delete headers[name];
          changed = true;
        }
      }
    }
    return changed ? { type: "continue", headers } : { type: "continue" };
  }
}

// --- Policy: private-network protection (SSRF) -------------------------------------------------------------------------

/**
 * Aborts requests the guard refuses (documents, redirects and subresources alike). Verdicts are cached per origin for the life
 * of the policy, i.e. one page; every request still passes through `decide`.
 */
export class PrivateNetworkPolicy implements RequestPolicy {
  readonly name = "private-network";
  readonly purpose = "private-network protection";
  readonly remedy = "or use --allow-private-network";
  /** Main-frame navigations that were refused, so the caller can report a clear error instead of a generic load failure. */
  readonly blockedNavigations: string[] = [];
  private readonly verdicts = new Map<string, Promise<boolean>>();

  constructor(private readonly guard: (origin: string) => Promise<boolean>) {}

  async decide(req: PolicyRequest): Promise<PolicyDecision> {
    const origin = req.url.origin;
    let verdict = this.verdicts.get(origin);
    if (!verdict) {
      verdict = this.guard(origin);
      this.verdicts.set(origin, verdict);
    }
    if (await verdict) return { type: "continue" };
    if (req.isMainFrameNavigation) this.blockedNavigations.push(req.url.href);
    return { type: "abort", reason: "blockedbyclient" };
  }
}

// --- Policy: ads and trackers -------------------------------------------------------------------------------------------

/**
 * Aborts requests to the ad and tracker domains of EasyList / EasyPrivacy (`blockAds`). The page itself is never blocked: a
 * main-frame navigation, redirects included, is what the caller asked for. Third-party-only rules apply when the request leaves
 * the registrable domain of the target.
 */
export class AdBlockPolicy implements RequestPolicy {
  readonly name = "ad-block";
  readonly purpose = "ad blocking";
  readonly optional = true;
  /** Requests aborted so far, for this page. */
  blocked = 0;
  private readonly pageSite: string;

  constructor(
    private readonly list: AdBlockList,
    pageUrl: string,
  ) {
    this.pageSite = siteOf(new URL(pageUrl).hostname);
  }

  decide(req: PolicyRequest): PolicyDecision {
    if (req.isMainFrameNavigation || !this.list.blocks(req.url.hostname, this.pageSite)) return { type: "continue" };
    this.blocked++;
    return { type: "abort", reason: "blockedbyclient" };
  }
}

// --- Policy: images and media ---------------------------------------------------------------------------------------------

const MEDIA_TYPES: ReadonlySet<string> = new Set(["image", "media"]);

/** Aborts image and audio / video requests (`SEX_BLOCK_MEDIA`): a text scrape does not need the bytes. */
export class MediaBlockPolicy implements RequestPolicy {
  readonly name = "media-block";
  readonly purpose = "media blocking";
  readonly optional = true;

  decide(req: PolicyRequest): PolicyDecision {
    return !req.isMainFrameNavigation && MEDIA_TYPES.has(req.resourceType)
      ? { type: "abort", reason: "blockedbyclient" }
      : { type: "continue" };
  }
}

// --- Policy: credentials stay on the target's origin --------------------------------------------------------------------

/** Headers that authenticate the caller. They are sent to the target's origin only, as the HTTP path does (`safeFetch`). */
export const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"] as const;

/**
 * Adds the caller's credential headers to requests for the target's origin and to no other: not to CDNs, analytics or ad
 * domains the page loads, and not to a redirect that leaves the origin. (A browser-wide `setExtraHTTPHeaders` would put them
 * on every request.) Headers the page sets itself are left alone, since a page may legitimately authenticate to its own API.
 */
export class OriginScopedCredentialsPolicy implements RequestPolicy {
  readonly name = "origin-scoped-credentials";
  readonly purpose = "keeping the Authorization header on the target's origin";

  constructor(
    private readonly origin: string,
    /** Lowercase header names to their values. */
    private readonly credentials: Readonly<Record<string, string>>,
  ) {}

  decide(req: PolicyRequest): PolicyDecision {
    if (req.url.origin === this.origin) return { type: "headers", set: { ...this.credentials } };
    // Should the browser have carried one of the caller's credentials over anyway, take it off again. A different value was set
    // by the page itself and stays.
    const carried = Object.keys(this.credentials).filter((name) => req.headers[name] === this.credentials[name]);
    return carried.length ? { type: "headers", remove: carried } : { type: "continue" };
  }
}

// --- User headers ---------------------------------------------------------------------------------------------------------

export interface SplitHeaders {
  /** Everything that is not a credential: harmless on any request, applied browser-wide. */
  plain: Record<string, string>;
  /** `authorization` and `proxy-authorization`, lowercase: attached to the target's origin by `OriginScopedCredentialsPolicy`. */
  scoped: Record<string, string>;
  /** The `Cookie` header parsed into pairs, for the cookie jar. */
  cookies: Array<{ name: string; value: string }>;
}

export function splitUserHeaders(headers: Record<string, string> = {}): SplitHeaders {
  const out: SplitHeaders = { plain: {}, scoped: {}, cookies: [] };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "cookie") out.cookies.push(...parseCookieHeader(value));
    else if (lower === "authorization" || lower === "proxy-authorization") out.scoped[lower] = value;
    else out.plain[name] = value;
  }
  return out;
}

/** `a=1; b=2` into pairs; the value is everything after the first `=`. Pieces without a name are dropped. */
export function parseCookieHeader(header: string): Array<{ name: string; value: string }> {
  const pairs: Array<{ name: string; value: string }> = [];
  for (const piece of header.split(";")) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const name = piece.slice(0, eq).trim();
    if (name) pairs.push({ name, value: piece.slice(eq + 1).trim() });
  }
  return pairs;
}

// --- Wiring ---------------------------------------------------------------------------------------------------------------

export interface RequestPolicyOptions {
  /** The page being scraped: its origin is the origin credentials belong to. */
  url: string;
  headers?: Record<string, string>;
  /** Resolves true when the origin may be contacted. Absent when private networks are allowed. */
  requestGuard?: (origin: string) => Promise<boolean>;
  /** Block the ad and tracker domains of this list; absent means no ad blocking. */
  adBlockList?: AdBlockList;
  /** Block image and media requests. */
  blockMedia?: boolean;
}

export type PolicyPage = Pick<Page, "setExtraHTTPHeaders" | "setCookie" | "setRequestInterception" | "on" | "mainFrame">;

export interface AppliedPolicies {
  /** Main-frame navigations refused by the private-network policy (empty when that policy is off). */
  blockedNavigations: readonly string[];
  /** Requests aborted as ads or trackers so far. */
  adsBlocked(): number;
}

/**
 * Applies the caller's headers and the request policies to a page, before it navigates.
 *
 * Plain headers go to the whole page. A `Cookie` header goes into the cookie jar as host-only cookies of the target's host
 * (not a registrable-domain guess, so `co.uk` is no problem), which the browser then sends to that host alone, redirects
 * included. `Authorization` / `Proxy-Authorization` are attached by a policy to the target's origin only.
 */
export async function applyRequestPolicies(page: PolicyPage, opts: RequestPolicyOptions): Promise<AppliedPolicies> {
  const target = new URL(opts.url);
  const { plain, scoped, cookies } = splitUserHeaders(opts.headers);
  if (Object.keys(plain).length) await page.setExtraHTTPHeaders(plain).catch(() => {});

  let cookieHeader: string | undefined;
  if (cookies.length) {
    // `url` without `domain` makes the cookies host-only.
    const stored = await page.setCookie(...cookies.map((c) => ({ ...c, url: target.origin }))).then(
      () => true,
      () => false,
    );
    // A browser without cookie support keeps the old header behaviour, but scoped to the target's origin like Authorization.
    if (!stored) cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  const privateNetwork = opts.requestGuard ? new PrivateNetworkPolicy(opts.requestGuard) : undefined;
  const credentials = { ...scoped, ...(cookieHeader ? { cookie: cookieHeader } : {}) };
  const adBlock = opts.adBlockList ? new AdBlockPolicy(opts.adBlockList, opts.url) : undefined;
  // Cheap local verdicts first, so a blocked request never costs the private-network policy a DNS lookup.
  const policies: RequestPolicy[] = [
    ...(opts.blockMedia ? [new MediaBlockPolicy()] : []),
    ...(adBlock ? [adBlock] : []),
    ...(privateNetwork ? [privateNetwork] : []),
    ...(Object.keys(credentials).length ? [new OriginScopedCredentialsPolicy(target.origin, credentials)] : []),
  ];
  const pipeline = new RequestPolicyPipeline(policies);
  const applied: AppliedPolicies = {
    blockedNavigations: privateNetwork?.blockedNavigations ?? [],
    adsBlocked: () => adBlock?.blocked ?? 0,
  };
  if (!pipeline.active) return applied;

  const interceptable = await page.setRequestInterception(true).then(
    () => true,
    () => false,
  );
  if (!interceptable) {
    const required = policies.filter((p) => !p.optional);
    if (!required.length) {
      log.debug("browser cannot intercept requests; ad and media blocking skipped");
      return applied;
    }
    const remedies = required.flatMap((p) => (p.remedy ? [p.remedy] : []));
    throw new AppError(
      "BROWSER_INTERCEPTION_UNSUPPORTED",
      `This browser cannot intercept requests, so ${required.map((p) => p.purpose).join(" and ")} cannot be enforced. Use a browser with CDP Fetch support${remedies.length ? ` ${remedies.join(" ")}` : ""}.`,
    );
  }

  page.on("request", (req) => {
    handleRequest(req, pipeline, page).catch(() => req.abort("failed").catch(() => {}));
  });
  return applied;
}

async function handleRequest(req: HTTPRequest, pipeline: RequestPolicyPipeline, page: PolicyPage): Promise<void> {
  if (req.isInterceptResolutionHandled()) return;
  const raw = req.url();
  // Nothing here touches the network.
  if (/^(data|blob|about):/i.test(raw)) {
    await req.continue().catch(() => {});
    return;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    await req.abort("blockedbyclient").catch(() => {});
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    await req.abort("blockedbyclient").catch(() => {});
    return;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers())) {
    if (name.toLowerCase() !== "cookie") headers[name.toLowerCase()] = value;
  }
  const outcome = await pipeline.run({
    url,
    method: req.method(),
    resourceType: req.resourceType(),
    isMainFrameNavigation: req.isNavigationRequest() && req.frame() === page.mainFrame(),
    headers,
  });
  if (outcome.type === "abort") await req.abort(outcome.reason).catch(() => {});
  else await req.continue(outcome.headers ? { headers: outcome.headers } : undefined).catch(() => {});
}
