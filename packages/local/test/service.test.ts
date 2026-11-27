import { afterAll, beforeAll, expect, test } from "bun:test";
import { LocalError } from "../src/client.ts";
import { LocalService } from "../src/service.ts";

let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok");
      const body = request.method === "POST" ? await request.text() : "";
      if (request.headers.get("authorization") !== "Bearer secret") {
        return Response.json({ success: false, error: "unauthorized" }, { status: 401 });
      }
      if (body.includes('"slow"')) await new Promise((resolve) => setTimeout(resolve, 200));
      return Response.json({ success: true, data: { markdown: "# hi" } });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

const base = () => server.url.origin;

test("client() forwards timeoutMs to createClient", async () => {
  const service = new LocalService({ url: base(), token: "secret", timeoutMs: 50 });
  const client = await service.client();
  const error = await client.scrape({ url: "https://example.com", slow: true }).catch((err) => err);
  expect(error).toBeInstanceOf(LocalError);
  expect(error.code).toBe("TIMEOUT");
  expect(error.status).toBe(499);
});

test("client() keeps the default timeout when timeoutMs is not specified", async () => {
  const service = new LocalService({ url: base(), token: "secret" });
  const client = await service.client();
  const response = await client.scrape({ url: "https://example.com", slow: true });
  expect(response.success).toBe(true);
  expect(response.data?.markdown).toBe("# hi");
});
