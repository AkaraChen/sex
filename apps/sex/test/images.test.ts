import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { testEngine } from "./helpers.ts";

const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

describe("image extraction", () => {
  let server: ReturnType<typeof Bun.serve>;
  const engine = testEngine();
  const url = () => `http://127.0.0.1:${server.port}/p`;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          `<!doctype html><html lang="en"><head><title>Images</title>
<meta property="og:image" content="https://cdn.example/one.png"><meta property="og:image" content="/two.png"></head>
<body><main><article><h1>Images</h1>
<p>${"Some body text about pictures. ".repeat(10)}</p>
<img src="${PLACEHOLDER}" data-src="/lazy.png" alt="lazy picture">
<img src="${PLACEHOLDER}" alt="inline only">
<img src="/plain.png" alt="plain picture">
</article></main></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    });
  });

  afterAll(() => server.stop(true));

  test("repeated og:image values become separate image URLs", async () => {
    const doc = await engine.scrape({ url: url(), formats: ["images"] });
    const origin = `http://127.0.0.1:${server.port}`;
    expect(doc.images).toContain("https://cdn.example/one.png");
    expect(doc.images).toContain(`${origin}/two.png`);
    expect(doc.images?.some((i) => i.includes(","))).toBe(false);
  });

  test("lazy-loaded images with a data: placeholder report their data-src", async () => {
    const doc = await engine.scrape({ url: url(), formats: ["images"] });
    expect(doc.images).toContain(`http://127.0.0.1:${server.port}/lazy.png`);
    expect(doc.images).toContain(`http://127.0.0.1:${server.port}/plain.png`);
  });

  test("removeBase64Images keeps lazy images (as their real URL) and drops inline-only ones", async () => {
    const doc = await engine.scrape({ url: url(), formats: ["markdown"], removeBase64Images: true });
    expect(doc.markdown).toContain("/lazy.png");
    expect(doc.markdown).not.toContain("data:image");
    expect(doc.markdown).not.toContain("inline only");
  });
});
