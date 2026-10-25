import pLimit from "p-limit";
import { AppError, badRequest, toAppError } from "../errors.ts";
import { log } from "../log.ts";
import type { Document, SearchData, SearchRequest } from "../schemas.ts";
import type { Engine } from "./engine.ts";
import { assertScrapeCapabilities, scrapeUrl } from "./scrape.ts";

interface SearxResult {
  url?: string;
  title?: string;
  content?: string;
  publishedDate?: string | null;
  thumbnail?: string;
  thumbnail_src?: string;
  img_src?: string;
  resolution?: string;
  category?: string;
}

interface SearxQuery {
  q: string;
  categories: string;
  timeRange?: string;
  language?: string;
}

const MAX_PAGES = 5;
const TIME_RANGES: Record<string, string> = { h: "day", d: "day", w: "week", m: "month", y: "year" };

// SearXNG marks matched terms with private-use characters.
export const clean = (s: string | undefined | null) =>
  (s ?? "")
    .replace(/[\ue000\ue001]/g, "")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function hostMatches(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const d = domain.toLowerCase().replace(/^\*?\./, "");
    return host === d || host.endsWith(`.${d}`);
  } catch {
    return false;
  }
}

export async function searxng(engine: Engine, query: SearxQuery, pageno: number, signal?: AbortSignal): Promise<SearxResult[]> {
  const params = new URLSearchParams({ q: query.q, format: "json", categories: query.categories, pageno: String(pageno) });
  if (query.timeRange) params.set("time_range", query.timeRange);
  if (query.language) params.set("language", query.language);
  const { timeout, searxngUrl } = engine.config;
  const deadline = AbortSignal.timeout(timeout);
  const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let res: Response;
  try {
    res = await fetch(`${searxngUrl}/search?${params}`, { headers: { accept: "application/json" }, signal: sig });
  } catch (err) {
    if (deadline.aborted) throw new AppError(408, "TIMEOUT", `SearXNG request timed out after ${timeout}ms`);
    if (signal?.aborted) throw new AppError(408, "TIMEOUT", "SearXNG request cancelled");
    throw new AppError(
      502,
      "SEARCH_BACKEND_UNAVAILABLE",
      `Cannot reach SearXNG at ${searxngUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const hint = res.status === 403 ? " (is the json format enabled in SearXNG settings.yml?)" : "";
    throw new AppError(502, "SEARCH_BACKEND_ERROR", `SearXNG returned HTTP ${res.status}${hint}`);
  }
  let body: { results?: SearxResult[] };
  try {
    body = (await res.json()) as { results?: SearxResult[] };
  } catch {
    if (deadline.aborted) throw new AppError(408, "TIMEOUT", `SearXNG request timed out after ${timeout}ms`);
    if (signal?.aborted) throw new AppError(408, "TIMEOUT", "SearXNG request cancelled");
    const type = res.headers.get("content-type") ?? "none";
    throw new AppError(502, "SEARCH_BACKEND_ERROR", `SearXNG returned a non-JSON response (content-type: ${type})`);
  }
  return body.results ?? [];
}

/** Runs one SearXNG query across pages until `want` results pass `accept`. */
async function collect(
  engine: Engine,
  query: SearxQuery,
  want: number,
  accept: (r: SearxResult) => boolean,
  signal?: AbortSignal,
): Promise<SearxResult[]> {
  const seen = new Set<string>();
  const out: SearxResult[] = [];
  for (let page = 1; page <= MAX_PAGES && out.length < want; page++) {
    const results = await searxng(engine, query, page, signal);
    let added = 0;
    for (const r of results) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      if (!accept(r)) continue;
      out.push(r);
      added++;
      if (out.length >= want) break;
    }
    if (results.length === 0 || added === 0) break;
  }
  return out;
}

function sourceList(req: SearchRequest): Array<"web" | "news" | "images"> {
  const list = (req.sources?.length ? req.sources : ["web" as const]).map((s) => (typeof s === "string" ? s : s.type));
  return Array.from(new Set(list));
}

export async function search(engine: Engine, req: SearchRequest, signal?: AbortSignal): Promise<{ data: SearchData; warning?: string }> {
  const limit = req.limit ?? 5;
  // Caps the per-domain fan-out so one request cannot start an unbounded number of concurrent SearXNG queries.
  const domainLimit = pLimit(4);
  const wantsScrape = !!req.scrapeOptions?.formats?.length;
  if (wantsScrape) assertScrapeCapabilities(engine, req.scrapeOptions);
  if (req.includeDomains?.length && req.excludeDomains?.length) {
    throw new AppError(400, "BAD_REQUEST", "includeDomains and excludeDomains cannot both be specified");
  }
  const timeoutSignal = req.timeout ? AbortSignal.timeout(req.timeout) : undefined;
  const sig = [signal, timeoutSignal].filter((s): s is AbortSignal => !!s);
  const combined = sig.length ? AbortSignal.any(sig) : undefined;

  const categories = (req.categories ?? []).map((c) => (typeof c === "string" ? c : c.type));
  const mods: string[] = [];
  const webCats = new Set<string>();
  for (const c of categories) {
    if (c === "github") mods.push("site:github.com");
    else if (c === "pdf") mods.push("filetype:pdf");
    else if (c === "gov") mods.push("site:gov");
    else if (c === "research") webCats.add("science");
    else if (c === "developer") webCats.add("it");
  }
  for (const d of req.excludeDomains ?? []) mods.push(`-site:${d}`);
  const timeRange = req.tbs?.match(/qdr:([hdwmy])/)?.[1];
  const base = {
    timeRange: timeRange ? TIME_RANGES[timeRange] : undefined,
    language: req.lang,
  };
  const q = [req.query, ...mods].join(" ");
  const accept = (r: SearxResult) => {
    if (!r.url) return false;
    if (req.excludeDomains?.some((d) => hostMatches(r.url as string, d))) return false;
    if (req.includeDomains?.length && !req.includeDomains.some((d) => hostMatches(r.url as string, d))) return false;
    return true;
  };

  const run = async (categories: string): Promise<SearxResult[]> => {
    if (!req.includeDomains?.length) return collect(engine, { ...base, q, categories }, limit, accept, combined);
    // One site: query per domain, interleaved, since multi-site syntax is not portable across engines.
    const perDomain = await Promise.all(
      req.includeDomains.map((d) =>
        domainLimit(() => collect(engine, { ...base, q: `${q} site:${d}`, categories }, limit, accept, combined)),
      ),
    );
    const merged: SearxResult[] = [];
    const seen = new Set<string>();
    for (let i = 0; merged.length < limit && perDomain.some((list) => i < list.length); i++) {
      for (const list of perDomain) {
        const r = list[i];
        if (r?.url && !seen.has(r.url) && merged.length < limit) {
          seen.add(r.url);
          merged.push(r);
        }
      }
    }
    return merged;
  };

  const data: SearchData = {};
  const warnings: string[] = [];
  const failures: unknown[] = [];
  let succeeded = 0;
  await Promise.all(
    sourceList(req).map(async (source) => {
      try {
        if (source === "web") {
          const results = await run(webCats.size ? [...webCats].join(",") : "general");
          data.web = results.map((r, i) => ({
            url: r.url as string,
            title: clean(r.title),
            description: clean(r.content),
            position: i + 1,
          }));
        } else if (source === "news") {
          const results = await run("news");
          data.news = results.map((r, i) => ({
            url: r.url,
            title: clean(r.title),
            snippet: clean(r.content),
            date: r.publishedDate ?? undefined,
            imageUrl: r.thumbnail || r.img_src || undefined,
            position: i + 1,
          }));
        } else if (source === "images") {
          const results = await run("images");
          data.images = results.map((r, i) => {
            const [w, h] = (r.resolution ?? "").split(/\s*[x×]\s*/).map((n) => Number.parseInt(n, 10));
            return {
              url: r.url,
              title: clean(r.title),
              imageUrl: r.img_src || r.thumbnail_src || undefined,
              imageWidth: Number.isFinite(w) ? w : undefined,
              imageHeight: Number.isFinite(h) ? h : undefined,
              position: i + 1,
            };
          });
        } else {
          throw badRequest(`Unknown source: ${source}`);
        }
        succeeded++;
      } catch (err) {
        failures.push(err);
        warnings.push(`${source}: ${toAppError(err).message}`);
      }
    }),
  );
  // Fail the whole request only when no source succeeded; partial results come back with a warning.
  if (!succeeded && failures.length) throw failures[0];

  if (wantsScrape) {
    const scrapeOne = async <T extends { url?: string }>(item: T): Promise<T & Document> => {
      if (!item.url) return item;
      try {
        const { document } = await scrapeUrl(engine, item.url, req.scrapeOptions, { signal: combined });
        return { ...item, ...document };
      } catch (err) {
        const e = toAppError(err);
        log.debug("search result scrape failed", { url: item.url, error: e.message });
        return { ...item, metadata: { sourceURL: item.url, statusCode: e.status, error: e.message } };
      }
    };
    if (data.web) data.web = await Promise.all(data.web.map(scrapeOne));
    if (data.news) data.news = await Promise.all(data.news.map(scrapeOne));
  }

  return { data, warning: warnings.length ? warnings.join("; ") : undefined };
}
