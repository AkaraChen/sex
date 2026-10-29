// POST /v2/map: sitemap + page links + SearXNG `site:` results, filters.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, killAll, type Server } from "../lib/proc.ts";
import { html, prose, type Site, site, startMockSearxng } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { startSex } from "./helpers.ts";

let srv: Server;
let web: Site;
let searxng: ReturnType<typeof startMockSearxng>;

/** Everything under the site, as "/path" (links on another host stay whole). */
const rel = (links: Array<{ url: string }>, base: string): string[] => links.map((l) => l.url.replace(base, ""));
const map = async (body: Record<string, unknown>) => {
  const r = await api(srv.url, "/v2/map", { body });
  expect(r.status).toBe(200);
  return r.body;
};

beforeAll(async () => {
  web = site((_req, url) => {
    const p = url.pathname;
    const origin = url.origin;
    if (p === "/robots.txt") return new Response(`User-agent: *\nSitemap: ${origin}/sitemap.xml\n`);
    if (p === "/sitemap.xml")
      return new Response(
        `<?xml version="1.0"?><urlset><url><loc>${origin}/sm/one</loc></url><url><loc>${origin}/blog/from-sitemap</loc></url><url><loc>${origin}/sm/file.pdf</loc></url></urlset>`,
        { headers: { "content-type": "application/xml" } },
      );
    if (p === "/old") return Response.redirect(`${origin}/new/`, 302);
    if (p === "/new/") return html("New", `${prose("new")}<a href="/new/a">a</a><a href="/other/b">b</a>`);
    const sub = origin.replace("localhost", "sub.localhost");
    return html(
      "Home",
      `${prose("home")}<a href="/blog/a">Blog A</a><a href="/blog/b">Blog B</a><a href="/blog/a">Blog A again</a>
<a href="/docs/x">Docs X</a><a href="/docs/y?q=1">Docs Y</a><a href="/files/report.pdf">PDF</a>
<a href="${sub}/subpage">sub</a><a href="https://external.example/z">ext</a><a href="/docs/z#frag">frag</a><a href="#top">top</a>`,
    );
  });
  searxng = startMockSearxng(web.url);
  srv = await startSex(["--searxng-url", searxng.url]);
});

afterAll(async () => {
  web.stop();
  searxng.stop();
  await killAll();
  removeTempDirs();
});

// The start URL is `localhost` so that `sub.localhost` is one of its subdomains.
const base = () => web.url.replace("127.0.0.1", "localhost");

describe("map", () => {
  test("lists the start page, its links and the sitemap, without duplicates, fragments or other hosts", async () => {
    const body = await map({ url: `${base()}/` });
    expect(body.success).toBe(true);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    const links = rel(body.links, base());
    expect(links).toContain("/");
    expect(links).toEqual(expect.arrayContaining(["/blog/a", "/blog/b", "/docs/x", "/docs/y", "/docs/z", "/files/report.pdf"]));
    expect(links).toEqual(expect.arrayContaining(["/sm/one", "/blog/from-sitemap", "/sm/file.pdf"]));
    expect(links.filter((l) => l === "/blog/a")).toHaveLength(1);
    expect(links.some((l) => l.includes("#"))).toBe(false);
    expect(links.some((l) => l.includes("external.example"))).toBe(false);
    // Query strings are dropped by default.
    expect(links).not.toContain("/docs/y?q=1");
    expect(body.links.find((l: any) => l.url.endsWith("/blog/b")).title).toBe("Blog B");
  });

  test("sitemap: only and skip", async () => {
    const only = rel((await map({ url: `${base()}/`, sitemap: "only" })).links, base());
    expect(only).toEqual(expect.arrayContaining(["/sm/one", "/blog/from-sitemap"]));
    expect(only).not.toContain("/docs/x");
    const skip = rel((await map({ url: `${base()}/`, sitemap: "skip" })).links, base());
    expect(skip).toContain("/docs/x");
    expect(skip).not.toContain("/sm/one");
  });

  test("limit", async () => {
    const body = await map({ url: `${base()}/`, limit: 2 });
    expect(body.links).toHaveLength(2);
  });

  test("search keeps and ranks URLs by the term", async () => {
    const links = rel((await map({ url: `${base()}/`, search: "blog" })).links, base());
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const l of links) expect(l).toContain("blog");
    expect(links).toContain("/blog/from-sitemap");
    expect(links).not.toContain("/docs/x");
  });

  test("search also asks SearXNG (site:) and adds its results on that host", async () => {
    const body = await map({ url: `${web.url}/`, search: "docs" });
    const links = rel(body.links, web.url);
    // The mock SearXNG answers with /docs/a and /docs/b on the site, and one URL elsewhere.
    expect(links).toEqual(expect.arrayContaining(["/docs/a", "/docs/b", "/docs/x"]));
    expect(links.some((l) => l.includes("other.example"))).toBe(false);
  });

  test("includeSubdomains", async () => {
    const withSub = (await map({ url: `${base()}/` })).links.map((l: any) => l.url);
    expect(withSub.some((u: string) => u.includes("sub.localhost"))).toBe(true);
    const withoutSub = (await map({ url: `${base()}/`, includeSubdomains: false })).links.map((l: any) => l.url);
    expect(withoutSub.some((u: string) => u.includes("sub.localhost"))).toBe(false);
    expect(withoutSub.length).toBeGreaterThan(5);
  });

  test("filterByPath keeps URLs under the start path; false lifts that", async () => {
    const under = await map({ url: `${base()}/docs/x` });
    expect(rel(under.links, base())).toEqual(["/docs/x"]);
    expect(under.warning).toBeTruthy();
    const all = rel((await map({ url: `${base()}/docs/x`, filterByPath: false })).links, base());
    expect(all).toEqual(expect.arrayContaining(["/docs/x", "/blog/a", "/sm/one"]));
  });

  test("includePaths and excludePaths are regexes on the path", async () => {
    const inc = rel((await map({ url: `${base()}/`, includePaths: ["^/blog/"] })).links, base());
    expect(inc.length).toBeGreaterThan(0);
    for (const l of inc) expect(l.startsWith("/blog/")).toBe(true);
    const exc = rel((await map({ url: `${base()}/`, excludePaths: ["^/blog", "docs"] })).links, base());
    expect(exc).toContain("/files/report.pdf");
    expect(exc.some((l) => l.startsWith("/blog") || l.includes("docs"))).toBe(false);
  });

  test("ignoreQueryParameters: false keeps query strings", async () => {
    const links = rel((await map({ url: `${base()}/`, ignoreQueryParameters: false })).links, base());
    expect(links).toContain("/docs/y?q=1");
  });

  test("a redirecting start URL is mapped from where it lands", async () => {
    const links = rel((await map({ url: `${base()}/old` })).links, base());
    expect(links).toEqual(expect.arrayContaining(["/new/a"]));
    expect(links).not.toContain("/blog/a");
  });

  test("bad requests", async () => {
    expect((await api(srv.url, "/v2/map", { body: { url: "not a url" } })).status).toBe(400);
    expect((await api(srv.url, "/v2/map", { body: { url: `${base()}/`, limit: 0 } })).status).toBe(400);
    expect((await api(srv.url, "/v2/map", { body: { url: `${base()}/`, includePaths: ["(a+)+"] } })).status).toBe(400);
    expect((await api(srv.url, "/v2/map", { body: {} })).status).toBe(400);
  });
});
