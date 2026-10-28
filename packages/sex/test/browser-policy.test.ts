import { describe, expect, test } from "bun:test";
import type { HTTPRequest } from "puppeteer-core";
import {
  applyRequestPolicies,
  OriginScopedCredentialsPolicy,
  type PolicyDecision,
  type PolicyPage,
  type PolicyRequest,
  PrivateNetworkPolicy,
  parseCookieHeader,
  type RequestPolicy,
  RequestPolicyPipeline,
  splitUserHeaders,
} from "../src/engine/browser-policy.ts";

// No browser needed: the pipeline is pure, and applyRequestPolicies is driven through a fake page.

const req = (url: string, over: Partial<PolicyRequest> = {}): PolicyRequest => ({
  url: new URL(url),
  method: "GET",
  resourceType: "script",
  isMainFrameNavigation: false,
  headers: {},
  ...over,
});

const policy = (name: string, decide: (r: PolicyRequest) => PolicyDecision | Promise<PolicyDecision>): RequestPolicy => ({
  name,
  purpose: name,
  decide,
});

describe("RequestPolicyPipeline", () => {
  test("is inactive without policies and lets everything through unchanged", async () => {
    const pipeline = new RequestPolicyPipeline([]);
    expect(pipeline.active).toBe(false);
    expect(await pipeline.run(req("https://a.test/"))).toEqual({ type: "continue" });
  });

  test("runs policies in order; header changes accumulate and a later policy sees them", async () => {
    const seen: Array<Record<string, string>> = [];
    const pipeline = new RequestPolicyPipeline([
      policy("one", () => ({ type: "headers", set: { "x-a": "1", "x-b": "2" } })),
      policy("two", (r) => {
        seen.push({ ...r.headers });
        return { type: "headers", set: { "x-a": "3" }, remove: ["x-b"] };
      }),
    ]);
    expect(pipeline.active).toBe(true);
    const outcome = await pipeline.run(req("https://a.test/", { headers: { accept: "*/*" } }));
    expect(seen).toEqual([{ accept: "*/*", "x-a": "1", "x-b": "2" }]);
    expect(outcome).toEqual({ type: "continue", headers: { accept: "*/*", "x-a": "3" } });
  });

  test("the first abort wins and later policies do not run", async () => {
    let ran = false;
    const pipeline = new RequestPolicyPipeline([
      policy("block", () => ({ type: "abort" })),
      policy("later", () => {
        ran = true;
        return { type: "continue" };
      }),
    ]);
    expect(await pipeline.run(req("https://a.test/"))).toEqual({ type: "abort", reason: "blockedbyclient", policy: "block" });
    expect(ran).toBe(false);
  });

  test("an abort discards header changes made earlier; removing an absent header is not a change", async () => {
    const pipeline = new RequestPolicyPipeline([
      policy("set", () => ({ type: "headers", set: { "x-a": "1" } })),
      policy("block", () => ({ type: "abort", reason: "failed" })),
    ]);
    expect(await pipeline.run(req("https://a.test/"))).toEqual({ type: "abort", reason: "failed", policy: "block" });
    const noop = new RequestPolicyPipeline([policy("rm", () => ({ type: "headers", remove: ["x-absent"] }))]);
    expect(await noop.run(req("https://a.test/"))).toEqual({ type: "continue" });
  });

  test("async policies are awaited", async () => {
    const pipeline = new RequestPolicyPipeline([
      policy("slow", async () => {
        await Bun.sleep(5);
        return { type: "abort" };
      }),
    ]);
    expect((await pipeline.run(req("https://a.test/"))).type).toBe("abort");
  });
});

describe("PrivateNetworkPolicy", () => {
  test("asks the guard once per origin and aborts what it refuses", async () => {
    const asked: string[] = [];
    const p = new PrivateNetworkPolicy(async (origin) => {
      asked.push(origin);
      return origin === "https://ok.test";
    });
    expect(await p.decide(req("https://ok.test/a"))).toEqual({ type: "continue" });
    expect(await p.decide(req("https://ok.test/b?q=1"))).toEqual({ type: "continue" });
    expect(await p.decide(req("http://10.0.0.1:8080/x"))).toEqual({ type: "abort", reason: "blockedbyclient" });
    expect(await p.decide(req("http://10.0.0.1:8080/y"))).toEqual({ type: "abort", reason: "blockedbyclient" });
    expect(asked).toEqual(["https://ok.test", "http://10.0.0.1:8080"]);
  });

  test("records refused main-frame navigations only", async () => {
    const p = new PrivateNetworkPolicy(async () => false);
    await p.decide(req("http://10.0.0.1/img.png"));
    await p.decide(req("http://10.0.0.1/frame", { resourceType: "document" }));
    await p.decide(req("http://10.0.0.1/secret", { resourceType: "document", isMainFrameNavigation: true }));
    expect(p.blockedNavigations).toEqual(["http://10.0.0.1/secret"]);
  });
});

