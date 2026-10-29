import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

interface Reply {
  status: number;
  type: string;
  body: string;
}
const html = (title: string, body: string, _head = "", status = 200): Reply => ({
  status,
  type: "text/html; charset=utf-8",
  body: `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
});

export interface Site {
  url: string;
  /** Paths (with query) requested so far, in order. */
  hits: string[];
  stop(): void;
}

/** A small seeded PRNG (mulberry32): the same seed always gives the same graph. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Kind = "ok" | "slow" | "404" | "500" | "reset";

export interface GraphSite extends Site {
  pages: number;
  /** Kind of page `i`, from its number alone. */
  kind(i: number): Kind;
  /** Page numbers `i` links to (the "/private/..." links are in `privateLinks`). */
  links(i: number): number[];
  /** Number of requests seen per pathname. */
  counts(): Map<string, number>;
  /** Pathnames under a Disallow rule that were requested (apart from robots.txt itself). */
  disallowedHits(): string[];
  /** Highest number of requests being served at the same time. */
  peakInFlight(): number;
}

export const pagePath = (i: number) => `/p/${i}`;
export const pageNo = (path: string): number | undefined => {
  const m = /^\/p\/(\d+)$/.exec(path);
  return m ? Number(m[1]) : undefined;
};

/**
 * A deterministic site of `pages` pages, each with 5-20 links to other pages (seeded), some slow (100-500 ms), some
 * 404 and 500; `/robots.txt` disallows `/private/`, which some pages link to; `/sitemap.xml` lists every 10th page.
 * Page 0 is never broken and is the start (`/`, which links to the first pages).
 */
export async function graphSite(pages: number, seed = 1): Promise<GraphSite> {
  const kinds: Kind[] = [];
  const delays: number[] = [];
  const outLinks: number[][] = [];
  for (let i = 0; i < pages; i++) {
    const rnd = prng(seed * 1_000_003 + i);
    const r = rnd();
    kinds.push(i === 0 ? "ok" : r < 0.02 ? "404" : r < 0.03 ? "500" : r < 0.04 ? "reset" : r < 0.14 ? "slow" : "ok");
    delays.push(100 + Math.floor(rnd() * 400));
    const n = 5 + Math.floor(rnd() * 16);
    const set = new Set<number>();
    // One link to the next page keeps the graph connected; the rest are random.
    if (i + 1 < pages) set.add(i + 1);
    while (set.size < n) set.add(Math.floor(rnd() * pages));
    set.delete(i);
    outLinks.push([...set]);
  }
  let inFlight = 0;
  let peak = 0;
  const lorem = (i: number) =>
    Array.from(
      { length: 3 },
      (_, k) =>
        `<p>Paragraph ${k + 1} of page ${i}. ${"The extractor needs some words to find the main content of this page. ".repeat(4)}</p>`,
    ).join("");

  const hits: string[] = [];
  const baseUrl = () => s.url;
  const handle = async (url: URL): Promise<Reply | "reset"> => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      const path = url.pathname;
      if (path === "/robots.txt") return { status: 200, type: "text/plain", body: "User-agent: *\nDisallow: /private/\nAllow: /\n" };
      if (path === "/sitemap.xml") {
        const urls = [];
        for (let i = 0; i < pages; i += 10) urls.push(`<url><loc>${baseUrl()}${pagePath(i)}</loc></url>`);
        urls.push(`<url><loc>${baseUrl()}/private/sitemap-secret</loc></url>`);
        return {
          status: 200,
          type: "application/xml",
          body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,
        };
      }
      if (path === "/") {
        const first = Array.from({ length: Math.min(10, pages) }, (_, i) => `<a href="${pagePath(i)}">page ${i}</a>`).join(" ");
        return html("Home", `<h1>Home</h1>${lorem(-1)}<nav>${first}</nav>`);
      }
      if (path.startsWith("/private/")) return html("Private", `<h1>Private</h1>${lorem(-2)}`);
      const i = pageNo(path);
      if (i === undefined || i >= pages) return { status: 404, type: "text/plain", body: "not found" };
      const kind = kinds[i] as Kind;
      if (kind === "slow") await Bun.sleep(delays[i] as number);
      if (kind === "404") return html("Not found", "<h1>Not found</h1><p>This page does not exist.</p>", "", 404);
      if (kind === "500") return html("Error", "<h1>Server error</h1><p>Something broke.</p>", "", 500);
      if (kind === "reset") return "reset";
      const links = (outLinks[i] as number[]).map((j) => `<a href="${pagePath(j)}">page ${j}</a>`);
      if (i % 25 === 0) links.push(`<a href="/private/p${i}">private</a>`);
      return html(`Page ${i}`, `<h1>Page ${i}</h1>${lorem(i)}<ul>${links.map((l) => `<li>${l}</li>`).join("")}</ul>`);
    } finally {
      inFlight--;
    }
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(url.pathname + url.search);
    handle(url).then(
      (r) => {
        if (r === "reset") {
          // Headers and part of the body go out, then the connection dies.
          res.writeHead(200, { "content-type": "text/html", "content-length": "5000" });
          res.write("<html><body>");
          setTimeout(() => res.socket?.destroy(), 5);
          return;
        }
        res.writeHead(r.status, { "content-type": r.type });
        res.end(r.body);
      },
      () => res.socket?.destroy(),
    );
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const s: Site = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
  return {
    ...s,
    pages,
    kind: (i) => kinds[i] as Kind,
    links: (i) => outLinks[i] as number[],
    counts() {
      const m = new Map<string, number>();
      for (const h of s.hits) {
        const p = h.split("?")[0] as string;
        m.set(p, (m.get(p) ?? 0) + 1);
      }
      return m;
    },
    disallowedHits: () => s.hits.filter((h) => h.startsWith("/private/")),
    peakInFlight: () => peak,
  };
}
