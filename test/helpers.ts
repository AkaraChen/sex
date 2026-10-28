import { type ConfigOverrides, resolveConfig } from "../src/config.ts";
import { Engine } from "../src/core/engine.ts";

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="About ${title}"><meta property="og:title" content="${title} OG">
</head><body><nav><a href="/">Home</a> <a href="/docs/a">A</a></nav>
<main><article><h1>${title}</h1>${body}</article></main><footer>footer text</footer></body></html>`;

const paragraphs = (topic: string) =>
  Array.from({ length: 4 }, (_, i) => `<p>Paragraph ${i + 1} about ${topic}. ${"Lorem ipsum dolor sit amet. ".repeat(8)}</p>`).join("");

// Throwaway self-signed certificate for localhost / 127.0.0.1 (test fixture only).
export const CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUcK2B/nZ/V1i/94gceqNkDbfZ0WMwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyNTE0MjEyMloYDzIxMjYxMDAx
MTQyMTIyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQdLtMTE3HiHuXUFKrJab17zxVxWMOLxOwNs2OFbeTm/yFPpDddITJS
+ZOmK4Mq2cVEIxiP5/U3Egn/EnjnT4F4o28wbTAdBgNVHQ4EFgQUa2l4M/yUi+3y
4sUjQgbqNgniE5MwHwYDVR0jBBgwFoAUa2l4M/yUi+3y4sUjQgbqNgniE5MwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIgHiq/3W41m/lnQsAM3ixZlYIfSfTn/XIvV/s83GYIa5kCIQCR
tUbyO/u9ZV5j9oRx95bDP7s1F+/sK2D6d0rx5Xo6pg==
-----END CERTIFICATE-----
`;
export const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJVB4a/Q2SjNcJ64B
y89h6w4xR6WqdZm2vZadjEz4RrehRANCAAQdLtMTE3HiHuXUFKrJab17zxVxWMOL
xOwNs2OFbeTm/yFPpDddITJS+ZOmK4Mq2cVEIxiP5/U3Egn/EnjnT4F4
-----END PRIVATE KEY-----
`;

/** A tiny local website: /, /docs/a, /docs/b, /private/x, robots.txt, sitemap.xml, JSON. */
export function startFixtureSite() {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const html = (s: string) => new Response(s, { headers: { "content-type": "text/html; charset=utf-8" } });
      switch (pathname) {
        case "/":
          return html(
            page(
              "Home",
              `${paragraphs("home")}<p><a href="/docs/a">Doc A</a> <a href="/docs/b">Doc B</a> <a href="/private/x">Private</a></p>`,
            ),
          );
        case "/docs/a":
          return html(page("Doc A", `${paragraphs("doc a")}<a href="/docs/b">next</a><img src="/img/a.png">`));
        case "/docs/b":
          return html(page("Doc B", paragraphs("doc b")));
        case "/private/x":
          return html(page("Private", paragraphs("secret")));
        case "/robots.txt":
          return new Response("User-agent: *\nDisallow: /private/\nSitemap: /sitemap.xml\n");
        case "/sitemap.xml":
          return new Response(
            `<?xml version="1.0"?><urlset><url><loc>${new URL("/docs/b", req.url).href}</loc></url><url><loc>${new URL("/docs/c", req.url).href}</loc></url></urlset>`,
            { headers: { "content-type": "application/xml" } },
          );
        case "/data.json":
          return Response.json({ hello: "world" });
        case "/redirect":
          return Response.redirect(new URL("/docs/a", req.url).href, 302);
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** A streamed (SSE) /chat/completions response carrying `content` (or a `refusal`), ending with `finishReason`. */
export function chatCompletionStream(content: string, opts: { finishReason?: string; refusal?: string } = {}): Response {
  const delta = opts.refusal ? { role: "assistant", refusal: opts.refusal } : { role: "assistant", content };
  const chunks = [{ choices: [{ index: 0, delta }] }, { choices: [{ index: 0, delta: {}, finish_reason: opts.finishReason ?? "stop" }] }];
  const sse = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}

/** OpenAI-compatible /chat/completions mock that records requests and answers from `reply`. */
type ChatRequest = { messages: Array<{ role: string; content: string }>; response_format?: { type: string } };

export function startMockLlm(reply: (body: ChatRequest) => string) {
  const requests: ChatRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as ChatRequest;
      requests.push(body);
      return chatCompletionStream(reply(body));
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

/** A fake SearXNG returning results that point at the fixture site. */
export function startMockSearxng(siteUrl: string) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.searchParams.get("pageno") !== "1") return Response.json({ results: [] });
      const category = u.searchParams.get("categories");
      return Response.json({
        results: [
          { url: `${siteUrl}/docs/a`, title: "Doc \ue000A\ue001", content: "About doc a", category },
          { url: `${siteUrl}/docs/b`, title: "Doc B", content: "About doc b", publishedDate: "2026-01-01", category },
          {
            url: "https://other.example/x",
            title: "Other",
            content: "Elsewhere",
            img_src: "https://other.example/i.png",
            resolution: "640 x 480",
          },
        ],
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** An engine for tests. Without a searxngUrl, searches fail fast instead of starting a real SearXNG. */
export function testEngine(overrides: ConfigOverrides = {}) {
  return new Engine(
    resolveConfig(
      { allowPrivateNetwork: true, concurrency: 4, timeout: 10_000, searxngUrl: "http://127.0.0.1:1", ...overrides },
      { allowPrivateNetwork: true },
      {},
    ),
  );
}

export async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await Bun.sleep(25);
  }
  throw new Error("waitFor timed out");
}
