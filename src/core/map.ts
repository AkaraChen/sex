import { gunzipSync } from "node:zlib";
import { log } from "../log.ts";
import type { MapLink, MapRequest } from "../schemas.ts";
import type { Engine } from "./engine.ts";
import { assertPublicUrl, decodeBody, parseHttpUrl, safeFetch } from "./net.ts";
import { fetchRobots } from "./robots.ts";
import { scrapeUrl } from "./scrape.ts";
import { clean, searxng } from "./search.ts";

const MAX_SITEMAPS = 50;
const MAX_SITEMAP_BYTES = 25 * 1024 * 1024;

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const decodeXml = (s: string) =>
  s
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();

/** Collects page URLs from robots.txt sitemaps and /sitemap.xml, following sitemap indexes. */
export async function sitemapUrls(engine: Engine, origin: string, max: number, signal?: AbortSignal): Promise<string[]> {
  const robots = await fetchRobots(engine, origin, "sex", signal);
  const queue = Array.from(new Set([...robots.sitemaps, `${origin}/sitemap.xml`]));
  const visited = new Set<string>();
  const urls = new Set<string>();
  while (queue.length && visited.size < MAX_SITEMAPS && urls.size < max) {
    const sm = queue.shift() as string;
    if (visited.has(sm)) continue;
    visited.add(sm);
    try {
      const res = await safeFetch(sm, {
        timeout: 15_000,
        signal,
        allowPrivateNetwork: engine.config.allowPrivateNetwork,
        userAgent: engine.config.userAgent,
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
        else if (urls.size < max) urls.add(loc);
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

export async function mapSite(engine: Engine, req: MapRequest, signal?: AbortSignal): Promise<MapLink[]> {
  const start = parseHttpUrl(req.url.trim());
  await assertPublicUrl(start, engine.config.allowPrivateNetwork);
  const limit = req.limit ?? 5000;
  const mode = req.sitemap ?? "include";
  const includeSubdomains = req.includeSubdomains ?? true;
  const ignoreQuery = req.ignoreQueryParameters ?? true;
  const baseHost = stripWww(start.hostname);
  const timeoutSignal = AbortSignal.timeout(req.timeout ?? 60_000);
  const sig = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const inScope = (url: string) => {
    try {
      const host = stripWww(new URL(url).hostname);
      return host === baseHost || (includeSubdomains && host.endsWith(`.${baseHost}`));
    } catch {
      return false;
    }
  };

  const titles = new Map<string, { title?: string; description?: string }>();
  const fromSitemap = mode === "skip" ? Promise.resolve([]) : sitemapUrls(engine, start.origin, limit * 2, sig);
  const fromPage =
    mode === "only"
      ? Promise.resolve([] as string[])
      : scrapeUrl(engine, start.href, { formats: ["links"], timeout: engine.config.timeout }, { signal: sig, collectLinks: true })
          .then(({ links, linkTitles }) => {
            for (const [u, t] of Object.entries(linkTitles ?? {})) if (!titles.has(u)) titles.set(u, { title: t });
            return links ?? [];
          })
          .catch((err) => {
            log.debug("map: page scrape failed", { error: err instanceof Error ? err.message : String(err) });
            return [] as string[];
          });
  const fromSearch =
    mode === "only"
      ? Promise.resolve([] as string[])
      : Promise.all(
          [1, 2].map((page) =>
            searxng(engine, { q: `site:${baseHost}${req.search ? ` ${req.search}` : ""}`, categories: "general" }, page, sig).catch(
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
    if (!url || !inScope(url) || seen.has(url)) continue;
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
  return links.slice(0, limit);
}
