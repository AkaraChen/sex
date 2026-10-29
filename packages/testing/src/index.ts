// Test fixtures shared by the packages' and apps' tests: a fixture website, a mock SearXNG, a counting proxy. Bun only (Bun.serve).
import { createServer } from "node:http";

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

export async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) return v;
    await Bun.sleep(25);
  }
  throw new Error("waitFor timed out");
}

/** A text PDF with one line per page ("Text page N"), built by hand. */
export function textPdf(pages: number): Uint8Array {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 18 Tf 20 100 Td (Text page ${i + 1}) Tj ET`;
    kids.push(`${objs.length + 1} 0 R`);
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents ${objs.length + 2} 0 R /Resources << /Font << /F1 ${2 + pages * 2 + 1} 0 R >> >> >>`,
    );
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, o] of objs.entries()) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/**
 * A forward proxy that counts what it is asked for. Plain-HTTP requests (absolute-form target) are recorded and forwarded
 * to `target(url)` (default: the URL itself); CONNECT requests are recorded and refused. The proxy URL is `url`.
 * With `auth` ("user:password") requests without matching Basic credentials get a 407 challenge (and are recorded too).
 */
export function startCountingProxy(target: (url: URL) => URL = (u) => u, opts: { auth?: string } = {}) {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const connects: string[] = [];
  const server = createServer(async (req, res) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    requests.push({ url: req.url ?? "", headers });
    if (opts.auth && headers.get("proxy-authorization") !== `Basic ${btoa(opts.auth)}`) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="test"', "content-length": "0" }).end();
      return;
    }
    try {
      const upstream = await fetch(target(new URL(req.url ?? "")), { method: req.method, redirect: "manual" });
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(502).end();
    }
  });
  server.on("connect", (req, socket) => {
    connects.push(req.url ?? "");
    socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
  });
  return new Promise<{ url: string; requests: typeof requests; connects: string[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, requests, connects, close: () => server.close() });
    });
  });
}
