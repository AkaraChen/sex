import { gunzipSync } from "node:zlib";
import { Deadline } from "@sex/core/deadline.ts";
import { log } from "@sex/core/log.ts";
import { assertPublicUrl, decodeBody, parseHttpUrl, safeFetch } from "@sex/core/net.ts";
import { scrapeUrl } from "@sex/core/scrape.ts";
import { clean, searxng } from "@sex/core/search.ts";
import type { MapLink, MapRequest, MapResult } from "../schemas.ts";
import type { Engine } from "./engine.ts";
import { fetchRobots, type Robots } from "./robots.ts";
import { basePathOf, compilePatterns, matchesPatterns } from "./url-filter.ts";

const MAX_SITEMAPS = 50;
const MAX_SITEMAP_BYTES = 25 * 1024 * 1024;

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const decodeXml = (raw: string) => {
  const s = raw.trim();
  // A CDATA section is literal text: no entity decoding inside it.
  const cdata = s.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) return (cdata[1] ?? "").trim();
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
};

export interface SitemapOptions {
  /** Only URLs it accepts count toward `max`, so filtering happens before the limit instead of after it. */
  accept?: (url: string) => boolean;
  /** Directory the crawl stays in: its `sitemap.xml` is tried too. */
  scopePath?: string;
  /** Robots already fetched by the caller. */
  robots?: Robots;
}

