import { afterAll, beforeAll, expect, test } from "bun:test";
import { createClient, LocalError } from "../src/client.ts";

let server: ReturnType<typeof Bun.serve>;
const bodies: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok");
      const body = request.method === "POST" ? await request.text() : "";
      bodies.push(body);
      if (request.headers.get("authorization") !== "Bearer secret") {
        return Response.json({ success: false, error: "unauthorized" }, { status: 401 });
      }
      if (url.pathname === "/v2/parse") return Response.json({ success: true, data: { markdown: "# doc" } });
      if (body.includes('"slow"')) await new Promise((resolve) => setTimeout(resolve, 200));
      if (body.includes('"bad"')) {
        return Response.json({ success: false, error: "Invalid URL", code: "BAD_REQUEST" }, { status: 400 });
      }
      return Response.json({ success: true, data: { markdown: "# hi" } });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

const base = () => server.url.origin;

test("scrape sends the token and reads the JSON body", async () => {
  const client = createClient({ baseUrl: `${base()}/`, token: "secret" });
  const response = await client.scrape({ url: "https://example.com" });
  expect(response.success).toBe(true);
  expect(response.data?.markdown).toBe("# hi");
  expect(bodies.at(-1)).toContain('"url":"https://example.com"');
});

test("a non-2xx answer becomes a LocalError with its code", async () => {
  const client = createClient({ baseUrl: base(), token: "secret" });
  const error = await client.scrape({ url: "https://example.com", bad: true }).catch((err) => err);
  expect(error).toBeInstanceOf(LocalError);
  expect(error.status).toBe(400);
  expect(error.code).toBe("BAD_REQUEST");
});

test("a missing token is a 401 from the child", async () => {
  const client = createClient({ baseUrl: base() });
  const error = await client.scrape({ url: "https://example.com" }).catch((err) => err);
  expect(error).toBeInstanceOf(LocalError);
  expect(error.status).toBe(401);
});

test("the client's timeout aborts the request", async () => {
  const client = createClient({ baseUrl: base(), token: "secret", timeoutMs: 50 });
  const error = await client.scrape({ url: "https://example.com", slow: true }).catch((err) => err);
  expect(error).toBeInstanceOf(LocalError);
  expect(error.code).toBe("TIMEOUT");
});

test("an unreachable child is LOCAL_UNAVAILABLE", async () => {
  const client = createClient({ baseUrl: "http://127.0.0.1:9", token: "secret" });
  const error = await client.scrape({ url: "https://example.com" }).catch((err) => err);
  expect(error).toBeInstanceOf(LocalError);
  expect(error.code).toBe("LOCAL_UNAVAILABLE");
});

test("parse sends the file and its name as multipart", async () => {
  const client = createClient({ baseUrl: base(), token: "secret" });
  const response = await client.parse(new File(["hello"], "upload.txt"), { formats: ["markdown"] });
  expect(response.data?.markdown).toBe("# doc");
  expect(bodies.at(-1)).toContain("upload.txt");
  expect(bodies.at(-1)).toContain('"formats"');
});
