import { describe, expect, test } from "bun:test";
import { EgressPolicy, egressFor } from "../src/egress.ts";

/** A policy with a scripted resolver and a clock the test moves. */
function setup(answers: Record<string, string[][]>, allowPrivateNetwork = false) {
  const calls: string[] = [];
  let time = 1_000;
  const policy = new EgressPolicy({
    allowPrivateNetwork,
    now: () => time,
    resolver: async (host) => {
      calls.push(host);
      const queue = answers[host] ?? [[]];
      return (queue.length > 1 ? queue.shift() : queue[0]) as string[];
    },
  });
  return {
    policy,
    calls,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const url = (host: string) => new URL(`http://${host}/x`);

describe("EgressPolicy.resolve", () => {
  test("returns the validated addresses of a public name", async () => {
    const { policy } = setup({ "example.test": [["93.184.216.34", "2606:2800::1"]] });
    expect(await policy.resolve(url("example.test"))).toEqual(["93.184.216.34", "2606:2800::1"]);
  });

  test("refuses a name when any of its addresses is not public", async () => {
    const { policy } = setup({ "mixed.test": [["93.184.216.34", "10.0.0.5"]], "meta.test": [["169.254.169.254"]], "lo.test": [["::1"]] });
    for (const host of ["mixed.test", "meta.test", "lo.test"]) {
      await expect(policy.resolve(url(host))).rejects.toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED" });
    }
  });

  test("IP literals and localhost need no lookup", async () => {
    const { policy, calls } = setup({});
    expect(await policy.resolve(url("93.184.216.34"))).toEqual([]);
    expect(await policy.resolve(url("[2606:2800::1]"))).toEqual([]);
    for (const host of ["127.0.0.1", "[::1]", "169.254.169.254", "localhost", "app.localhost", "[::ffff:10.0.0.1]"]) {
      await expect(policy.resolve(url(host))).rejects.toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED" });
    }
    expect(calls).toEqual([]);
  });

  test("a name that does not resolve is let through, unless a proxy will resolve it", async () => {
    const { policy } = setup({});
    expect(await policy.resolve(url("nowhere.test"))).toEqual([]);
    await expect(policy.resolve(url("nowhere.test"), true)).rejects.toMatchObject({ code: "SCRAPE_DNS_RESOLUTION_ERROR" });
  });

  test("with private networks allowed nothing is checked or looked up", async () => {
    const { policy, calls } = setup({}, true);
    expect(await policy.resolve(url("127.0.0.1"))).toEqual([]);
    expect(await policy.resolve(url("localhost"))).toEqual([]);
    expect(await policy.resolve(url("anything.test"), true)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("allows() is resolve() as a boolean", async () => {
    const { policy } = setup({ "ok.test": [["93.184.216.34"]], "bad.test": [["127.0.0.1"]] });
    expect(await policy.allows(url("ok.test"))).toBe(true);
    expect(await policy.allows(url("bad.test"))).toBe(false);
    expect(await policy.allows(url("10.0.0.1"))).toBe(false);
  });
});

describe("EgressPolicy cache", () => {
  test("a host is looked up once within the TTL, concurrent callers share the lookup", async () => {
    const { policy, calls } = setup({ "a.test": [["93.184.216.34"]] });
    await Promise.all([policy.resolve(url("a.test")), policy.resolve(url("a.test")), policy.resolve(url("A.TEST"))]);
    await policy.resolve(url("a.test"));
    expect(calls).toEqual(["a.test"]);
  });

  test("after the TTL the name is looked up again, so a record that turned private is refused (rebinding)", async () => {
    const { policy, calls, advance } = setup({ "rebind.test": [["93.184.216.34"], ["127.0.0.1"]] });
    expect(await policy.resolve(url("rebind.test"))).toEqual(["93.184.216.34"]);
    advance(29_000);
    expect(await policy.resolve(url("rebind.test"))).toEqual(["93.184.216.34"]); // still the validated address
    advance(2_000);
    await expect(policy.resolve(url("rebind.test"))).rejects.toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED" });
    expect(calls).toEqual(["rebind.test", "rebind.test"]);
  });

  test("a name that did not resolve is asked again after a few seconds, not a whole TTL", async () => {
    const { policy, calls, advance } = setup({ "late.test": [[], ["93.184.216.34"]] });
    expect(await policy.resolve(url("late.test"))).toEqual([]);
    advance(1_000);
    expect(await policy.resolve(url("late.test"))).toEqual([]);
    advance(5_000);
    expect(await policy.resolve(url("late.test"))).toEqual(["93.184.216.34"]);
    expect(calls).toEqual(["late.test", "late.test"]);
  });

  test("a resolver that throws counts as not resolving", async () => {
    const policy = new EgressPolicy({
      allowPrivateNetwork: false,
      resolver: async () => {
        throw new Error("ESERVFAIL");
      },
    });
    expect(await policy.resolve(url("broken.test"))).toEqual([]);
    await expect(policy.resolve(url("broken.test"), true)).rejects.toMatchObject({ code: "SCRAPE_DNS_RESOLUTION_ERROR" });
  });

  test("the cache is bounded", async () => {
    const { policy, calls } = setup({});
    for (let i = 0; i < 1100; i++) await policy.resolve(url(`h${i}.test`));
    await policy.resolve(url("h0.test")); // evicted: looked up again
    expect(calls.filter((c) => c === "h0.test")).toHaveLength(2);
    await policy.resolve(url("h1099.test")); // still there
    expect(calls.filter((c) => c === "h1099.test")).toHaveLength(1);
  });
});

test("egressFor shares one policy per mode", () => {
  expect(egressFor(false)).toBe(egressFor(false));
  expect(egressFor(true)).not.toBe(egressFor(false));
  expect(egressFor(true).allowPrivateNetwork).toBe(true);
});
