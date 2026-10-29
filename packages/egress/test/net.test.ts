import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { assertPublicUrl, isPrivateIp, safeFetch } from "@searxng-js/sex-egress";

const hostOf = (u: string) => new URL(u).hostname.replace(/^\[|\]$/g, "");

/** The fields of `actual` named in `expected` must equal it. */
const matches = (actual: unknown, expected: Record<string, unknown>) =>
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((k) => [k, (actual as Record<string, unknown>)[k]])), expected);
const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

const BLOCKED = [
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:169.254.169.254]/",
  "http://[::127.0.0.1]/",
  "http://[64:ff9b::7f00:1]/",
  "http://[2002:7f00:1::]/",
  "http://[2001::1]/",
  "http://[::1]/",
  "http://[fd00::1]/",
  "http://[fe80::1]/",
  "http://127.0.0.1/",
  "http://10.0.0.1/",
  "http://100.64.0.1/",
  "http://0x7f000001/",
];

const ALLOWED = ["http://8.8.8.8/", "http://[2606:4700::1111]/", "http://[64:ff9b::808:808]/"];

describe("isPrivateIp via URL-parsed hosts", () => {
  for (const u of BLOCKED) {
    test(`blocks ${u}`, async () => {
      assert.equal(isPrivateIp(hostOf(u)), true);
      matches(await caught(assertPublicUrl(new URL(u), false)), { code: "PRIVATE_NETWORK_BLOCKED" });
    });
  }

  for (const u of ALLOWED) {
    test(`allows ${u}`, async () => {
      assert.equal(isPrivateIp(hostOf(u)), false);
      assert.equal(await assertPublicUrl(new URL(u), false), undefined);
    });
  }
});

describe("safeFetch end-to-end", () => {
  let server: Server;
  let port: number;
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/hang") return; // never answers
      res.end("internal");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  const options = (signal: AbortSignal) => ({ signal, allowPrivateNetwork: false, proxy: undefined, userAgent: "t" });

  test("refuses loopback reached through the hex IPv4-mapped IPv6 form", async () => {
    const err = await caught(safeFetch(`http://[::ffff:127.0.0.1]:${port}/`, options(AbortSignal.timeout(3000))));
    matches(err, { code: "PRIVATE_NETWORK_BLOCKED" });
  });

  test("fetches when private networks are allowed", async () => {
    const res = await safeFetch(`http://127.0.0.1:${port}/`, { ...options(AbortSignal.timeout(3000)), allowPrivateNetwork: true });
    assert.equal(res.status, 200);
    assert.equal(new TextDecoder().decode(res.body), "internal");
  });

  test("a body over maxBodyBytes is RESPONSE_TOO_LARGE", async () => {
    const err = await caught(
      safeFetch(`http://127.0.0.1:${port}/`, { ...options(AbortSignal.timeout(3000)), allowPrivateNetwork: true, maxBodyBytes: 3 }),
    );
    matches(err, { code: "RESPONSE_TOO_LARGE" });
  });

  test("a signal that timed out is SCRAPE_TIMEOUT, one the caller aborted is TIMEOUT", async () => {
    const opts = { ...options(AbortSignal.timeout(100)), allowPrivateNetwork: true };
    matches(await caught(safeFetch(`http://127.0.0.1:${port}/hang`, opts)), { code: "SCRAPE_TIMEOUT" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    matches(await caught(safeFetch(`http://127.0.0.1:${port}/hang`, { ...opts, signal: controller.signal })), { code: "TIMEOUT" });
  });

  test("an already aborted signal does not connect", async () => {
    matches(await caught(safeFetch(`http://127.0.0.1:${port}/`, { ...options(AbortSignal.abort()), allowPrivateNetwork: true })), {
      code: "TIMEOUT",
    });
  });
});
