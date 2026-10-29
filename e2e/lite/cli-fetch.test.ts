import { afterAll, describe, expect, test } from "bun:test";
import { bin } from "../lib/bin.ts";
import { killAll, run } from "../lib/proc.ts";
import { staticSite } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { pagesSite, plain } from "./support.ts";

const lite = bin("sex-lite");
const fixtures = staticSite();
const pages = pagesSite();
afterAll(async () => {
  fixtures.stop();
  pages.stop();
  await killAll();
  removeTempDirs();
});

/** `fetch --json` of a page, the document inside `data`. */
async function doc(url: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = await run(lite, ["fetch", url, "--json", ...args], { env });
  expect(r.code, r.stderr).toBe(0);
  const out = r.json();
  expect(out.success).toBe(true);
  return { doc: out.data, r };
}

describe("fetch output", () => {
  test("default output is the bare markdown on stdout, nothing on stderr", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/article`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("# Heading One");
    expect(r.stdout).toContain("Paragraph 1 about the article");
    expect(() => JSON.parse(r.stdout)).toThrow();
    expect(r.stderr).toBe("");
  });

  test("--json prints one JSON document {success, data}, stderr stays empty", async () => {
    const { doc: d, r } = await doc(`${pages.url}/article`);
    expect(d.markdown).toContain("# Heading One");
    expect(d.metadata.statusCode).toBe(200);
    expect(d.metadata.sourceURL).toBe(`${pages.url}/article`);
    expect(d.metadata.contentType).toContain("text/html");
    expect(d.metadata.title).toBe("Test Article");
    expect(d.metadata.description).toBe("A page for the e2e tests");
    expect(d.metadata.language).toBe("en");
    expect(d.metadata.ogTitle).toBe("Test Article OG");
    expect(d.metadata.scrapeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.stderr).toBe("");
    expect(r.stdout.trimStart().startsWith("{")).toBe(true);
    expect(r.stdout.trimEnd().endsWith("}")).toBe(true);
  });

  test("the fixture directory listing (apps/sex/test/fixtures) is fetched with its links", async () => {
    const d = (await doc(`${fixtures.url}/`, ["-f", "markdown,links"])).doc;
    expect(d.markdown).toContain("report.docx");
    expect(d.links).toEqual(
      expect.arrayContaining([`${fixtures.url}/scan.pdf`, `${fixtures.url}/report.docx`, `${fixtures.url}/hello.png`]),
    );
  });
});

describe("formats", () => {
  test("markdown", async () => {
    const d = (await doc(`${pages.url}/article`, ["-f", "markdown"])).doc;
    expect(Object.keys(d).sort()).toEqual(["markdown", "metadata"]);
  });

  test("html is the extracted main content, rawHtml the page as served", async () => {
    const d = (await doc(`${pages.url}/article`, ["-f", "html,rawHtml"])).doc;
    expect(d.html).toContain("Heading One");
    expect(d.html).not.toContain("FOOTER-TEXT");
    expect(d.rawHtml).toContain("FOOTER-TEXT");
    expect(d.rawHtml).toContain('<nav id="topnav">');
    expect(d.rawHtml).toContain("<!doctype html>");
    expect(d.markdown).toBeUndefined();
  });

  test("links come from the whole page, absolute, without fragments, deduplicated, mailto kept", async () => {
    const d = (await doc(`${pages.url}/article`, ["-f", "links"])).doc;
    expect(d.links).toEqual(
      expect.arrayContaining([`${pages.url}/nav-link`, `${pages.url}/foot-link`, `${pages.url}/other`, "mailto:me@example.com"]),
    );
    expect(d.links.filter((l: string) => l === `${pages.url}/other`)).toHaveLength(1);
    expect(d.links.some((l: string) => l.includes("#"))).toBe(false);
  });

  test("images are absolute URLs", async () => {
    const d = (await doc(`${pages.url}/article`, ["-f", "images"])).doc;
    expect(d.images).toContain(`${pages.url}/img/one.png`);
  });

  test("several formats at once", async () => {
    const d = (await doc(`${pages.url}/article`, ["-f", "markdown,html,rawHtml,links,images"])).doc;
    for (const k of ["markdown", "html", "rawHtml", "links", "images"]) expect(d[k], k).toBeDefined();
  });

  test("an unknown format is a BAD_REQUEST, exit 2, nothing on stdout", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/article`, "-f", "nonsense"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("BAD_REQUEST");
  });

  for (const format of ["json", "summary"]) {
    test(`the ${format} format needs an LLM: 501 LLM_NOT_CONFIGURED naming sex`, async () => {
      const r = await run(lite, ["fetch", `${pages.url}/article`, "-f", format]);
      expect(r.code).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("LLM_NOT_CONFIGURED");
      expect(r.stderr).toContain("use sex");
    });
  }

  test("formats the server does not support are NOT_SUPPORTED (screenshot)", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/article`, "-f", "screenshot"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/NOT_SUPPORTED|BAD_REQUEST/);
  });

  test("--options passes extra Firecrawl options (rawBase64) and sends headers", async () => {
    const d = (await doc(`${pages.url}/echo-headers`, ["--options", JSON.stringify({ headers: { "X-Test": "hello-e2e" } })])).doc;
    expect(d.markdown).toContain("hello-e2e");
    const b = (await doc(`${pages.url}/plain`, ["-f", "rawBase64"])).doc;
    expect(Buffer.from(b.rawBase64, "base64").toString()).toBe("just some plain text\nsecond line");
  });

  test("--options accepts a file path", async () => {
    const { tempDir } = await import("../lib/tmp.ts");
    const path = `${tempDir()}/o.json`;
    await Bun.write(path, JSON.stringify({ headers: { "X-Test": "from-file" } }));
    const d = (await doc(`${pages.url}/echo-headers`, ["--options", path])).doc;
    expect(d.markdown).toContain("from-file");
  });

  test("--user-agent is sent", async () => {
    const d = (await doc(`${pages.url}/ua`, ["--user-agent", "e2e-agent/1.0"])).doc;
    expect(d.markdown).toContain("e2e-agent/1.0");
  });

  test("--mobile changes the User-Agent without a browser", async () => {
    const d = (await doc(`${pages.url}/ua`, ["--mobile"])).doc;
    expect(d.markdown).toMatch(/Mobile|iPhone|Android/);
  });
});

describe("content selection", () => {
  test("onlyMainContent (default) drops navigation, footer and boilerplate", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/article`]);
    expect(r.stdout).not.toContain("NAVLINK");
    expect(r.stdout).not.toContain("FOOTER-TEXT");
  });

  test("--full keeps the whole page", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/article`, "--full"]);
    // The navigation is dropped even here (Defuddle removes <nav>); the rest of the body stays.
    expect(r.stdout).toContain("Heading One");
    expect(r.stdout).toContain("FOOTER-TEXT");
    expect(r.stdout).toContain("SIDEBAR-TEXT");
    expect(r.stdout).toContain("AD-SLOT-TEXT");
  });

  test("--exclude-tags removes matching elements", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/article`, "--full", "--exclude-tags", ".ad-slot,aside,#foot"]);
    expect(r.stdout).not.toContain("AD-SLOT-TEXT");
    expect(r.stdout).not.toContain("SIDEBAR-TEXT");
    expect(r.stdout).not.toContain("FOOTER-TEXT");
    expect(r.stdout).toContain("Heading One");
  });

  test("--include-tags keeps only matching elements", async () => {
    // (A lone "h1" selector yields an empty page: Defuddle drops the heading that repeats the title.)
    const r = await run(lite, ["fetch", `${pages.url}/article`, "--include-tags", ".side"]);
    expect(r.stdout.trim()).toBe("SIDEBAR-TEXT");
  });
});

