import type { Result, SearxngClient, TimeRange } from "@searxng-js/searxng";
import { z } from "zod";

/** The time one search has. */
export interface CallTime {
  signal?: AbortSignal;
  deadlineAt?: number;
}

const SourceName = z.enum(["web", "news", "images"]);
const CategoryName = z.enum(["github", "research", "pdf", "developer", "gov"]);
const Source = z.union([SourceName, z.object({ type: SourceName }).loose()]);
const Category = z.union([CategoryName, z.object({ type: CategoryName }).loose()]);

/** Firecrawl v2 `/v2/search` input: what sex accepts and what SearXNG can answer. */
export const SearchRequest = z
  .object({
    query: z.string().min(1).max(2000),
    limit: z.number().int().min(1).max(100).optional(),
    sources: z.array(Source).optional(),
    categories: z.array(Category).optional(),
    includeDomains: z.array(z.string()).max(50).optional(),
    excludeDomains: z.array(z.string()).max(50).optional(),
    /** `qdr:h`, `qdr:d`, `qdr:w`, `qdr:m`, `qdr:y`; `qdr:h` is answered as `qdr:d`. */
    tbs: z.string().optional(),
    /** Strict safe search. */
    safe: z.boolean().optional(),
    /** A SearXNG language tag such as `en`, `zh-CN` or `all`. */
    lang: z.string().optional(),
    timeout: z.number().int().min(1000).max(300_000).optional(),
    /** Accepted for Firecrawl compatibility; results are not scraped here. */
    scrapeOptions: z.unknown().optional(),
    /** Accepted for Firecrawl compatibility; reported as unsupported. */
    country: z.string().optional(),
    location: z.string().optional(),
    zeroDataRetention: z.boolean().optional(),
    ignoreInvalidURLs: z.boolean().optional(),
  })
  .loose();
export type SearchRequest = z.infer<typeof SearchRequest>;

export interface SearchWebResult {
  url: string;
  title?: string;
  description?: string;
  position: number;
  category?: string;
}

export interface SearchNewsResult {
  url: string;
  title?: string;
  snippet?: string;
  date?: string;
  imageUrl?: string;
  position: number;
  category?: string;
}

export interface SearchImageResult {
  url: string;
  title?: string;
  imageUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  position: number;
}

export interface SearchData {
  web?: SearchWebResult[];
  news?: SearchNewsResult[];
  images?: SearchImageResult[];
}

export class SearchBackendError extends Error {
  readonly status: number;
  /** Whether another backend could answer the same search later (instance down, rate limit, timeout). */
  readonly transient: boolean;

  constructor(message: string, status = 502, options?: ErrorOptions & { transient?: boolean }) {
    super(message, options);
    this.name = "SearchBackendError";
    this.status = status;
    this.transient = options?.transient ?? (status === 408 || status === 429 || status >= 500);
  }
}

/** Firecrawl's categories on SearXNG's. */
const CATEGORY: Record<string, string> = {
  github: "it",
  developer: "it",
  research: "science",
  pdf: "files",
  gov: "general",
};

/** `tbs` on SearXNG's `time_range`. */
const TBS: Record<string, TimeRange> = {
  "qdr:h": "day",
  "qdr:d": "day",
  "qdr:w": "week",
  "qdr:m": "month",
  "qdr:y": "year",
};

const MAX_INCLUDE_DOMAINS = 5;
const DEFAULT_LIMIT = 10;

/**
 * Searches `client` in the Firecrawl v2 shape. `includeDomains` costs one query per domain (SearXNG cannot OR `site:`),
 * so only the first `MAX_INCLUDE_DOMAINS` are used.
 */
