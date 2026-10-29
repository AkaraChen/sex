import { AppError, badRequest, toAppError, unsupported } from "@searxng-js/sex-errors";
import type { SearxngService } from "@searxng-js/sex-searxng";
import type { LimitFunction } from "p-limit";
import { Deadline } from "./deadline.ts";
import { log } from "./log.ts";
import { matchesQueryOperators, planOperatorQuery } from "./operators.ts";
import type { Document, SearchData, SearchRequest } from "./schemas.ts";
import { assertScrapeCapabilities, type ScrapeContext, scrapeUrl } from "./scrape.ts";

/** What a search runs on: SearXNG, plus everything a scrape needs for `scrapeOptions`. */
export interface SearchContext extends ScrapeContext {
  readonly searxng: SearxngService;
  /** Caps the per-domain SearXNG queries of includeDomains across all concurrent searches. */
  readonly searchDomainLimit: LimitFunction;
}

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
  safe?: boolean;
}

const MAX_PAGES = 5;
/** Results per source when the request has no `limit`. The HTTP route asks for 10 (Firecrawl's default). */
export const DEFAULT_LIMIT = 5;
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

/** Wait before the one retry of a SearXNG request that failed on the network or with a 5xx. */
const RETRY_DELAY_MS = 400;

/** "engine: reason" for every engine SearXNG reports as unresponsive (captcha, timeout, ...). */
function unresponsiveEngines(body: { unresponsive_engines?: unknown }): string[] {
  const list = Array.isArray(body.unresponsive_engines) ? body.unresponsive_engines : [];
  return list.flatMap((e) => (Array.isArray(e) && typeof e[0] === "string" ? [`${e[0]}: ${e[1] ?? "unresponsive"}`] : []));
}

/** Queries SearXNG, retrying once on a retryable failure (network error, 5xx) within the caller's deadline. Unresponsive engines are appended to `unresponsive`. */
export async function searxng(
  engine: SearchContext,
  query: SearxQuery,
  pageno: number,
  deadline: Deadline,
  unresponsive?: string[],
): Promise<SearxResult[]> {
  try {
    return await searxngOnce(engine, query, pageno, deadline, unresponsive);
  } catch (err) {
    if (!AppError.isInstance(err) || !err.retryable) throw err;
    log.debug("retrying SearXNG request", { error: err.message });
    await deadline.sleep(RETRY_DELAY_MS, "before retrying the SearXNG request");
    return searxngOnce(engine, query, pageno, deadline, unresponsive);
  }
}