describe("OriginScopedCredentialsPolicy", () => {
  const creds = new OriginScopedCredentialsPolicy("https://site.test", { authorization: "Bearer T", "proxy-authorization": "Basic P" });

  test("attaches the credentials to requests for the target's origin", () => {
    expect(creds.decide(req("https://site.test/api"))).toEqual({
      type: "headers",
      set: { authorization: "Bearer T", "proxy-authorization": "Basic P" },
    });
  });

  test("attaches nothing to another origin: other host, subdomain, port or scheme", () => {
    for (const url of ["https://cdn.test/x.js", "https://www.site.test/", "https://site.test:8443/", "http://site.test/"]) {
      expect(creds.decide(req(url))).toEqual({ type: "continue" });
    }
  });

  test("takes a carried-over copy off other origins, but not a different value the page set itself", () => {
    expect(creds.decide(req("https://cdn.test/", { headers: { authorization: "Bearer T", accept: "*/*" } }))).toEqual({
      type: "headers",
      remove: ["authorization"],
    });
    expect(creds.decide(req("https://api.other.test/", { headers: { authorization: "Bearer page-own" } }))).toEqual({
      type: "continue",
    });
  });
});

describe("splitUserHeaders / parseCookieHeader", () => {
  test("separates credentials from plain headers whatever their case", () => {
    expect(
      splitUserHeaders({
        Authorization: "Bearer T",
        "PROXY-AUTHORIZATION": "Basic P",
        Cookie: "a=1; b=2",
        "X-Api-Version": "3",
        "Accept-Language": "de",
      }),
    ).toEqual({
      plain: { "X-Api-Version": "3", "Accept-Language": "de" },
      scoped: { authorization: "Bearer T", "proxy-authorization": "Basic P" },
      cookies: [
        { name: "a", value: "1" },
        { name: "b", value: "2" },
      ],
    });
    expect(splitUserHeaders(undefined)).toEqual({ plain: {}, scoped: {}, cookies: [] });
  });

  test("a cookie value is everything after the first '='; nameless pieces are dropped", () => {
    expect(parseCookieHeader("token=abc==; ; =x; flag; theme = dark ")).toEqual([
      { name: "token", value: "abc==" },
      { name: "theme", value: "dark" },
    ]);
  });
});

// --- applyRequestPolicies against a fake page ---------------------------------------------------------------------------

interface Call {
  type: "continue" | "abort";
  arg?: unknown;
}

function fakePage(opts: { interceptable?: boolean; cookies?: boolean } = {}) {
  const log: { extraHeaders?: Record<string, string>; cookies: unknown[]; interception?: boolean } = { cookies: [] };
  const main = {};
  let listener: ((r: HTTPRequest) => void) | undefined;
  const page = {
    setExtraHTTPHeaders: async (h: Record<string, string>) => {
      log.extraHeaders = h;
    },
    setCookie: async (...c: unknown[]) => {
      if (opts.cookies === false) throw new Error("Network.setCookies not supported");
      log.cookies.push(...c);
    },
    setRequestInterception: async (v: boolean) => {
      if (opts.interceptable === false) throw new Error("Fetch not supported");
      log.interception = v;
    },
    on: (_event: string, cb: (r: HTTPRequest) => void) => {
      listener = cb;
    },
    mainFrame: () => main,
  } as unknown as PolicyPage;

  /** Fires a request and resolves with how it was answered. */
  async function fire(url: string, init: { headers?: Record<string, string>; navigation?: boolean; frame?: unknown } = {}): Promise<Call> {
    let done!: (c: Call) => void;
    const result = new Promise<Call>((resolve) => {
      done = resolve;
    });
    const request = {
      isInterceptResolutionHandled: () => false,
      url: () => url,
      method: () => "GET",
      resourceType: () => (init.navigation ? "document" : "script"),
      isNavigationRequest: () => !!init.navigation,
      frame: () => init.frame ?? main,
      headers: () => init.headers ?? { accept: "*/*" },
      continue: async (arg?: unknown) => done({ type: "continue", arg }),
      abort: async (arg?: unknown) => done({ type: "abort", arg }),
    } as unknown as HTTPRequest;
    listener?.(request);
    return result;
  }
  return { page, log, fire, hasListener: () => !!listener };
}