/** Collects page URLs from robots.txt sitemaps and /sitemap.xml, following sitemap indexes. */
export async function sitemapUrls(
  engine: Engine,
  origin: string,
  max: number,
  deadline: Deadline,
  opts: SitemapOptions = {},
): Promise<string[]> {
  const robots = opts.robots ?? (await fetchRobots(engine, origin, "sex", deadline));
  // Sitemap: lines may be relative; resolve them against the site's origin.
  const declared = robots.sitemaps.flatMap((sm) => {
    try {
      return [new URL(sm, origin).href];
    } catch {
      return [];
    }
  });
  const scoped = opts.scopePath && opts.scopePath !== "/" ? [`${origin}${opts.scopePath}sitemap.xml`] : [];
  const queue = Array.from(new Set([...declared, `${origin}/sitemap.xml`, ...scoped]));
  const visited = new Set<string>();
  const urls = new Set<string>();
  while (queue.length && visited.size < MAX_SITEMAPS && urls.size < max) {
    const sm = queue.shift() as string;
    if (visited.has(sm)) continue;
    visited.add(sm);
    try {
      const res = await safeFetch(sm, {
        deadline: deadline.slice(15_000),
        allowPrivateNetwork: engine.config.allowPrivateNetwork,
        proxy: engine.config.proxyUrl,
        userAgent: engine.config.userAgent,
        maxBodyBytes: engine.config.maxBodyBytes,
      });
      if (res.status >= 400) continue;
      const gz = res.body[0] === 0x1f && res.body[1] === 0x8b;
      const xml = gz
        ? gunzipSync(res.body, { maxOutputLength: MAX_SITEMAP_BYTES }).toString("utf8")
        : decodeBody(res.body, res.contentType);
      const isIndex = /<sitemapindex[\s>]/i.test(xml);
      for (const m of xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)) {
        const loc = decodeXml(m[1] ?? "");
        if (!loc) continue;
        if (isIndex) queue.push(loc);
        else if (urls.size < max && (!opts.accept || opts.accept(loc))) urls.add(loc);
      }
    } catch (err) {
      log.debug("sitemap fetch failed", { sitemap: sm, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return [...urls];
}

const stripWww = (host: string) => host.replace(/^www\./, "");

export function normalizeUrl(raw: string, ignoreQuery: boolean): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    u.hash = "";
    if (ignoreQuery) u.search = "";
    return u.href;
  } catch {
    return undefined;
  }
}

/** What only sex's own callers can ask of a map (the request schema is Firecrawl's). */
export interface MapInternals {
  /** Leave out the SearXNG `site:` search: it costs a request (and may start SearXNG) and only matters for finding pages by topic. */
  skipSearch?: boolean;
}

export async function mapSite(engine: Engine, req: MapRequest, signal?: AbortSignal, internals: MapInternals = {}): Promise<MapResult> {
  let start = parseHttpUrl(req.url.trim());
  await assertPublicUrl(start, engine.config.allowPrivateNetwork);
  const includes = compilePatterns(req.includePaths, "includePaths");
  const excludes = compilePatterns(req.excludePaths, "excludePaths");
  const limit = req.limit ?? 5000;
  const mode = req.sitemap ?? "include";
  const includeSubdomains = req.includeSubdomains ?? true;
  const ignoreQuery = req.ignoreQueryParameters ?? true;
  // Keeps the code of the old plain timeout: map never had a SCRAPE_TIMEOUT of its own.
  const deadline = Deadline.start(req.timeout ?? 60_000, { signal, expiredCode: "TIMEOUT" });

  // Like Firecrawl, the site is the one the entry URL redirects to; safeFetch checks every hop.
  let warning: string | undefined;
  const resolveOpts = {
    deadline: deadline.slice(10_000),
    allowPrivateNetwork: engine.config.allowPrivateNetwork,
    proxy: engine.config.proxyUrl,
    userAgent: engine.config.userAgent,
    headersOnly: true,
  };
  try {
    // HEAD where the server allows it; either way only the headers are read, the page itself is scraped below.
    const head = await safeFetch(start.href, { ...resolveOpts, method: "HEAD" }).catch((err) => {
      deadline.signal.throwIfAborted();
      log.debug("map: HEAD on the start URL failed", { error: err instanceof Error ? err.message : String(err) });
      return undefined;
    });
    const res = head && head.status < 400 ? head : await safeFetch(start.href, resolveOpts);
    start = parseHttpUrl(res.url);
  } catch (err) {
    log.debug("map: resolving the start URL failed", { error: err instanceof Error ? err.message : String(err) });
    deadline.signal.throwIfAborted();
  }
  const baseHost = stripWww(start.hostname);
  const basePath = basePathOf(start.pathname);
  const inPath = (url: string) => {
    const { pathname } = new URL(url);
    if ((req.filterByPath ?? true) && basePath !== "/" && !`${pathname}/`.startsWith(basePath)) return false;
    return matchesPatterns(pathname, includes, excludes);
  };

  const inScope = (url: string) => {
    try {
      const host = stripWww(new URL(url).hostname);
      return host === baseHost || (includeSubdomains && host.endsWith(`.${baseHost}`));
    } catch {
      return false;
    }
  };

  const titles = new Map<string, { title?: string; description?: string }>();
  const fromSitemap = mode === "skip" ? Promise.resolve([]) : sitemapUrls(engine, start.origin, limit, deadline, { accept: inScope });
  const fromPage =
    mode === "only"
      ? Promise.resolve([] as string[])
      : scrapeUrl(engine, start.href, { formats: ["links"], timeout: engine.config.timeout }, { deadline, collectLinks: true })
          .then(({ links, linkTitles }) => {
            for (const [u, t] of Object.entries(linkTitles ?? {})) if (!titles.has(u)) titles.set(u, { title: t });
            return links ?? [];
          })
          .catch((err) => {
            log.debug("map: page scrape failed", { error: err instanceof Error ? err.message : String(err) });
            return [] as string[];
          });
  const fromSearch =
    mode === "only" || internals.skipSearch
      ? Promise.resolve([] as string[])
      : Promise.all(
          [1, 2].map((page) =>
            searxng(engine, { q: `site:${baseHost}${req.search ? ` ${req.search}` : ""}`, categories: "general" }, page, deadline).catch(
              () => [],
            ),
          ),
        ).then((pages) =>
          pages.flat().flatMap((r) => {
            if (!r.url) return [];
            titles.set(r.url, { title: clean(r.title), description: clean(r.content) });
            return [r.url];
          }),
        );

  const [sm, page, found] = await Promise.all([fromSitemap, fromPage, fromSearch]);
  const ordered = req.search ? [...found, start.href, ...page, ...sm] : [start.href, ...page, ...sm, ...found];

  const seen = new Map<string, MapLink>();
  for (const raw of ordered) {
    const url = normalizeUrl(raw, ignoreQuery);
    if (!url || !inScope(url) || !inPath(url) || seen.has(url)) continue;
    const meta = titles.get(raw) ?? titles.get(url);
    seen.set(url, { url, ...(meta?.title ? { title: meta.title } : {}), ...(meta?.description ? { description: meta.description } : {}) });
  }
  let links = [...seen.values()];

  if (req.search) {
    const tokens = req.search.toLowerCase().split(/\s+/).filter(Boolean);
    const score = (l: MapLink) => {
      const hay = `${safeDecode(l.url)} ${l.title ?? ""} ${l.description ?? ""}`.toLowerCase();
      return tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    };
    const scored = links.map((l, i) => ({ l, s: score(l), i }));
    const matching = scored.filter((x) => x.s > 0);
    links = (matching.length ? matching : scored).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.l);
  }
  links = links.slice(0, limit);
  if (links.length <= 1)
    warning = "Only one or no URLs were found. The site may block crawlers, need JavaScript, or the path filters may be too narrow.";
  return { id: crypto.randomUUID(), links, ...(warning ? { warning } : {}) };
}