export async function searchWeb(
  client: SearxngClient,
  request: SearchRequest,
  time?: CallTime,
): Promise<{ data: SearchData; warnings: string[] }> {
  const warnings: string[] = [];
  const limit = request.limit ?? DEFAULT_LIMIT;
  if (request.scrapeOptions) warnings.push("scrapeOptions is not supported: results are not scraped");
  if (request.country) warnings.push("country is not supported and was ignored");
  if (request.location) warnings.push("location is not supported and was ignored");
  if (request.zeroDataRetention) warnings.push("zeroDataRetention is not supported");
  const sources = (request.sources ?? ["web"]).map(normalize).filter(Boolean);
  const categories = (request.categories ?? []).map(normalize).filter(Boolean);
  const domains = request.includeDomains?.slice(0, MAX_INCLUDE_DOMAINS) ?? [];
  if (request.includeDomains && request.includeDomains.length > MAX_INCLUDE_DOMAINS) {
    warnings.push(`Only the first ${MAX_INCLUDE_DOMAINS} includeDomains are searched`);
  }

  let timeRange: TimeRange | undefined;
  if (request.tbs) {
    timeRange = TBS[request.tbs.toLowerCase()];
    if (request.tbs.toLowerCase() === "qdr:h")
      warnings.push("qdr:h is answered as qdr:d (SearXNG has no hourly range)");
    if (!timeRange) warnings.push(`tbs "${request.tbs}" is not supported`);
  }

  const signals: AbortSignal[] = [];
  if (time?.signal) signals.push(time.signal);
  if (time?.deadlineAt !== undefined) signals.push(AbortSignal.timeout(Math.max(1, time.deadlineAt - Date.now())));
  if (request.timeout) signals.push(AbortSignal.timeout(request.timeout));
  const signal = signals.length ? AbortSignal.any(signals) : undefined;

  const excludes = (request.excludeDomains ?? []).map((domain) => `-site:${domain}`);
  const baseQuery = [request.query, ...excludes].join(" ");
  const queries: Array<{ source: string; domain?: string; q: string; categories: string }> = [];
  for (const source of sources) {
    const base =
      source === "news"
        ? "news"
        : source === "images"
          ? "images"
          : categories
              .map((c) => CATEGORY[c])
              .filter(Boolean)
              .join(",") || "general";
    if (domains.length === 0) queries.push({ source, q: baseQuery, categories: base });
    else
      for (const domain of domains)
        queries.push({ source, domain, q: `${baseQuery} site:${domain}`, categories: base });
  }

  const results = new Map<string, Result[]>();
  const failures: string[] = [];
  await Promise.all(
    queries.map(async ({ source, domain, q, categories: category }) => {
      try {
        const response = await client.search(
          {
            q,
            categories: category,
            language: request.lang,
            safeSearch: request.safe ? 2 : undefined,
            timeRange,
          },
          { signal },
        );
        results.set(source, [...(results.get(source) ?? []), ...response.results]);
      } catch (err) {
        failures.push(`${source}${domain ? ` (${domain})` : ""}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  if (failures.length === queries.length && queries.length > 0) {
    throw new SearchBackendError(`SearXNG search failed: ${failures[0]}`);
  }
  for (const failure of failures) warnings.push(failure);

  const data: SearchData = {};
  for (const source of sources) {
    const seen = new Set<string>();
    const list = (results.get(source) ?? []).filter((result) => {
      if (!result.url || seen.has(result.url)) return false;
      seen.add(result.url);
      return true;
    });
    if (source === "web") data.web = list.slice(0, limit).map(toWeb);
    else if (source === "news") data.news = list.slice(0, limit).map(toNews);
    else data.images = list.slice(0, limit).map(toImage);
  }
  return { data, warnings };
}

function normalize(value: string | { type: string } | undefined): string {
  return typeof value === "string" ? value : (value?.type ?? "");
}

function toWeb(result: Result, index: number): SearchWebResult {
  return {
    url: result.url as string,
    title: clean(result.title),
    description: clean(result.content),
    position: index + 1,
    category: result.category || undefined,
  };
}

function toNews(result: Result, index: number): SearchNewsResult {
  return {
    url: result.url as string,
    title: clean(result.title),
    snippet: clean(result.content),
    date: result.publishedDate ?? undefined,
    imageUrl: result.thumbnail || result.img_src || undefined,
    position: index + 1,
    category: result.category || undefined,
  };
}

function toImage(result: Result, index: number): SearchImageResult {
  const [width, height] = String(result.resolution ?? "")
    .split(/\s*[x×]\s*/)
    .map((part) => Number.parseInt(part, 10));
  return {
    url: result.url as string,
    title: clean(result.title),
    imageUrl: result.img_src || result.thumbnail_src || undefined,
    imageWidth: Number.isFinite(width) ? width : undefined,
    imageHeight: Number.isFinite(height) ? height : undefined,
    position: index + 1,
  };
}

function clean(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return (
    text
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim() || undefined
  );
}