describe("applyRequestPolicies", () => {
  const target = "https://site.test/start";

  test("without headers or a guard it leaves the page alone: no interception", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, { url: target });
    expect(f.log).toEqual({ cookies: [] });
    expect(f.hasListener()).toBe(false);
  });

  test("plain headers go browser-wide, cookies into the jar for the target host only, and neither needs interception", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, { url: target, headers: { "Accept-Language": "de", Cookie: "sid=abc; theme=dark" } });
    expect(f.log.extraHeaders).toEqual({ "Accept-Language": "de" });
    // Host-only: a url and no domain.
    expect(f.log.cookies).toEqual([
      { name: "sid", value: "abc", url: "https://site.test" },
      { name: "theme", value: "dark", url: "https://site.test" },
    ]);
    expect(f.log.interception).toBeUndefined();
    expect(f.hasListener()).toBe(false);
  });

  test("Authorization turns interception on even when private networks are allowed, and stays on the target's origin", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, { url: target, headers: { Authorization: "Bearer T", "X-Keep": "1" } });
    expect(f.log.interception).toBe(true);
    // Never browser-wide.
    expect(f.log.extraHeaders).toEqual({ "X-Keep": "1" });

    expect(await f.fire("https://site.test/api", { navigation: true })).toEqual({
      type: "continue",
      arg: { headers: { accept: "*/*", authorization: "Bearer T" } },
    });
    expect(await f.fire("https://site.test/app.js")).toMatchObject({ arg: { headers: { authorization: "Bearer T" } } });
    // Third parties and a redirect off the origin get a plain continue.
    expect(await f.fire("https://cdn.example/lib.js")).toEqual({ type: "continue", arg: undefined });
    expect(await f.fire("https://elsewhere.test/landing", { navigation: true })).toEqual({ type: "continue", arg: undefined });
  });

  test("a Cookie header is never passed back to the browser", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, { url: target, headers: { Authorization: "Bearer T" } });
    const call = await f.fire("https://site.test/", { headers: { cookie: "sid=trunc", accept: "*/*" } });
    expect(call.arg).toEqual({ headers: { accept: "*/*", authorization: "Bearer T" } });
  });

  test("the private-network guard keeps its behaviour: abort, per-origin cache, navigations recorded", async () => {
    const f = fakePage();
    const asked: string[] = [];
    const applied = await applyRequestPolicies(f.page, {
      url: target,
      requestGuard: async (origin) => {
        asked.push(origin);
        return origin === "https://site.test";
      },
    });
    expect(f.log.interception).toBe(true);
    expect(await f.fire("https://site.test/a")).toEqual({ type: "continue", arg: undefined });
    expect(await f.fire("https://site.test/b")).toEqual({ type: "continue", arg: undefined });
    expect(await f.fire("http://10.0.0.5/x.png")).toEqual({ type: "abort", arg: "blockedbyclient" });
    expect(await f.fire("http://10.0.0.5/page", { navigation: true })).toEqual({ type: "abort", arg: "blockedbyclient" });
    expect(await f.fire("http://10.0.0.5/frame", { navigation: true, frame: {} })).toEqual({ type: "abort", arg: "blockedbyclient" });
    expect(asked).toEqual(["https://site.test", "http://10.0.0.5"]);
    expect(applied.blockedNavigations).toEqual(["http://10.0.0.5/page"]);
  });

  test("the guard runs before the credentials: a refused origin never gets them", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, { url: target, headers: { Authorization: "Bearer T" }, requestGuard: async () => false });
    expect(await f.fire("https://site.test/", { navigation: true })).toEqual({ type: "abort", arg: "blockedbyclient" });
  });

  test("data:, blob: and about: pass untouched; other schemes and bad URLs are aborted", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, { url: target, headers: { Authorization: "Bearer T" } });
    expect(await f.fire("data:text/plain,hi")).toEqual({ type: "continue", arg: undefined });
    expect(await f.fire("about:blank")).toEqual({ type: "continue", arg: undefined });
    expect(await f.fire("ftp://site.test/x")).toEqual({ type: "abort", arg: "blockedbyclient" });
    expect(await f.fire("not a url")).toEqual({ type: "abort", arg: "blockedbyclient" });
  });

  test("a browser without interception fails with 501 when a policy needs it", async () => {
    for (const opts of [{ requestGuard: async () => true }, { headers: { Authorization: "Bearer T" } }]) {
      const f = fakePage({ interceptable: false });
      const err = await applyRequestPolicies(f.page, { url: target, ...opts }).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 501, code: "BROWSER_INTERCEPTION_UNSUPPORTED" });
    }
    const f = fakePage({ interceptable: false });
    const err = await applyRequestPolicies(f.page, { url: target, requestGuard: async () => true }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("private-network protection");
    expect((err as Error).message).toContain("--allow-private-network");
    // Nothing to enforce, nothing to ask of the browser.
    await applyRequestPolicies(fakePage({ interceptable: false }).page, { url: target });
  });

  test("a browser without a cookie jar gets the Cookie header on the target's origin only", async () => {
    const f = fakePage({ cookies: false });
    await applyRequestPolicies(f.page, { url: target, headers: { Cookie: "sid=abc; theme=dark" } });
    expect(f.log.interception).toBe(true);
    expect(await f.fire("https://site.test/", { navigation: true })).toMatchObject({
      arg: { headers: { cookie: "sid=abc; theme=dark" } },
    });
    expect(await f.fire("https://cdn.example/x.js")).toEqual({ type: "continue", arg: undefined });
  });

  test("a throwing policy aborts the request instead of letting it through", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, {
      url: target,
      requestGuard: async () => {
        throw new Error("resolver down");
      },
    });
    expect(await f.fire("https://site.test/")).toEqual({ type: "abort", arg: "failed" });
  });
});