async function searxngOnce(
  engine: SearchContext,
  query: SearxQuery,
  pageno: number,
  deadline: Deadline,
  unresponsive?: string[],
): Promise<SearxResult[]> {
  const params = new URLSearchParams({ q: query.q, format: "json", categories: query.categories, pageno: String(pageno) });
  if (query.timeRange) params.set("time_range", query.timeRange);
  if (query.language) params.set("language", query.language);
  if (query.safe) params.set("safesearch", "2");
  const searxngUrl = await engine.searxng.url();
  // One request gets SEX_TIMEOUT of what the search has left.
  const request = deadline.slice(engine.config.timeout, { expiredCode: "TIMEOUT" });
  const what = "while querying SearXNG";
  let res: Response;
  try {
    res = await fetch(`${searxngUrl}/search?${params}`, { headers: { accept: "application/json" }, signal: request.signal });
  } catch (err) {
    request.throwIfAborted(what);
    throw new AppError(
      "SEARCH_BACKEND_UNAVAILABLE",
      `Cannot reach SearXNG at ${searxngUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const hint = res.status === 403 ? " (is the json format enabled in SearXNG settings.yml?)" : "";
    // A 5xx may pass on a second try; a 4xx is a configuration problem.
    throw new AppError("SEARCH_BACKEND_ERROR", `SearXNG returned HTTP ${res.status}${hint}`, undefined, { retryable: res.status >= 500 });
  }
  let body: { results?: SearxResult[]; unresponsive_engines?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    request.throwIfAborted(what);
    const type = res.headers.get("content-type") ?? "none";
    throw new AppError("SEARCH_BACKEND_ERROR", `SearXNG returned a non-JSON response (content-type: ${type})`);
  }
  unresponsive?.push(...unresponsiveEngines(body));
  return body.results ?? [];
}

/** Runs one SearXNG query across pages until `want` results pass `accept`. */
async function collect(
  engine: SearchContext,
  query: SearxQuery,
  want: number,
  accept: (r: SearxResult) => boolean,
  deadline: Deadline,
  unresponsive?: string[],
): Promise<SearxResult[]> {
  const seen = new Set<string>();
  const out: SearxResult[] = [];
  for (let page = 1; page <= MAX_PAGES && out.length < want; page++) {
    const results = await searxng(engine, query, page, deadline, unresponsive);
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

/** Firecrawl's `category` of a result: by URL first, then by the SearXNG category it came from. */
export function categoryOf(r: SearxResult): string | undefined {
  try {
    const url = new URL(r.url as string);
    const host = url.hostname.toLowerCase();
    if (host === "github.com" || host.endsWith(".github.com")) return "github";
    if (url.pathname.toLowerCase().endsWith(".pdf")) return "pdf";
    if (host.endsWith(".gov") || host.includes(".gov.")) return "gov";
  } catch {}
  if (r.category === "science") return "research";
  if (r.category === "it") return "developer";
  return undefined;
}

function sourceList(req: SearchRequest): Array<"web" | "news" | "images"> {
  const list = (req.sources?.length ? req.sources : ["web" as const]).map((s) => (typeof s === "string" ? s : s.type));
  return Array.from(new Set(list));
}

/** Trims and lowercases a domain filter, drops a leading `*.` / `.`, and rejects anything that is not a hostname. */
export function normalizeDomain(raw: string): string {
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^\*?\./, "");
  const label = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
  if (!new RegExp(`^${label}(\\.${label})*$`).test(d) || d.length > 253) throw badRequest(`Invalid domain in includeDomains: ${raw}`);
  return d;
}

export async function search(
  engine: SearchContext,
  req: SearchRequest,
  signal?: AbortSignal,
): Promise<{ data: SearchData; warning?: string }> {
  const limit = req.limit ?? DEFAULT_LIMIT;
  if (req.zeroDataRetention) throw unsupported("zeroDataRetention");
  const wantsScrape = !!req.scrapeOptions?.formats?.length;
  if (wantsScrape) assertScrapeCapabilities(engine, req.scrapeOptions);
  if (req.includeDomains?.length && req.excludeDomains?.length) {
    throw new AppError("BAD_REQUEST", "includeDomains and excludeDomains cannot both be specified");
  }
  const includeDomains = req.includeDomains?.map(normalizeDomain);
  // Without a request timeout the whole search (pages and scrapes) still gets a deadline. It keeps the plain TIMEOUT code
  // it always had: SCRAPE_TIMEOUT names the scrape of a page, not a search.
  const deadline = Deadline.start(req.timeout ?? Math.max(engine.config.timeout * 2, 60_000), { signal, expiredCode: "TIMEOUT" });
  const unresponsive: string[] = [];

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
  const warnings: string[] = [];
  if (req.tbs && !timeRange) warnings.push(`tbs "${req.tbs}" is not supported and was ignored (only qdr:h, qdr:d, qdr:w, qdr:m, qdr:y)`);
  for (const name of ["country", "location"] as const) {
    if (req[name]) warnings.push(`${name} is not supported by SearXNG and was ignored`);
  }
  const base = {
    timeRange: timeRange ? TIME_RANGES[timeRange] : undefined,
    language: req.lang,
    safe: req.safe,
  };
  const plan = planOperatorQuery(req.query);
  const q = [plan.query, ...mods].join(" ");
  const accept = (r: SearxResult) => {
    if (!r.url) return false;
    if (!matchesQueryOperators(r, plan)) return false;
    if (req.excludeDomains?.some((d) => hostMatches(r.url as string, d))) return false;
    if (includeDomains?.length && !includeDomains.some((d) => hostMatches(r.url as string, d))) return false;
    return true;
  };

  const run = async (categories: string): Promise<SearxResult[]> => {
    if (!includeDomains?.length) return collect(engine, { ...base, q, categories }, limit, accept, deadline, unresponsive);
    // One site: query per domain, interleaved, since multi-site syntax is not portable across engines.
    const perDomain = await Promise.all(
      includeDomains.map((d) =>
        engine.searchDomainLimit(() =>
          collect(engine, { ...base, q: `${q} site:${d}`, categories }, limit, accept, deadline, unresponsive),
        ),
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
            category: categoryOf(r),
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
            category: categoryOf(r),
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
  const empty = !data.web?.length && !data.news?.length && !data.images?.length;
  if (empty && unresponsive.length) warnings.push(`No results; unresponsive engines: ${[...new Set(unresponsive)].join(", ")}`);

  if (wantsScrape) {
    const scrapeOne = async <T extends { url?: string }>(item: T): Promise<T & Document> => {
      if (!item.url) return item;
      try {
        const { document } = await scrapeUrl(engine, item.url, req.scrapeOptions, { deadline });
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