describe("HTTP behaviour", () => {
  test("a redirect is followed; metadata.url is the final URL, sourceURL the requested one", async () => {
    const d = (await doc(`${pages.url}/redirect-chain`)).doc;
    expect(d.markdown).toContain("# Heading One");
    expect(d.metadata.sourceURL).toBe(`${pages.url}/redirect-chain`);
    expect(d.metadata.url).toBe(`${pages.url}/article`);
    expect(d.metadata.statusCode).toBe(200);
  });

  test("a redirect loop ends in TOO_MANY_REDIRECTS", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/redirect-loop`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("TOO_MANY_REDIRECTS");
    expect(r.stdout).toBe("");
  });

  test("a 404 page is a document with metadata.statusCode 404 and exit 0", async () => {
    const d = (await doc(`${pages.url}/gone`)).doc;
    expect(d.metadata.statusCode).toBe(404);
    expect(d.markdown).toContain("Gone away");
  });

  test("a 500 page is a document with statusCode 500", async () => {
    const d = (await doc(`${pages.url}/broken`)).doc;
    expect(d.metadata.statusCode).toBe(500);
  });

  test("a refused connection is SCRAPE_SITE_ERROR", async () => {
    const r = await run(lite, ["fetch", "http://127.0.0.1:1/"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("SCRAPE_SITE_ERROR");
    expect(r.stdout).toBe("");
  });

  test("an unresolvable name is SCRAPE_DNS_RESOLUTION_ERROR", async () => {
    const r = await run(lite, ["fetch", "http://no-such-host.invalid/"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/SCRAPE_DNS_RESOLUTION_ERROR/);
  });

  test("a URL that is not a URL is BAD_REQUEST", async () => {
    const r = await run(lite, ["fetch", "not a url"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("BAD_REQUEST");
  });

  test("a non-http scheme is refused", async () => {
    for (const url of ["file:///etc/passwd", "ftp://127.0.0.1/x", "gopher://127.0.0.1/"]) {
      const r = await run(lite, ["fetch", url]);
      expect(r.code, url).not.toBe(0);
      expect(r.stdout, url).toBe("");
      expect(r.stdout).not.toContain("root:");
    }
  });

  test("a slow page ends in SCRAPE_TIMEOUT at --timeout", async () => {
    const t = Date.now();
    const r = await run(lite, ["fetch", `${pages.url}/slow?ms=20000`, "--timeout", "1000"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("SCRAPE_TIMEOUT");
    expect(Date.now() - t).toBeLessThan(15_000);
  });

  test("a page that is quicker than --timeout succeeds", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/slow?ms=300`, "--timeout", "10000"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Slow page");
  });
});

