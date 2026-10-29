import { afterAll, describe, expect, test } from "bun:test";
import { bin } from "../lib/bin.ts";
import { killAll, run } from "../lib/proc.ts";
import { site } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { mockSearx, pagesSite, plain } from "./support.ts";

const lite = bin("sex-lite");
const pages = pagesSite();
const results = [
  { url: `${pages.url}/article`, title: "First hit", content: "about the first" },
  { url: `${pages.url}/gone`, title: "Second", content: "about the second", publishedDate: "2026-01-01" },
  { url: "https://github.com/o/r", title: "Repo", content: "a repository" },
  { url: "https://example.gov/report.pdf", title: "Report", content: "a report" },
];
const searx = mockSearx(() => results);
const env = { SEX_SEARXNG_URL: searx.url };
afterAll(async () => {
  pages.stop();
  searx.stop();
  await killAll();
  removeTempDirs();
});

const queries = () => searx.hits.map((h) => new URL(h, "http://x").searchParams);

async function search(args: string[], e: Record<string, string | undefined> = env) {
  searx.hits.length = 0;
  return run(lite, ["search", "my query", ...args], { env: e });
}

describe("search output", () => {
  test("the default is a numbered text list: title (highlight markers removed), url, description", async () => {
    const r = await search([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`1. First hit\n   ${pages.url}/article\n   about the first`);
    expect(r.stdout).toContain("4. Report");
    expect(r.stdout).not.toContain("");
    expect(r.stderr).toBe("");
  });

  test("--json prints {success, data: {web}} with positions and categories", async () => {
    const r = await search(["--json"]);
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out.success).toBe(true);
    expect(out.data.web.map((w: any) => w.position)).toEqual([1, 2, 3, 4]);
    expect(out.data.web[0]).toMatchObject({ url: `${pages.url}/article`, title: "First hit", description: "about the first" });
    expect(out.data.web[2].category).toBe("github");
    expect(out.data.web[3].category).toBe("pdf");
    expect(out.data.web[0].markdown).toBeUndefined();
  });

  test("the query reaches SearXNG as format=json, page 1", async () => {
    await search(["--json"]);
    const q = queries()[0]!;
    expect(q.get("q")).toBe("my query");
    expect(q.get("format")).toBe("json");
    expect(q.get("pageno")).toBe("1");
  });

  test("-n limits the results (CLI default is 5) and --limit is the same flag", async () => {
    expect((await search(["-n", "2", "--json"])).json().data.web).toHaveLength(2);
    expect((await search(["--limit", "3", "--json"])).json().data.web).toHaveLength(3);
    expect((await search(["--json"])).json().data.web).toHaveLength(4);
  });

  test("invalid limits and sources are BAD_REQUEST with exit 2 and no request to SearXNG", async () => {
    for (const args of [
      ["-n", "0"],
      ["-n", "101"],
      ["--sources", "bogus"],
    ]) {
      const r = await search(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("BAD_REQUEST");
      expect(r.stdout).toBe("");
      expect(searx.hits).toEqual([]);
    }
  });
});

describe("search options", () => {
  test("--sources asks SearXNG once per source, with its category", async () => {
    const r = await search(["--sources", "web,news,images", "--json"]);
    expect(r.code).toBe(0);
    expect([...new Set(queries().map((q) => q.get("categories")))].sort()).toEqual(["general", "images", "news"]);
    const data = r.json().data;
    expect(Object.keys(data).sort()).toEqual(["images", "news", "web"]);
    expect(data.news[0].snippet).toBeDefined();
  });

  test("--categories becomes site: / filetype: operators in the query", async () => {
    await search(["--categories", "github,pdf"]);
    const q = queries()[0]!.get("q")!;
    expect(q).toContain("site:github.com");
    expect(q).toContain("filetype:pdf");
  });

  test("--include-domains / --exclude-domains filter the results and shape the query", async () => {
    const inc = await search(["--include-domains", "github.com", "--json"]);
    expect(inc.json().data.web.map((w: any) => w.url)).toEqual(["https://github.com/o/r"]);
    expect(queries()[0]!.get("q")).toContain("site:github.com");
    const exc = await search(["--exclude-domains", "github.com", "--json"]);
    expect(exc.json().data.web.map((w: any) => w.url)).not.toContain("https://github.com/o/r");
    expect(queries()[0]!.get("q")).toContain("-site:github.com");
  });

  test("--tbs qdr:d and --lang are forwarded as time_range and language", async () => {
    const r = await search(["--tbs", "qdr:d", "--lang", "zh-CN"]);
    expect(r.code).toBe(0);
    const q = queries()[0]!;
    expect(q.get("time_range")).toBe("day");
    expect(q.get("language")).toBe("zh-CN");
  });

  test("an unsupported --tbs is not silently dropped: it lands in warning", async () => {
    const r = await search(["--tbs", "cdr:1", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json().warning).toContain("tbs");
  });

  test("a query with site: is enforced on the results", async () => {
    const r = await run(lite, ["search", "site:github.com stuff", "--json"], { env });
    expect(r.json().data.web.map((w: any) => w.url)).toEqual(["https://github.com/o/r"]);
  });
});

describe("search --scrape", () => {
  test("scrapes each result as markdown; a 404 result keeps its statusCode", async () => {
    pages.hits.length = 0;
    const r = await search(["--scrape", "--json", "-n", "2"]);
    expect(r.code).toBe(0);
    const web = r.json().data.web;
    expect(web[0].markdown).toContain("# Heading One");
    expect(web[0].metadata.statusCode).toBe(200);
    expect(web[1].metadata.statusCode).toBe(404);
    expect(pages.hits.sort()).toEqual(["/article", "/gone"]);
  });

  test("a result that cannot be scraped does not fail the search", async () => {
    const dead = mockSearx(() => [
      { url: "http://127.0.0.1:1/", title: "Dead", content: "nobody home" },
      { url: `${pages.url}/article`, title: "Alive", content: "ok" },
    ]);
    try {
      const r = await run(lite, ["search", "q", "--scrape", "--json"], { env: { SEX_SEARXNG_URL: dead.url } });
      expect(r.code).toBe(0);
      const web = r.json().data.web;
      expect(web).toHaveLength(2);
      expect(web[1].markdown).toContain("Heading One");
      expect(web[0].markdown).toBeUndefined();
    } finally {
      dead.stop();
    }
  });
});

describe("SearXNG failures", () => {
  test("nothing listening: SEARCH_BACKEND_UNAVAILABLE, exit 1, empty stdout", async () => {
    const r = await search([], { SEX_SEARXNG_URL: "http://127.0.0.1:9" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("SEARCH_BACKEND_UNAVAILABLE");
  });

  test("HTTP 500 is retried once, then SEARCH_BACKEND_ERROR", async () => {
    const bad = site(() => new Response("boom", { status: 500 }));
    try {
      const r = await search([], { SEX_SEARXNG_URL: bad.url });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("SEARCH_BACKEND_ERROR");
      expect(r.stderr).toContain("500");
      expect(bad.hits).toHaveLength(2);
    } finally {
      bad.stop();
    }
  });

  test("a non-JSON answer is SEARCH_BACKEND_ERROR", async () => {
    const junk = site(() => new Response("<html>not json</html>", { headers: { "content-type": "text/html" } }));
    try {
      const r = await search([], { SEX_SEARXNG_URL: junk.url });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("SEARCH_BACKEND_ERROR");
    } finally {
      junk.stop();
    }
  });

  test("a SearXNG that hangs ends in TIMEOUT at --timeout", async () => {
    const hang = site(() => new Promise<Response>(() => {}));
    try {
      const t = Date.now();
      const r = await search(["--timeout", "1500"], { SEX_SEARXNG_URL: hang.url });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("TIMEOUT");
      expect(Date.now() - t).toBeLessThan(20_000);
    } finally {
      hang.stop();
    }
  });

  test("no results with unresponsive engines: exit 0 and the engines in a warning on stderr / JSON", async () => {
    const empty = site(() => Response.json({ results: [], unresponsive_engines: [["google", "CAPTCHA"]] }));
    try {
      const r = await search(["--json"], { SEX_SEARXNG_URL: empty.url });
      expect(r.code).toBe(0);
      expect(r.json().data.web).toEqual([]);
      expect(r.json().warning).toContain("google");
      expect(plain(r.stderr)).toBe("");
    } finally {
      empty.stop();
    }
  });

  test("an empty answer without a reason is an empty list, not an error", async () => {
    const empty = site(() => Response.json({ results: [] }));
    try {
      const r = await search(["--json"], { SEX_SEARXNG_URL: empty.url });
      expect(r.code).toBe(0);
      expect(r.json().data.web).toEqual([]);
    } finally {
      empty.stop();
    }
  });
});

test("search without a query fails with a non-zero exit", async () => {
  const r = await run(lite, ["search"], { env });
  expect(r.code).not.toBe(0);
});
