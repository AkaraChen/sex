import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AdBlockList,
  AdBlockPolicy,
  applyRequestPolicies,
  MediaBlockPolicy,
  OriginScopedCredentialsPolicy,
  type PolicyDecision,
  type PolicyPage,
  type PolicyRequest,
  PrivateNetworkPolicy,
  parseCookieHeader,
  type RequestPolicy,
  RequestPolicyPipeline,
  splitUserHeaders,
} from "@searxng-js/sex-browser";
import type { HTTPRequest } from "puppeteer-core";
import { assertFields } from "./support.ts";

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
    assert.equal(pipeline.active, false);
    assert.deepEqual(await pipeline.run(req("https://a.test/")), { type: "continue" });
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
    assert.equal(pipeline.active, true);
    const outcome = await pipeline.run(req("https://a.test/", { headers: { accept: "*/*" } }));
    assert.deepEqual(seen, [{ accept: "*/*", "x-a": "1", "x-b": "2" }]);
    assert.deepEqual(outcome, { type: "continue", headers: { accept: "*/*", "x-a": "3" } });
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
    assert.deepEqual(await pipeline.run(req("https://a.test/")), { type: "abort", reason: "blockedbyclient", policy: "block" });
    assert.equal(ran, false);
  });

  test("an abort discards header changes made earlier; removing an absent header is not a change", async () => {
    const pipeline = new RequestPolicyPipeline([
      policy("set", () => ({ type: "headers", set: { "x-a": "1" } })),
      policy("block", () => ({ type: "abort", reason: "failed" })),
    ]);
    assert.deepEqual(await pipeline.run(req("https://a.test/")), { type: "abort", reason: "failed", policy: "block" });
    const noop = new RequestPolicyPipeline([policy("rm", () => ({ type: "headers", remove: ["x-absent"] }))]);
    assert.deepEqual(await noop.run(req("https://a.test/")), { type: "continue" });
  });

  test("async policies are awaited", async () => {
    const pipeline = new RequestPolicyPipeline([
      policy("slow", async () => {
        await sleep(5);
        return { type: "abort" };
      }),
    ]);
    assert.equal((await pipeline.run(req("https://a.test/"))).type, "abort");
  });
});

describe("PrivateNetworkPolicy", () => {
  test("asks the guard once per origin and aborts what it refuses", async () => {
    const asked: string[] = [];
    const p = new PrivateNetworkPolicy(async (origin) => {
      asked.push(origin);
      return origin === "https://ok.test";
    });
    assert.deepEqual(await p.decide(req("https://ok.test/a")), { type: "continue" });
    assert.deepEqual(await p.decide(req("https://ok.test/b?q=1")), { type: "continue" });
    assert.deepEqual(await p.decide(req("http://10.0.0.1:8080/x")), { type: "abort", reason: "blockedbyclient" });
    assert.deepEqual(await p.decide(req("http://10.0.0.1:8080/y")), { type: "abort", reason: "blockedbyclient" });
    assert.deepEqual(asked, ["https://ok.test", "http://10.0.0.1:8080"]);
  });

  test("records refused main-frame navigations only", async () => {
    const p = new PrivateNetworkPolicy(async () => false);
    await p.decide(req("http://10.0.0.1/img.png"));
    await p.decide(req("http://10.0.0.1/frame", { resourceType: "document" }));
    await p.decide(req("http://10.0.0.1/secret", { resourceType: "document", isMainFrameNavigation: true }));
    assert.deepEqual(p.blockedNavigations, ["http://10.0.0.1/secret"]);
  });
});

describe("AdBlockPolicy", () => {
  const list = AdBlockList.parse("ads.test\n~pixel.test\n@fine.ads.test\n");

  test("aborts ad domains and counts them, lets everything else through", () => {
    const policy = new AdBlockPolicy(list, "https://news.test/story");
    assert.deepEqual(policy.decide(req("https://ads.test/x.js")), { type: "abort", reason: "blockedbyclient" });
    assert.deepEqual(policy.decide(req("https://cdn.ads.test/x.js")), { type: "abort", reason: "blockedbyclient" });
    assert.deepEqual(policy.decide(req("https://fine.ads.test/x.js")), { type: "continue" });
    assert.deepEqual(policy.decide(req("https://news.test/app.js")), { type: "continue" });
    assert.equal(policy.blocked, 2);
  });

  test("never blocks the page itself, redirects included", () => {
    const policy = new AdBlockPolicy(list, "https://ads.test/");
    assert.deepEqual(policy.decide(req("https://ads.test/", { resourceType: "document", isMainFrameNavigation: true })), {
      type: "continue",
    });
    assert.equal(policy.decide(req("https://ads.test/frame", { resourceType: "document" })).type, "abort");
    assert.equal(policy.blocked, 1);
  });

  test("third-party-only rules are judged against the page's site", () => {
    assert.equal(new AdBlockPolicy(list, "https://news.test/").decide(req("https://pixel.test/p.gif")).type, "abort");
    assert.equal(new AdBlockPolicy(list, "https://www.pixel.test/").decide(req("https://img.pixel.test/p.gif")).type, "continue");
  });
});