describe("encodings and bodies", () => {
  test("ISO-8859-1 from the Content-Type header", async () => {
    const d = (await doc(`${pages.url}/latin1`)).doc;
    expect(d.markdown).toContain("Café crème");
  });

  test("GBK from a <meta charset>", async () => {
    const d = (await doc(`${pages.url}/gbk`)).doc;
    expect(d.markdown).toContain("中文");
  });

  test("a body beyond SEX_MAX_BODY_BYTES is RESPONSE_TOO_LARGE", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/huge`], { env: { SEX_MAX_BODY_BYTES: "100000" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("RESPONSE_TOO_LARGE");
    expect(r.stdout).toBe("");
  });

  test("the same page under the cap works", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/huge`], { env: { SEX_MAX_BODY_BYTES: "10000000" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Paragraph 1000 of the huge page");
  });

  // BUG: a 200 response with an empty body fails with EXTRACT_FAILED (Defuddle throws "Cannot destructure property
  // 'firstElementChild'" and the stack trace goes to stderr); it should be a document with empty markdown.
  // Repro: serve an empty body with content-type text/html, `sex-lite fetch http://127.0.0.1:PORT/empty --json`.
  test.failing("an empty body is a document, not a crash", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/empty`, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json().data.metadata.statusCode).toBe(200);
  });

  test("text/plain is returned as text", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/plain`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("just some plain text");
  });

  test("a text PDF is extracted page by page (unpdf, no here-docs)", async () => {
    const d = (await doc(`${pages.url}/text-pdf`)).doc;
    expect(d.markdown).toContain("Text page 1");
    expect(d.markdown).toContain("Text page 2");
    expect(d.metadata.numPages).toBe(2);
    expect(d.metadata.totalPages).toBe(2);
    expect(d.metadata.contentType).toBe("application/pdf");
  });

  test("scan.pdf has no text layer: plain unpdf extraction gives empty markdown (OCR needs sex --docs)", async () => {
    const d = (await doc(`${fixtures.url}/scan.pdf`)).doc;
    expect(d.markdown).toBe("");
    expect(d.metadata.numPages).toBe(1);
  });

  test("report.docx without here-docs is UNSUPPORTED_FILE (415)", async () => {
    const r = await run(lite, ["fetch", `${fixtures.url}/report.docx`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("UNSUPPORTED_FILE");
    expect(r.stdout).toBe("");
  });

  test("an image is UNSUPPORTED_FILE without here-docs", async () => {
    const r = await run(lite, ["fetch", `${fixtures.url}/hello.png`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("UNSUPPORTED_FILE");
  });
});

describe("process contract", () => {
  test("errors are one 'error: CODE: message' line on stderr, stdout stays empty", async () => {
    const r = await run(lite, ["fetch", "http://127.0.0.1:1/"]);
    const lines = plain(r.stderr).trim().split("\n");
    expect(lines.filter((l) => l.startsWith("error: "))).toHaveLength(1);
    expect(r.stdout).toBe("");
  });

  test("--help exits 0 and lists the flags", async () => {
    const r = await run(lite, ["fetch", "--help"]);
    expect(r.code).toBe(0);
    const text = plain(r.stdout + r.stderr);
    for (const flag of ["--timeout", "--formats", "--allow-private-network", "--include-tags"]) expect(text).toContain(flag);
  });

  test("a missing URL argument fails with a non-zero exit", async () => {
    const r = await run(lite, ["fetch"]);
    expect(r.code).not.toBe(0);
  });

  test("an unknown command fails with a non-zero exit", async () => {
    const r = await run(lite, ["crawl", "http://x"]);
    expect(r.code).not.toBe(0);
  });
});
