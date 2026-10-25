import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveConfig } from "../src/config.ts";
import type { Engine } from "../src/core/engine.ts";
import { AppError } from "../src/errors.ts";
import { createApp } from "../src/http/server.ts";
import { type McpRunning, serveMcp } from "../src/mcp/server.ts";
import { testEngine } from "./helpers.ts";

const engines: Engine[] = [];
const make = (overrides: Parameters<typeof testEngine>[0] = {}) => {
  const engine = testEngine(overrides);
  engines.push(engine);
  return engine;
};

afterAll(async () => {
  await Promise.all(engines.map((e) => e.close()));
});

describe("config", () => {
  test("CORS and Host allowlists default to empty", () => {
    const config = resolveConfig({}, { allowPrivateNetwork: false }, {});
    expect(config.corsOrigins).toEqual([]);
    expect(config.allowedHosts).toEqual([]);
  });

  test("origins and hostnames parse from comma-separated values", () => {
    const config = resolveConfig(
      { corsOrigins: "https://App.example.com/, http://localhost:3000", allowedHosts: "Sex.example.com" },
      { allowPrivateNetwork: false },
      {},
    );
    expect(config.corsOrigins).toEqual(["https://app.example.com", "http://localhost:3000"]);
    expect(config.allowedHosts).toEqual(["sex.example.com"]);
  });

  test("origins with a path and hosts with a port are rejected", () => {
    expect(() => resolveConfig({ corsOrigins: "https://app.example.com/path" }, { allowPrivateNetwork: false }, {})).toThrow(AppError);
    expect(() => resolveConfig({ allowedHosts: "sex.example.com:3002" }, { allowPrivateNetwork: false }, {})).toThrow(AppError);
    expect(() => resolveConfig({}, { allowPrivateNetwork: false }, { SEX_CORS_ORIGINS: "ftp://x.example" })).toThrow(
      "SEX_CORS_ORIGINS must be",
    );
  });
});

describe("http origin and host checks", () => {
  const app = createApp(make());

  test("a cross-site Origin is refused", async () => {
    const res = await app.fetch(new Request("http://sex.test/v2/crawl/x", { headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ success: false, code: "ORIGIN_NOT_ALLOWED" });
  });

  test("requests without Origin, or with the same host as Origin, reach the router", async () => {
    const none = await app.fetch(new Request("http://sex.test/v2/crawl/x"));
    expect(none.status).toBe(404);
    const same = await app.fetch(new Request("http://sex.test/v2/crawl/x", { headers: { origin: "http://sex.test" } }));
    expect(same.status).toBe(404);
  });

  test("no CORS headers are sent unless corsOrigins is configured", async () => {
    const res = await app.fetch(new Request("http://sex.test/health", { headers: { origin: "http://sex.test" } }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("http cors allowlist", () => {
  const app = createApp(make({ corsOrigins: "https://app.example" }));

  test("preflight from an allowed origin gets that origin back", async () => {
    const res = await app.fetch(
      new Request("http://sex.test/v2/scrape", {
        method: "OPTIONS",
        headers: { origin: "https://app.example", "access-control-request-method": "POST" },
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  test("an origin outside the allowlist is refused", async () => {
    const res = await app.fetch(
      new Request("http://sex.test/v2/scrape", {
        method: "OPTIONS",
        headers: { origin: "https://other.example", "access-control-request-method": "POST" },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("http host checks", () => {
  const app = createApp(make(), { bindHost: "127.0.0.1" });

  test("a foreign Host is refused when bound to loopback", async () => {
    const res = await app.fetch(new Request("http://127.0.0.1:3002/v2/crawl/x", { headers: { host: "attacker.example" } }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ success: false, code: "HOST_NOT_ALLOWED" });
  });

  test("localhost names pass when bound to loopback", async () => {
    const res = await app.fetch(new Request("http://localhost:3002/v2/crawl/x", { headers: { host: "localhost:3002" } }));
    expect(res.status).toBe(404);
  });

  test("allowedHosts replaces the loopback default", async () => {
    const custom = createApp(make({ allowedHosts: "sex.example.com" }), { bindHost: "127.0.0.1" });
    const ok = await custom.fetch(new Request("http://sex.example.com/v2/crawl/x", { headers: { host: "sex.example.com" } }));
    expect(ok.status).toBe(404);
    const bad = await custom.fetch(new Request("http://localhost:3002/v2/crawl/x", { headers: { host: "localhost:3002" } }));
    expect(bad.status).toBe(403);
    expect(await bad.json()).toMatchObject({ code: "HOST_NOT_ALLOWED" });
  });
});

describe("mcp origin check", () => {
  let server: McpRunning;
  let port: number;

  beforeAll(async () => {
    port = 42000 + Math.floor(Math.random() * 1000);
    server = await serveMcp(make(), { transport: "http", port, host: "127.0.0.1", stateless: true });
  });

  afterAll(async () => {
    await server.stop();
  });

  test("a cross-site Origin is refused on /mcp", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ success: false, code: "ORIGIN_NOT_ALLOWED" });
  });

  test("clients without Origin still list tools", async () => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  });
});