describe("MediaBlockPolicy", () => {
  test("aborts images and media only", () => {
    const policy = new MediaBlockPolicy();
    for (const resourceType of ["image", "media"]) {
      assert.deepEqual(policy.decide(req("https://a.test/x", { resourceType })), { type: "abort", reason: "blockedbyclient" });
    }
    for (const resourceType of ["script", "stylesheet", "xhr", "font", "document"]) {
      assert.deepEqual(policy.decide(req("https://a.test/x", { resourceType })), { type: "continue" });
    }
    assert.deepEqual(policy.decide(req("https://a.test/pic.png", { resourceType: "image", isMainFrameNavigation: true })), {
      type: "continue",
    });
  });
});

describe("OriginScopedCredentialsPolicy", () => {
  const creds = new OriginScopedCredentialsPolicy("https://site.test", { authorization: "Bearer T", "proxy-authorization": "Basic P" });

  test("attaches the credentials to requests for the target's origin", () => {
    assert.deepEqual(creds.decide(req("https://site.test/api")), {
      type: "headers",
      set: { authorization: "Bearer T", "proxy-authorization": "Basic P" },
    });
  });

  test("attaches nothing to another origin: other host, subdomain, port or scheme", () => {
    for (const url of ["https://cdn.test/x.js", "https://www.site.test/", "https://site.test:8443/", "http://site.test/"]) {
      assert.deepEqual(creds.decide(req(url)), { type: "continue" });
    }
  });

  test("takes a carried-over copy off other origins, but not a different value the page set itself", () => {
    assert.deepEqual(creds.decide(req("https://cdn.test/", { headers: { authorization: "Bearer T", accept: "*/*" } })), {
      type: "headers",
      remove: ["authorization"],
    });
    assert.deepEqual(creds.decide(req("https://api.other.test/", { headers: { authorization: "Bearer page-own" } })), {
      type: "continue",
    });
  });
});

