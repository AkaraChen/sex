import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { browserKind, contextProxy, isLoopbackHost, lightpandaArgv, planEgress } from "@searxng-js/sex-browser";

describe("browserKind", () => {
  test("a spawned Lightpanda, a CDP browser on this machine, and one elsewhere", () => {
    assert.equal(browserKind({}), "lightpanda");
    for (const cdpUrl of ["http://127.0.0.1:9222", "ws://localhost:9222/devtools/browser/x", "http://[::1]:9222", "ws://127.0.0.5:1"]) {
      assert.equal(browserKind({ cdpUrl }), "local-cdp");
    }
    for (const cdpUrl of [
      "http://chrome:9222",
      "ws://10.0.0.5:9222",
      "wss://browser.example.com/cdp",
      "http://0.0.0.0:9222",
      "not a url",
    ]) {
      assert.equal(browserKind({ cdpUrl }), "remote-cdp");
    }
  });

  test("isLoopbackHost", () => {
    assert.deepEqual(["127.0.0.1", "localhost", "LOCALHOST", "foo.localhost", "[::1]", "::1"].map(isLoopbackHost), Array(6).fill(true));
    assert.deepEqual(["127.0.0.1.example.com", "192.168.1.2", "::2", "chrome"].map(isLoopbackHost), Array(4).fill(false));
  });
});

describe("planEgress: where each rule is enforced", () => {
  const strict = { checkPrivateNetwork: true };
  const open = { checkPrivateNetwork: false };
  const proxied = { checkPrivateNetwork: true, proxyUrl: "http://u:p@up.example:3128" };

  test("Lightpanda: its own flag for SSRF, CDP for ads, no proxy hop unless there is an upstream", () => {
    assert.partialDeepStrictEqual(planEgress("lightpanda", strict, true), {
      proxy: false,
      requestGuard: false,
      adsInCdp: true,
      adsInProxy: false,
    });
    assert.partialDeepStrictEqual(planEgress("lightpanda", strict, false), { proxy: false, requestGuard: false, adsInCdp: false });
    assert.partialDeepStrictEqual(planEgress("lightpanda", open, true), { proxy: false });
  });

  test("Lightpanda behind SEX_PROXY_URL goes through the EgressProxy, which chains to the upstream and checks", () => {
    assert.partialDeepStrictEqual(planEgress("lightpanda", proxied, true), {
      proxy: true,
      upstream: "http://u:p@up.example:3128",
      requestGuard: false,
      adsInCdp: true,
    });
    assert.ok(
      !lightpandaArgv("lp", 1, { concurrency: 1, allowPrivateNetwork: false, proxyUrl: "http://up:1" }).includes(
        "--block-private-networks",
      ),
    );
    assert.ok(lightpandaArgv("lp", 1, { concurrency: 1, allowPrivateNetwork: false }).includes("--block-private-networks"));
  });

  test("Chrome on this machine: EgressProxy for SSRF and ads, CDP interception not used for either", () => {
    assert.partialDeepStrictEqual(planEgress("local-cdp", strict, true), {
      proxy: true,
      adsInProxy: true,
      adsInCdp: false,
      requestGuard: false,
    });
    assert.partialDeepStrictEqual(planEgress("local-cdp", strict, false), { proxy: true, adsInProxy: false, requestGuard: false });
    assert.partialDeepStrictEqual(planEgress("local-cdp", proxied, false), { proxy: true, upstream: "http://u:p@up.example:3128" });
  });

  test("Chrome on this machine, private networks allowed: proxied only for ads or an upstream", () => {
    assert.equal(planEgress("local-cdp", open, false).proxy, false);
    assert.partialDeepStrictEqual(planEgress("local-cdp", open, true), { proxy: true, adsInProxy: true });
    assert.equal(planEgress("local-cdp", { checkPrivateNetwork: false, proxyUrl: "http://up:1" }, false).proxy, true);
  });

  test("Chrome elsewhere falls back to the CDP request guard, ads by CDP, no EgressProxy", () => {
    assert.deepEqual(planEgress("remote-cdp", strict, true), {
      kind: "remote-cdp",
      proxy: false,
      adsInProxy: false,
      requestGuard: true,
      adsInCdp: true,
    });
    assert.partialDeepStrictEqual(planEgress("remote-cdp", strict, false), { proxy: false, requestGuard: true, adsInCdp: false });
  });

  test("Chrome elsewhere, private networks allowed: no guard at all", () => {
    assert.partialDeepStrictEqual(planEgress("remote-cdp", open, false), { proxy: false, requestGuard: false });
  });

  test("Chrome elsewhere reaches SEX_PROXY_URL itself, with the guard still in front", () => {
    assert.partialDeepStrictEqual(planEgress("remote-cdp", proxied, false), {
      proxy: false,
      requestGuard: true,
      direct: { server: "http://up.example:3128", credentials: { username: "u", password: "p" } },
    });
  });

  test("with private networks allowed nothing is checked on any path", () => {
    for (const kind of ["lightpanda", "local-cdp", "remote-cdp"] as const) {
      assert.equal(planEgress(kind, open, false).requestGuard, false);
    }
  });
});

test("contextProxy splits the credentials from the server", () => {
  assert.deepEqual(contextProxy("http://proxy:3128"), { server: "http://proxy:3128" });
  assert.deepEqual(contextProxy("https://us%40er:p%3Aw@proxy.example:8443/"), {
    server: "https://proxy.example:8443",
    credentials: { username: "us@er", password: "p:w" },
  });
});
