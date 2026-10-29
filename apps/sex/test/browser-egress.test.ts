import { describe, expect, test } from "bun:test";
import { lightpandaArgv } from "../src/engine/browser.ts";
import { browserKind, contextProxy, isLoopbackHost, planEgress } from "../src/engine/browser-egress.ts";

describe("browserKind", () => {
  test("a spawned Lightpanda, a CDP browser on this machine, and one elsewhere", () => {
    expect(browserKind({})).toBe("lightpanda");
    for (const cdpUrl of ["http://127.0.0.1:9222", "ws://localhost:9222/devtools/browser/x", "http://[::1]:9222", "ws://127.0.0.5:1"]) {
      expect(browserKind({ cdpUrl })).toBe("local-cdp");
    }
    for (const cdpUrl of [
      "http://chrome:9222",
      "ws://10.0.0.5:9222",
      "wss://browser.example.com/cdp",
      "http://0.0.0.0:9222",
      "not a url",
    ]) {
      expect(browserKind({ cdpUrl })).toBe("remote-cdp");
    }
  });

  test("isLoopbackHost", () => {
    expect(["127.0.0.1", "localhost", "LOCALHOST", "foo.localhost", "[::1]", "::1"].map(isLoopbackHost)).toEqual(Array(6).fill(true));
    expect(["127.0.0.1.example.com", "192.168.1.2", "::2", "chrome"].map(isLoopbackHost)).toEqual(Array(4).fill(false));
  });
});

describe("planEgress: where each rule is enforced", () => {
  const strict = { checkPrivateNetwork: true };
  const open = { checkPrivateNetwork: false };
  const proxied = { checkPrivateNetwork: true, proxyUrl: "http://u:p@up.example:3128" };

  test("Lightpanda: its own flag for SSRF, CDP for ads, no proxy hop unless there is an upstream", () => {
    expect(planEgress("lightpanda", strict, true)).toMatchObject({ proxy: false, requestGuard: false, adsInCdp: true, adsInProxy: false });
    expect(planEgress("lightpanda", strict, false)).toMatchObject({ proxy: false, requestGuard: false, adsInCdp: false });
    expect(planEgress("lightpanda", open, true)).toMatchObject({ proxy: false });
  });

  test("Lightpanda behind SEX_PROXY_URL goes through the EgressProxy, which chains to the upstream and checks", () => {
    expect(planEgress("lightpanda", proxied, true)).toMatchObject({
      proxy: true,
      upstream: "http://u:p@up.example:3128",
      requestGuard: false,
      adsInCdp: true,
    });
    expect(lightpandaArgv("lp", 1, { concurrency: 1, allowPrivateNetwork: false, proxyUrl: "http://up:1" })).not.toContain(
      "--block-private-networks",
    );
    expect(lightpandaArgv("lp", 1, { concurrency: 1, allowPrivateNetwork: false })).toContain("--block-private-networks");
  });

  test("Chrome on this machine: EgressProxy for SSRF and ads, CDP interception not used for either", () => {
    expect(planEgress("local-cdp", strict, true)).toMatchObject({ proxy: true, adsInProxy: true, adsInCdp: false, requestGuard: false });
    expect(planEgress("local-cdp", strict, false)).toMatchObject({ proxy: true, adsInProxy: false, requestGuard: false });
    expect(planEgress("local-cdp", proxied, false)).toMatchObject({ proxy: true, upstream: "http://u:p@up.example:3128" });
  });

  test("Chrome on this machine, private networks allowed: proxied only for ads or an upstream", () => {
    expect(planEgress("local-cdp", open, false).proxy).toBe(false);
    expect(planEgress("local-cdp", open, true)).toMatchObject({ proxy: true, adsInProxy: true });
    expect(planEgress("local-cdp", { checkPrivateNetwork: false, proxyUrl: "http://up:1" }, false).proxy).toBe(true);
  });

  test("Chrome elsewhere falls back to the CDP request guard, ads by CDP, no EgressProxy", () => {
    expect(planEgress("remote-cdp", strict, true)).toEqual({
      kind: "remote-cdp",
      proxy: false,
      adsInProxy: false,
      requestGuard: true,
      adsInCdp: true,
    });
    expect(planEgress("remote-cdp", strict, false)).toMatchObject({ proxy: false, requestGuard: true, adsInCdp: false });
  });

  test("Chrome elsewhere, private networks allowed: no guard at all", () => {
    expect(planEgress("remote-cdp", open, false)).toMatchObject({ proxy: false, requestGuard: false });
  });

  test("Chrome elsewhere reaches SEX_PROXY_URL itself, with the guard still in front", () => {
    expect(planEgress("remote-cdp", proxied, false)).toMatchObject({
      proxy: false,
      requestGuard: true,
      direct: { server: "http://up.example:3128", credentials: { username: "u", password: "p" } },
    });
  });

  test("with private networks allowed nothing is checked on any path", () => {
    for (const kind of ["lightpanda", "local-cdp", "remote-cdp"] as const) {
      expect(planEgress(kind, open, false).requestGuard).toBe(false);
    }
  });
});

test("contextProxy splits the credentials from the server", () => {
  expect(contextProxy("http://proxy:3128")).toEqual({ server: "http://proxy:3128" });
  expect(contextProxy("https://us%40er:p%3Aw@proxy.example:8443/")).toEqual({
    server: "https://proxy.example:8443",
    credentials: { username: "us@er", password: "p:w" },
  });
});
