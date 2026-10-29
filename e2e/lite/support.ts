import { textPdf } from "@searxng-js/sex-testing";
import { html, prose, site } from "../lib/sites.ts";

export { textPdf };

/** The bytes of a string in a single-byte or hand-encoded charset. */
export const bytes = (...b: number[]) => new Uint8Array(b);

const ARTICLE = `<!doctype html><html lang="en"><head><title>Test Article</title>
<meta name="description" content="A page for the e2e tests"><meta property="og:title" content="Test Article OG">
<link rel="icon" href="/favicon.ico"></head><body>
<nav id="topnav"><a href="/nav-link">NAVLINK</a></nav>
<main><article><h1>Heading One</h1>${prose("the article")}
<p>See <a href="/other#frag">the other page</a>, <a href="mailto:me@example.com">mail</a> and <a href="/other#frag2">again</a>.</p>
<img src="/img/one.png" alt="one"><div class="ad-slot">AD-SLOT-TEXT</div><aside class="side">SIDEBAR-TEXT</aside></article></main>
<footer id="foot">FOOTER-TEXT <a href="/foot-link">footlink</a></footer></body></html>`;

/** A local site with the pages the fetch tests need. Every page records its path in `hits`; `uas` records User-Agents. */
export function pagesSite() {
  const uas: string[] = [];
  const s = site(async (req, url) => {
    uas.push(req.headers.get("user-agent") ?? "");
    const p = url.pathname;
    const h = { "content-type": "text/html; charset=utf-8" };
    switch (p) {
      case "/article":
        return new Response(ARTICLE, { headers: h });
      case "/redirect":
        return new Response(null, { status: 302, headers: { location: "/article" } });
      case "/redirect-chain":
        return new Response(null, { status: 301, headers: { location: "/redirect" } });
      case "/redirect-loop":
        return new Response(null, { status: 302, headers: { location: "/redirect-loop" } });
      case "/gone":
        return new Response(`<html><head><title>Gone</title></head><body><h1>Gone away</h1>${prose("gone")}</body></html>`, {
          status: 404,
          headers: h,
        });
      case "/broken":
        return new Response("<html><body><h1>Server broke</h1></body></html>", { status: 500, headers: h });
      case "/latin1":
        // "Caf\xe9 cr\xe8me" in ISO-8859-1, declared in the header only.
        return new Response(
          Buffer.concat([
            Buffer.from("<html><head><title>Latin</title></head><body><main><h1>"),
            Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65]),
            Buffer.from(`</h1>${prose("latin one")}</main></body></html>`),
          ]),
          { headers: { "content-type": "text/html; charset=iso-8859-1" } },
        );
      case "/gbk":
        // "中文" in GBK, declared in a <meta> only.
        return new Response(
          Buffer.concat([
            Buffer.from('<html><head><meta charset="gbk"><title>GBK</title></head><body><main><h1>'),
            Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
            Buffer.from(`</h1>${prose("gbk page")}</main></body></html>`),
          ]),
          { headers: { "content-type": "text/html" } },
        );
      case "/huge": {
        // About 500 kB of ordinary paragraphs in a well-formed page.
        const para = (n: number) =>
          `<p>Paragraph ${n} of the huge page. ${"Words that make this paragraph long enough to count. ".repeat(10)}</p>\n`;
        let sent = 0;
        return new Response(
          new ReadableStream({
            pull(c) {
              if (sent === 0)
                c.enqueue(Buffer.from("<!doctype html><html><head><title>Huge</title></head><body><main><h1>Huge page</h1>\n"));
              else if (sent > 1000) {
                c.enqueue(Buffer.from("</main></body></html>"));
                return c.close();
              } else c.enqueue(Buffer.from(para(sent)));
              sent++;
            },
          }),
          { headers: h },
        );
      }
      case "/slow":
        await Bun.sleep(Number(url.searchParams.get("ms") ?? 5000));
        return html("Slow", `<main><h1>Slow page</h1>${prose("slow")}</main>`);
      case "/text-pdf":
        return new Response(textPdf(2), { headers: { "content-type": "application/pdf" } });
      case "/plain":
        return new Response("just some plain text\nsecond line", { headers: { "content-type": "text/plain; charset=utf-8" } });
      case "/data.json":
        return Response.json({ hello: "world" });
      case "/ua":
        return html("UA", `<main><h1>UA</h1><p>${req.headers.get("user-agent")}</p>${prose("ua")}</main>`);
      case "/echo-headers":
        return html("Headers", `<main><h1>Headers</h1><p>${req.headers.get("x-test") ?? "none"}</p>${prose("headers")}</main>`);
      case "/empty":
        return new Response("", { headers: h });
      default:
        return new Response("not found", { status: 404 });
    }
  });
  return { ...s, uas };
}

export interface SearxResult {
  url: string;
  title: string;
  content?: string;
  [k: string]: unknown;
}

/**
 * A fake SearXNG on `site()`: `results(url)` answers every `/search` (page 1 only; later pages are empty, so paging
 * stops). `hits` holds the requests.
 */
export function mockSearx(results: (url: URL) => SearxResult[] | Response) {
  return site((_req, url) => {
    if (url.pathname !== "/search") return new Response("not found", { status: 404 });
    if (url.searchParams.get("pageno") && url.searchParams.get("pageno") !== "1") return Response.json({ results: [] });
    const r = results(url);
    return r instanceof Response ? r : Response.json({ results: r });
  });
}

/** Strips ANSI colours. */
export const plain = (s: string) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
