import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assertPublicUrl, isPrivateIp, safeFetch } from "../src/core/net.ts";

const hostOf = (u: string) => new URL(u).hostname.replace(/^\[|\]$/g, "");

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
      expect(isPrivateIp(hostOf(u))).toBe(true);
      const err = await assertPublicUrl(new URL(u), false).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED" });
    });
  }

  for (const u of ALLOWED) {
    test(`allows ${u}`, async () => {
      expect(isPrivateIp(hostOf(u))).toBe(false);
      await expect(assertPublicUrl(new URL(u), false)).resolves.toBeUndefined();
    });
  }
});

describe("safeFetch end-to-end", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("internal") });
  });
  afterAll(() => {
    server.stop(true);
  });

  test("refuses loopback reached through the hex IPv4-mapped IPv6 form", async () => {
    const err = await safeFetch(`http://[::ffff:127.0.0.1]:${server.port}/`, {
      timeout: 3000,
      allowPrivateNetwork: false,
      userAgent: "t",
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: "PRIVATE_NETWORK_BLOCKED" });
  });
});