describe("splitUserHeaders / parseCookieHeader", () => {
  test("separates credentials from plain headers whatever their case", () => {
    assert.deepEqual(
      splitUserHeaders({
        Authorization: "Bearer T",
        "PROXY-AUTHORIZATION": "Basic P",
        Cookie: "a=1; b=2",
        "X-Api-Version": "3",
        "Accept-Language": "de",
      }),
      {
        plain: { "X-Api-Version": "3", "Accept-Language": "de" },
        scoped: { authorization: "Bearer T", "proxy-authorization": "Basic P" },
        cookies: [
          { name: "a", value: "1" },
          { name: "b", value: "2" },
        ],
      },
    );
    assert.deepEqual(splitUserHeaders(undefined), { plain: {}, scoped: {}, cookies: [] });
  });

  test("a cookie value is everything after the first '='; nameless pieces are dropped", () => {
    assert.deepEqual(parseCookieHeader("token=abc==; ; =x; flag; theme = dark "), [
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
  async function fire(
    url: string,
    init: { headers?: Record<string, string>; navigation?: boolean; frame?: unknown; type?: string } = {},
  ): Promise<Call> {
    let done!: (c: Call) => void;
    const result = new Promise<Call>((resolve) => {
      done = resolve;
    });
    const request = {
      isInterceptResolutionHandled: () => false,
      url: () => url,
      method: () => "GET",
      resourceType: () => init.type ?? (init.navigation ? "document" : "script"),
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
    assert.deepEqual(f.log, { cookies: [] });
    assert.equal(f.hasListener(), false);
  });

  test("plain headers go browser-wide, cookies into the jar for the target host only, and neither needs interception", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, { url: target, headers: { "Accept-Language": "de", Cookie: "sid=abc; theme=dark" } });
    assert.deepEqual(f.log.extraHeaders, { "Accept-Language": "de" });
    // Host-only: a url and no domain.
    assert.deepEqual(f.log.cookies, [
      { name: "sid", value: "abc", url: "https://site.test" },
      { name: "theme", value: "dark", url: "https://site.test" },
    ]);
    assert.equal(f.log.interception, undefined);
    assert.equal(f.hasListener(), false);
  });

  test("Authorization turns interception on even when private networks are allowed, and stays on the target's origin", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, { url: target, headers: { Authorization: "Bearer T", "X-Keep": "1" } });
    assert.equal(f.log.interception, true);
    // Never browser-wide.
    assert.deepEqual(f.log.extraHeaders, { "X-Keep": "1" });

    assert.deepEqual(await f.fire("https://site.test/api", { navigation: true }), {
      type: "continue",
      arg: { headers: { accept: "*/*", authorization: "Bearer T" } },
    });
    assert.partialDeepStrictEqual(await f.fire("https://site.test/app.js"), { arg: { headers: { authorization: "Bearer T" } } });
    // Third parties and a redirect off the origin get a plain continue.
    assert.deepEqual(await f.fire("https://cdn.example/lib.js"), { type: "continue", arg: undefined });
    assert.deepEqual(await f.fire("https://elsewhere.test/landing", { navigation: true }), { type: "continue", arg: undefined });
  });

  test("behind a proxy the caller's Proxy-Authorization is dropped, not sent to the target; Authorization stays", async () => {
    const headers = { Authorization: "Bearer T", "Proxy-Authorization": "Basic Zm9vOmJhcg==" };
    const direct = fakePage();
    await applyRequestPolicies(direct.page, { url: target, headers });
    assert.partialDeepStrictEqual(await direct.fire("https://site.test/"), {
      arg: { headers: { authorization: "Bearer T", "proxy-authorization": "Basic Zm9vOmJhcg==" } },
    });
    const proxied = fakePage();
    await applyRequestPolicies(proxied.page, { url: target, headers, viaProxy: true });
    const call = await proxied.fire("https://site.test/");
    assert.partialDeepStrictEqual(call.arg, { headers: { authorization: "Bearer T" } });
    assert.ok(!JSON.stringify(call.arg).includes("proxy-authorization"));
  });

  test("a Cookie header is never passed back to the browser", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, { url: target, headers: { Authorization: "Bearer T" } });
    const call = await f.fire("https://site.test/", { headers: { cookie: "sid=trunc", accept: "*/*" } });
    assert.deepEqual(call.arg, { headers: { accept: "*/*", authorization: "Bearer T" } });
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
    assert.equal(f.log.interception, true);
    assert.deepEqual(await f.fire("https://site.test/a"), { type: "continue", arg: undefined });
    assert.deepEqual(await f.fire("https://site.test/b"), { type: "continue", arg: undefined });
    assert.deepEqual(await f.fire("http://10.0.0.5/x.png"), { type: "abort", arg: "blockedbyclient" });
    assert.deepEqual(await f.fire("http://10.0.0.5/page", { navigation: true }), { type: "abort", arg: "blockedbyclient" });
    assert.deepEqual(await f.fire("http://10.0.0.5/frame", { navigation: true, frame: {} }), { type: "abort", arg: "blockedbyclient" });
    assert.deepEqual(asked, ["https://site.test", "http://10.0.0.5"]);
    assert.deepEqual(applied.blockedNavigations, ["http://10.0.0.5/page"]);
  });

  test("the guard runs before the credentials: a refused origin never gets them", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, { url: target, headers: { Authorization: "Bearer T" }, requestGuard: async () => false });
    assert.deepEqual(await f.fire("https://site.test/", { navigation: true }), { type: "abort", arg: "blockedbyclient" });
  });

  test("data:, blob: and about: pass untouched; other schemes and bad URLs are aborted", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, { url: target, headers: { Authorization: "Bearer T" } });
    assert.deepEqual(await f.fire("data:text/plain,hi"), { type: "continue", arg: undefined });
    assert.deepEqual(await f.fire("about:blank"), { type: "continue", arg: undefined });
    assert.deepEqual(await f.fire("ftp://site.test/x"), { type: "abort", arg: "blockedbyclient" });
    assert.deepEqual(await f.fire("not a url"), { type: "abort", arg: "blockedbyclient" });
  });

  test("a browser without interception fails with 501 when a policy needs it", async () => {
    for (const opts of [{ requestGuard: async () => true }, { headers: { Authorization: "Bearer T" } }]) {
      const f = fakePage({ interceptable: false });
      const err = await applyRequestPolicies(f.page, { url: target, ...opts }).catch((e: unknown) => e);
      assertFields(err, { status: 501, code: "BROWSER_INTERCEPTION_UNSUPPORTED" });
    }
    const f = fakePage({ interceptable: false });
    const err = await applyRequestPolicies(f.page, { url: target, requestGuard: async () => true }).catch((e: unknown) => e);
    assert.ok((err as Error).message.includes("private-network protection"));
    assert.ok((err as Error).message.includes("--allow-private-network"));
    // Nothing to enforce, nothing to ask of the browser.
    await applyRequestPolicies(fakePage({ interceptable: false }).page, { url: target });
  });

  describe("ad and media blocking", () => {
    const adBlockList = AdBlockList.parse("ads.test\n");

    test("an ad list turns interception on and blocks its domains, even when private networks are allowed", async () => {
      const f = fakePage();
      const applied = await applyRequestPolicies(f.page, { url: target, adBlockList });
      assert.equal(f.log.interception, true);
      assert.deepEqual(await f.fire("https://ads.test/x.js"), { type: "abort", arg: "blockedbyclient" });
      assert.deepEqual(await f.fire("https://site.test/app.js"), { type: "continue", arg: undefined });
      assert.equal(applied.adsBlocked(), 1);
    });

    test("without a list (blockAds: false) there is no interception and nothing is blocked", async () => {
      const f = fakePage();
      const applied = await applyRequestPolicies(f.page, { url: target });
      assert.equal(f.hasListener(), false);
      assert.equal(applied.adsBlocked(), 0);
    });

    test("an ad is refused before the private-network guard is asked about it", async () => {
      const f = fakePage();
      const asked: string[] = [];
      await applyRequestPolicies(f.page, {
        url: target,
        adBlockList,
        requestGuard: async (origin) => {
          asked.push(origin);
          return true;
        },
      });
      assert.deepEqual(await f.fire("https://ads.test/x.js"), { type: "abort", arg: "blockedbyclient" });
      assert.deepEqual(asked, []);
      assert.partialDeepStrictEqual(await f.fire("https://site.test/app.js"), { type: "continue" });
      assert.deepEqual(asked, ["https://site.test"]);
    });

    test("blockMedia aborts images", async () => {
      const f = fakePage();
      await applyRequestPolicies(f.page, { url: target, blockMedia: true });
      assert.equal(f.log.interception, true);
      assert.deepEqual(await f.fire("https://site.test/pic.png", { type: "image" }), { type: "abort", arg: "blockedbyclient" });
      assert.deepEqual(await f.fire("https://site.test/clip.mp4", { type: "media" }), { type: "abort", arg: "blockedbyclient" });
      assert.partialDeepStrictEqual(await f.fire("https://site.test/app.js"), { type: "continue" });
    });

    test("a browser without interception goes without ad blocking instead of failing; a safeguard still fails", async () => {
      const f = fakePage({ interceptable: false });
      const applied = await applyRequestPolicies(f.page, { url: target, adBlockList, blockMedia: true });
      assert.equal(f.hasListener(), false);
      assert.equal(applied.adsBlocked(), 0);
      const err = await applyRequestPolicies(fakePage({ interceptable: false }).page, {
        url: target,
        adBlockList,
        requestGuard: async () => true,
      }).catch((e: unknown) => e);
      assertFields(err, { code: "BROWSER_INTERCEPTION_UNSUPPORTED" });
      // Only the safeguard is named.
      assert.ok((err as Error).message.includes("private-network protection"));
      assert.ok(!(err as Error).message.includes("ad blocking"));
    });
  });

  test("a browser without a cookie jar gets the Cookie header on the target's origin only", async () => {
    const f = fakePage({ cookies: false });
    await applyRequestPolicies(f.page, { url: target, headers: { Cookie: "sid=abc; theme=dark" } });
    assert.equal(f.log.interception, true);
    assert.partialDeepStrictEqual(await f.fire("https://site.test/", { navigation: true }), {
      arg: { headers: { cookie: "sid=abc; theme=dark" } },
    });
    assert.deepEqual(await f.fire("https://cdn.example/x.js"), { type: "continue", arg: undefined });
  });

  test("a throwing policy aborts the request instead of letting it through", async () => {
    const f = fakePage();
    await applyRequestPolicies(f.page, {
      url: target,
      requestGuard: async () => {
        throw new Error("resolver down");
      },
    });
    assert.deepEqual(await f.fire("https://site.test/"), { type: "abort", arg: "failed" });
  });
});
