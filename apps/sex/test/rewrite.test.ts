import { afterAll, describe, expect, test } from "bun:test";
import { testEngine } from "./helpers.ts";

describe("browser is skipped for files", () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("plain text body", { headers: { "content-type": "text/plain" } }),
  });
  // The CDP endpoint is dead: any attempt to use the browser fails.
  const engine = testEngine({ cdpUrl: "ws://127.0.0.1:1/" });
  afterAll(async () => {
    await engine.close();
    server.stop(true);
  });

  test("a .pdf URL is fetched over HTTP without touching the browser", async () => {
    const doc = await engine.scrape({ url: `http://127.0.0.1:${server.port}/file.pdf`, formats: ["markdown"] });
    expect(doc.markdown).toContain("plain text body");
  });

  test("an HTML URL still needs the browser", async () => {
    await expect(engine.scrape({ url: `http://127.0.0.1:${server.port}/page`, formats: ["markdown"] })).rejects.toBeDefined();
  });
});
