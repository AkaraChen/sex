import { html, prose, type Site, site } from "../lib/sites.ts";

export interface TreeSite extends Site {
  /** Paths of page requests (no robots.txt / sitemap.xml) with their start time, in order. */
  starts: Array<{ path: string; at: number }>;
  /** The most page requests that were in flight at the same time. */
  peak(): number;
  resetStats(): void;
}

/**
 * A small site with a known shape:
 *   /               -> /blog/1..3, /docs/a, /private/x, /d1, /wide/
 *   /d1 -> /d2 -> /d3 -> /d4   (a chain, one more level each)
 *   /wide/          -> /wide/0 .. /wide/(wide-1)
 *   robots.txt      Disallow: /private/
 *   sitemap.xml     /sm/one, /sm/two
 * Everything else is 404. `delayMs` slows every page down (to see concurrency and cancellation).
 */
export function treeSite(opts: { delayMs?: number; wide?: number } = {}): TreeSite {
  const wide = opts.wide ?? 30;
  const starts: TreeSite["starts"] = [];
  let inflight = 0;
  let peak = 0;
  const links = (hrefs: string[]) => hrefs.map((h) => `<a href="${h}">${h}</a>`).join(" ");
  const s = site(async (_req, url) => {
    const p = url.pathname;
    if (p === "/robots.txt") return new Response("User-agent: *\nDisallow: /private/\n", { headers: { "content-type": "text/plain" } });
    if (p === "/sitemap.xml")
      return new Response(
        `<?xml version="1.0"?><urlset><url><loc>${url.origin}/sm/one</loc></url><url><loc>${url.origin}/sm/two</loc></url></urlset>`,
        { headers: { "content-type": "application/xml" } },
      );
    let kids: string[] | undefined;
    if (p === "/") kids = ["/blog/1", "/blog/2", "/blog/3", "/docs/a", "/private/x", "/d1", "/wide/"];
    else if (/^\/d[1-3]$/.test(p)) kids = [`/d${Number(p.slice(2)) + 1}`];
    else if (/^\/(d4|blog\/\d|docs\/a|private\/x|sm\/(one|two))$/.test(p)) kids = [];
    else if (p === "/wide/") kids = Array.from({ length: wide }, (_, i) => `/wide/${i}`);
    else if (/^\/wide\/\d+$/.test(p)) kids = [];
    if (!kids) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    starts.push({ path: p, at: Date.now() });
    inflight++;
    peak = Math.max(peak, inflight);
    try {
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      return html(`Page ${p}`, `<h1>Page ${p}</h1>${prose(p, 2)}${links(kids)}`);
    } finally {
      inflight--;
    }
  });
  return {
    ...s,
    starts,
    peak: () => peak,
    resetStats() {
      starts.length = 0;
      peak = 0;
    },
  };
}

export const paths = (urls: string[], base: string): string[] => urls.map((u) => u.replace(base, "")).sort();
