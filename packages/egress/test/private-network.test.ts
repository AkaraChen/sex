// A private-network allowlist: what it opens, what stays closed whatever it says, and that the checks and pinning hold.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import {
  EgressPolicy,
  egressFor,
  type PrivateNetworkAllowlist,
  parseAllowEntry,
  parsePrivateNetworkAllowlist,
  safeFetch,
} from "@searxng-js/sex-egress";

/** A policy with an allowlist, a scripted resolver (each host's answers in turn) and a clock the test moves. */
function setup(list: PrivateNetworkAllowlist, answers: Record<string, string[][]> = {}) {
  let time = 1_000;
  const policy = new EgressPolicy({
    allowPrivateNetwork: list,
    now: () => time,
    resolver: async (host) => {
      const queue = answers[host] ?? [[]];
      return (queue.length > 1 ? queue.shift() : queue[0]) as string[];
    },
  });
  return {
    policy,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const refusal = async (promise: Promise<unknown>) => {
  const err = await promise.then(
    () => assert.fail("was not refused"),
    (e: unknown) => e as { code: string; details: { reason: string } },
  );
  assert.equal(err.code, "PRIVATE_NETWORK_BLOCKED");
  return err.details.reason;
};

describe("allowlist: networks", () => {
  const { policy } = setup({ allow: ["192.168.1.0/24", "fd12:3456::/32", "10.0.0.5:8080"] });

  test("an address in a listed network is allowed; one outside is refused", async () => {
    assert.deepEqual(await policy.resolve(new URL("http://192.168.1.20/")), []);
    assert.equal(await refusal(policy.resolve(new URL("http://192.168.2.20/"))), "private");
    assert.equal(await refusal(policy.resolve(new URL("http://10.1.1.1/"))), "private");
  });

  test("IPv6 networks, and IPv4 embedded in IPv6 judged as IPv4", async () => {
    assert.deepEqual(await policy.resolve(new URL("http://[fd12:3456::9]/")), []);
    assert.equal(await refusal(policy.resolve(new URL("http://[fd99::9]/"))), "private");
    assert.deepEqual(await policy.resolve(new URL("http://[::ffff:192.168.1.7]/")), []);
    assert.equal(await refusal(policy.resolve(new URL("http://[::ffff:192.168.9.7]/"))), "private");
    assert.deepEqual(await policy.resolve(new URL("http://[64:ff9b::c0a8:0107]/")), []); // NAT64 of 192.168.1.7
  });

  test("a port on an entry opens that port only (the scheme's default when the URL has none)", async () => {
    assert.deepEqual(await policy.resolve(new URL("http://10.0.0.5:8080/")), []);
    assert.equal(await refusal(policy.resolve(new URL("http://10.0.0.5/"))), "private");
    assert.equal(await refusal(policy.resolve(new URL("http://10.0.0.5:8081/"))), "private");
    const web = setup({ allow: ["10.0.0.5:443"] }).policy;
    assert.deepEqual(await web.resolve(new URL("https://10.0.0.5/")), []);
    assert.equal(await refusal(web.resolve(new URL("http://10.0.0.5/"))), "private");
  });

  test("public addresses stay allowed", async () => {
    assert.deepEqual(await policy.resolve(new URL("http://93.184.216.34/")), []);
  });
});

describe("allowlist: host names", () => {
  test("a listed name may resolve to private addresses, which are returned for pinning", async () => {
    const { policy } = setup(
      { allow: ["docs.corp.internal", "*.lab.internal"] },
      { "docs.corp.internal": [["10.20.0.4"]], "wiki.lab.internal": [["10.30.0.9"]], "other.internal": [["10.20.0.4"]] },
    );
    assert.deepEqual(await policy.resolve(new URL("http://docs.corp.internal/a")), ["10.20.0.4"]);
    assert.deepEqual(await policy.resolve(new URL("http://wiki.lab.internal/")), ["10.30.0.9"]);
    // The same address under a name that is not listed (and no network names it) is refused.
    assert.equal(await refusal(policy.resolve(new URL("http://other.internal/"))), "private");
  });

  test("a wildcard does not match the name itself", async () => {
    const { policy } = setup({ allow: ["*.lab.internal"] }, { "lab.internal": [["10.30.0.1"]] });
    assert.equal(await refusal(policy.resolve(new URL("http://lab.internal/"))), "private");
  });
});

describe("never allowed, whatever the list says", () => {
  const { policy } = setup({ allow: ["0.0.0.0/0", "::/0", "meta.internal"], loopback: true }, { "meta.internal": [["169.254.169.254"]] });

  test("cloud metadata and link-local addresses", async () => {
    for (const host of [
      "169.254.169.254",
      "169.254.170.2",
      "169.254.1.1",
      "[fe80::1]",
      "[fd00:ec2::254]",
      "100.100.100.200",
      "168.63.129.16",
      "[::ffff:169.254.169.254]",
    ]) {
      assert.equal(await refusal(policy.resolve(new URL(`http://${host}/`))), "never", host);
    }
  });

  test("a listed name that resolves to a metadata address", async () => {
    assert.equal(await refusal(policy.resolve(new URL("http://meta.internal/"))), "never");
  });

  test("without an allowlist too", async () => {
    assert.equal(await refusal(egressFor(false).resolve(new URL("http://168.63.129.16/"))), "never");
  });
});

describe("loopback: only with its switch", () => {
  test("off: loopback addresses and localhost are refused, even when the list names them by network", async () => {
    const { policy } = setup({ allow: ["0.0.0.0/0", "::/0"] }, { localhost: [["127.0.0.1"]] });
    for (const host of ["127.0.0.1", "127.8.9.10", "[::1]", "0.0.0.0", "localhost", "app.localhost", "[::ffff:127.0.0.1]"]) {
      assert.equal(await refusal(policy.resolve(new URL(`http://${host}:11434/`))), "loopback", host);
    }
  });

  test("on: loopback is allowed on any port; other private addresses still need a rule", async () => {
    const { policy } = setup({ allow: [], loopback: true }, { localhost: [["127.0.0.1", "::1"]] });
    assert.deepEqual(await policy.resolve(new URL("http://127.0.0.1:11434/")), []);
    assert.deepEqual(await policy.resolve(new URL("http://localhost:8080/")), ["127.0.0.1", "::1"]);
    assert.equal(await refusal(policy.resolve(new URL("http://192.168.1.1/"))), "private");
  });
});

describe("rebinding: every answer is checked again", () => {
  test("a listed name that later resolves outside the list is refused", async () => {
    const { policy, advance } = setup({ allow: ["10.1.0.0/16"] }, { "app.test": [["10.1.2.3"], ["10.9.9.9"]] });
    assert.deepEqual(await policy.resolve(new URL("http://app.test/")), ["10.1.2.3"]);
    advance(60_000);
    assert.equal(await refusal(policy.resolve(new URL("http://app.test/"))), "private");
  });

  test("a public name that later resolves to a private or metadata address is refused", async () => {
    const { policy, advance } = setup(
      { allow: ["10.1.0.0/16"] },
      { "evil.test": [["93.184.216.34"], ["192.168.0.1"], ["169.254.169.254"]] },
    );
    assert.deepEqual(await policy.resolve(new URL("http://evil.test/")), ["93.184.216.34"]);
    advance(60_000);
    assert.equal(await refusal(policy.resolve(new URL("http://evil.test/"))), "private");
    advance(60_000);
    assert.equal(await refusal(policy.resolve(new URL("http://evil.test/"))), "never");
  });

  test("one address outside the list among several refuses the name", async () => {
    const { policy } = setup({ allow: ["10.1.0.0/16"] }, { "mixed.test": [["10.1.0.1", "10.2.0.1"]] });
    assert.equal(await refusal(policy.resolve(new URL("http://mixed.test/"))), "private");
  });
});

describe("parsing entries", () => {
  test("accepted forms", () => {
    for (const entry of [
      "10.0.0.0/8",
      "10.0.0.5",
      "10.0.0.5:8080",
      "10.0.0.0/8:22",
      "fd00::/8",
      "[fd00::1]:443",
      "[fd00::/16]:80",
      "docs.corp.internal",
      "Docs.Corp.Internal.",
      "*.corp.internal:8443",
      "nas",
      "build_server.lan",
    ]) {
      assert.ok(!("message" in parseAllowEntry(entry)), entry);
    }
  });

  test("refused forms, each with a reason", () => {
    for (const entry of [
      "",
      "http://10.0.0.1/",
      "10.0.0.0/33",
      "10.0.0.1:0",
      "10.0.0.1:70000",
      "10.0.0.1:x",
      "fd00::/129",
      "[fd00::1",
      "a b",
      "*.",
      "-bad.lan",
      "localhost",
      "127.0.0.1",
      "::1",
      "169.254.169.254",
      "169.254.0.0/16",
      "fe80::/10",
      "1.2.3.4/8/9",
    ]) {
      const parsed = parseAllowEntry(entry);
      assert.ok("message" in parsed && parsed.message.length > 0, entry);
    }
  });

  test("each refusal names its reason", () => {
    const reasons = Object.fromEntries(
      ["http://10.0.0.1/", "10.0.0.1:0", "10.0.0.0/33", "169.254.0.0/16", "localhost", "::1", "a b"].map((entry) => {
        const parsed = parseAllowEntry(entry);
        return [entry, "reason" in parsed ? parsed.reason : undefined];
      }),
    );
    assert.deepEqual(reasons, {
      "http://10.0.0.1/": "url",
      "10.0.0.1:0": "port",
      "10.0.0.0/33": "prefix",
      "169.254.0.0/16": "never",
      localhost: "loopback",
      "::1": "loopback",
      "a b": "syntax",
    });
  });

  test("a network wider than link-local or loopback is accepted (those addresses stay refused when checked)", () => {
    assert.ok(!("message" in parseAllowEntry("0.0.0.0/0")));
    assert.ok(!("message" in parseAllowEntry("169.0.0.0/8")));
  });

  test("a wrong entry is reported and the others still apply", async () => {
    const list = { allow: ["10.0.0.0/33", "192.168.1.0/24", 42 as unknown as string] };
    const parsed = parsePrivateNetworkAllowlist(list);
    assert.deepEqual(
      parsed.errors.map((e) => e.entry),
      ["10.0.0.0/33", "42"],
    );
    assert.equal(parsed.rules.length, 1);
    const { policy } = setup(list);
    assert.deepEqual(await policy.resolve(new URL("http://192.168.1.9/")), []);
    assert.equal(await refusal(policy.resolve(new URL("http://10.0.0.1/"))), "private");
  });
});

describe("safeFetch with an allowlist", () => {
  let server: Server;
  let port: number;
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/to-private") res.writeHead(302, { location: "http://10.255.0.1/" }).end();
      else if (req.url === "/to-metadata") res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      else if (req.url === "/to-self") res.writeHead(302, { location: `http://127.0.0.1:${port}/ok` }).end();
      else res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => server.close());

  const fetchWith = (path: string, allowPrivateNetwork: PrivateNetworkAllowlist) =>
    safeFetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(5_000),
      allowPrivateNetwork,
      proxy: undefined,
      userAgent: "test",
    });

  test("loopback is fetched with the switch on, refused with it off", async () => {
    const res = await fetchWith("/to-self", { allow: [], loopback: true });
    assert.equal(new TextDecoder().decode(res.body), "ok");
    assert.equal(await refusal(fetchWith("/", { allow: ["0.0.0.0/0"] })), "loopback");
  });

  test("a redirect to a private address outside the list is refused", async () => {
    assert.equal(await refusal(fetchWith("/to-private", { allow: ["192.168.0.0/16"], loopback: true })), "private");
  });

  test("a redirect to a metadata address is refused even when listed", async () => {
    assert.equal(await refusal(fetchWith("/to-metadata", { allow: ["169.0.0.0/8"], loopback: true })), "never");
  });
});
