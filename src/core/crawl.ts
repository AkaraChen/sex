import type { z } from "zod";
import { badRequest, toAppError } from "../errors.ts";
import { log } from "../log.ts";
import { CrawlRequest } from "../schemas.ts";
import type { Engine } from "./engine.ts";
import { type JobRecord, type JobStore, sendWebhook, validateWebhook } from "./jobs/index.ts";
import { normalizeUrl, sitemapUrls } from "./map.ts";
import { assertPublicUrl, decodeBody, parseHttpUrl, safeFetch } from "./net.ts";
import { parseRobots, type Robots, robotsTextFor } from "./robots.ts";
import { assertScrapeCapabilities, scrapeUrl } from "./scrape.ts";

/** The crawl options an LLM may derive from a prompt, validated with the same rules as the API. */
const Derivable = CrawlRequest.pick({
  includePaths: true,
  excludePaths: true,
  maxDiscoveryDepth: true,
  crawlEntireDomain: true,
  allowSubdomains: true,
  allowExternalLinks: true,
  sitemap: true,
  limit: true,
}).partial();
const DERIVABLE_KEYS = Object.keys(Derivable.shape);
const derivableFieldSchemas = Derivable.shape as Record<string, z.ZodType>;

const isValidRegex = (p: string) => {
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
};

/** Keeps only derived options that have the right type; drops invalid regexes and logs what was discarded. */
function validateDerived(out: Record<string, unknown>): Record<string, unknown> {
  const valid: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(out)) {
    if (!DERIVABLE_KEYS.includes(key)) continue;
    const parsed = derivableFieldSchemas[key]?.safeParse(value);
    if (!parsed?.success) {
      log.debug("dropped prompt-derived crawl option", { key, reason: "invalid type" });
      continue;
    }
    if (key === "includePaths" || key === "excludePaths") {
      const patterns = (parsed.data as string[]).filter(isValidRegex);
      if (patterns.length !== (parsed.data as string[]).length)
        log.debug("dropped invalid regex from prompt-derived crawl option", { key });
      valid[key] = patterns;
    } else {
      valid[key] = parsed.data;
    }
  }
  return valid;
}

/** Uses the LLM to turn a natural-language prompt into crawl options. */
export async function crawlParamsFromPrompt(engine: Engine, url: string, prompt: string): Promise<Record<string, unknown>> {
  engine.llm.require("Crawl prompts");
  const out = await engine.llm.crawlOptions(url, prompt);
  return validateDerived(out ?? {});
}

function compile(patterns: string[] | undefined, name: string): RegExp[] {
  return (patterns ?? []).map((p) => {
    try {
      return new RegExp(p);
    } catch {
      throw badRequest(`Invalid regex in ${name}: ${p}`);
    }
  });
}

const stripWww = (host: string) => host.replace(/^www\./, "");

/** Key used to recognise near-duplicate URLs (www, trailing slash, index pages, scheme). */
function similarityKey(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/index\.(html?|php)$/i, "/").replace(/\/+$/, "");
  return `${stripWww(u.hostname)}${path}${u.search}`;
}

/** Everything a worker needs to filter links for one crawl, rebuilt from the stored request. */
interface CrawlPlan {
  req: CrawlRequest;
  start: URL;
  limit: number;
  includes: RegExp[];
  excludes: RegExp[];
  robots?: Robots;
  baseHost: string;
  basePath: string;
}

/**
 * The directory the crawl stays within. `/docs/` and `/docs` both mean the `/docs` section; `/docs/index.html`
 * means the `/docs/` directory; `/` is the whole site.
 */
function basePathOf(pathname: string): string {
  if (pathname.endsWith("/")) return pathname;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (lastSegment.includes(".")) return pathname.replace(/\/[^/]*$/, "/");
  return `${pathname}/`;
}

const plans = new Map<string, CrawlPlan>();

async function planFor(store: JobStore, job: JobRecord): Promise<CrawlPlan> {
  const cached = plans.get(job.id);
  // Plans are built after crawl-start stored robots.txt, so they never need refreshing.
  if (cached) return cached;
  const robotsTxt = await store.robotsTxt(job.id);
  const req = job.options as unknown as CrawlRequest;
  const start = new URL(job.url as string);
  const plan: CrawlPlan = {
    req,
    start,
    limit: req.limit ?? 10_000,
    includes: compile(req.includePaths, "includePaths"),
    excludes: compile(req.excludePaths, "excludePaths"),
    robots: robotsTxt ? parseRobots(robotsTxt, req.robotsUserAgent ?? "sex") : undefined,
    baseHost: stripWww(start.hostname),
    basePath: basePathOf(start.pathname),
  };
  if (plans.size > 200) plans.delete(plans.keys().next().value as string);
  plans.set(job.id, plan);
  return plan;
}

function matchesFilters(plan: CrawlPlan, url: URL): boolean {
  const target = plan.req.regexOnFullURL ? url.href : url.pathname;
  if (plan.excludes.some((r) => r.test(target))) return false;
  if (plan.includes.length && !plan.includes.some((r) => r.test(target))) return false;
  return true;
}

function inScope(plan: CrawlPlan, url: URL): boolean {
  const host = stripWww(url.hostname);
  const sameSite = host === plan.baseHost || (!!plan.req.allowSubdomains && host.endsWith(`.${plan.baseHost}`));
  if (!sameSite) return !!plan.req.allowExternalLinks;
  return (
    !!plan.req.crawlEntireDomain ||
    url.pathname.startsWith(plan.basePath) ||
    url.pathname === plan.basePath.slice(0, -1) ||
    url.href === plan.start.href
  );
}

/** `defaults` apply only where neither the prompt nor the request sets an option. */
export async function startCrawl(engine: Engine, input: CrawlRequest, defaults: Partial<CrawlRequest> = {}): Promise<JobRecord> {
  const start = parseHttpUrl(input.url.trim());
  await assertPublicUrl(start, engine.config.allowPrivateNetwork);
  assertScrapeCapabilities(engine, input.scrapeOptions);
  await validateWebhook(engine, input.webhook);
  const derived = input.prompt ? await crawlParamsFromPrompt(engine, start.href, input.prompt) : {};
  // Explicit options win over prompt-derived ones, which win over defaults.
  const req = {
    ...defaults,
    ...derived,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
  } as CrawlRequest;
  compile(req.includePaths, "includePaths");
  compile(req.excludePaths, "excludePaths");

  const { store, queue } = engine.jobs;
  const job = await store.create({ kind: "crawl", url: start.href, options: req as unknown as Record<string, unknown> });
  await store.incr(job.id, "pending", 1);
  try {
    await queue.add([{ task: { type: "crawl-start", jobId: job.id, taskId: crypto.randomUUID() } }]);
  } catch (err) {
    // Nothing will run or settle this task, so undo the count and fail the job.
    await store.incr(job.id, "pending", -1);
    await store.finish(job.id, "failed", { error: toAppError(err).message });
    throw err;
  }
  return job;
}

/** Filters candidate links and enqueues the new ones as page tasks, respecting limit and delay. */
async function enqueueLinks(engine: Engine, job: JobRecord, plan: CrawlPlan, links: string[], depth: number, isStart = false) {
  const { store, queue } = engine.jobs;
  const { req } = plan;
  if (req.maxDiscoveryDepth !== undefined && depth > req.maxDiscoveryDepth) return;
  const ignoreQuery = req.ignoreQueryParameters ?? false;
  const dedupe = req.deduplicateSimilarURLs ?? true;

  // ignoreQueryParameters only affects deduplication: the URL fetched keeps its query string.
  const candidates = new Map<string, string>();
  for (const raw of links) {
    const fetchUrl = normalizeUrl(raw, false);
    const keyUrl = normalizeUrl(raw, ignoreQuery);
    if (!fetchUrl || !keyUrl) continue;
    const url = new URL(fetchUrl);
    if (!isStart && (!inScope(plan, url) || !matchesFilters(plan, url))) continue;
    const key = dedupe ? similarityKey(keyUrl) : keyUrl;
    if (!candidates.has(key)) candidates.set(key, fetchUrl);
  }
  if (!candidates.size) return;

  const keys = [...candidates.keys()];
  const fresh = await store.markSeen(job.id, keys);
  const accepted: string[] = [];
  for (const [i, key] of keys.entries()) {
    if (!fresh[i]) continue;
    const url = candidates.get(key) as string;
    if (plan.robots && !plan.robots.isAllowed(url)) await store.pushRobotsBlocked(job.id, url);
    else accepted.push(url);
  }
  if (!accepted.length) return;

  // Reserve slots under the limit atomically, handing back any overshoot.
  const scheduled = await store.incr(job.id, "scheduled", accepted.length);
  const overshoot = Math.max(0, scheduled - plan.limit);
  const allowed = accepted.slice(0, Math.max(0, accepted.length - overshoot));
  if (overshoot) await store.incr(job.id, "scheduled", -Math.min(overshoot, accepted.length));
  if (!allowed.length) return;

  await store.incr(job.id, "total", allowed.length);
  await store.incr(job.id, "pending", allowed.length);
  let delays: number[] = allowed.map(() => 0);
  if (req.delay) {
    const interval = req.delay * 1000;
    const now = Date.now();
    const start = await store.reserveSlots(job.id, allowed.length, interval, now);
    delays = allowed.map((_, i) => Math.max(0, start + i * interval - now));
  }
  const tasks = allowed.map((url, i) => ({
    task: { type: "page" as const, jobId: job.id, taskId: crypto.randomUUID(), url, depth },
    delayMs: delays[i],
  }));
  try {
    await queue.add(tasks);
  } catch (err) {
    await store.incr(job.id, "pending", -allowed.length);
    throw err;
  }
}

export async function handleCrawlStart(engine: Engine, jobId: string) {
  const { store } = engine.jobs;
  try {
    const job = await store.get(jobId);
    if (job?.status !== "scraping") return;
    const req = job.options as unknown as CrawlRequest;
    const start = new URL(job.url as string);
    sendWebhook(engine.config, job, "started");

    if (!req.ignoreRobotsTxt) {
      const robotsTxt = await safeFetch(`${start.origin}/robots.txt`, {
        timeout: 10_000,
        allowPrivateNetwork: engine.config.allowPrivateNetwork,
        userAgent: engine.config.userAgent,
        maxBodyBytes: engine.config.maxBodyBytes,
      })
        .then((res) => robotsTextFor(res.status, () => decodeBody(res.body, res.contentType)))
        .catch(() => "");
      await store.setRobotsTxt(jobId, robotsTxt);
    }
    const plan = await planFor(store, job);
    // The start URL is crawled in every mode; the root site and sitemapped pages have discovery depth 0.
    const mode = req.sitemap ?? "include";
    await enqueueLinks(engine, job, plan, [start.href], 0, true);
    if (mode !== "skip") {
      const urls = await sitemapUrls(engine, start.origin, plan.limit * 2).catch(() => []);
      await enqueueLinks(engine, job, plan, urls, 0);
    }
  } catch (err) {
    const e = toAppError(err);
    if (await store.finish(jobId, "failed", { error: e.message })) {
      const job = await store.get(jobId);
      if (job) sendWebhook(engine.config, job, "failed", [], e.message);
    }
  }
}

/**
 * Pages that redirected somewhere else are only kept if the target would have been crawled as a link:
 * in scope, matching the filters, allowed by robots and not seen yet. Records why when it is rejected.
 * The start URL is exempt, so its cross-domain redirects behave as before.
 */
async function acceptRedirect(
  store: JobStore,
  job: JobRecord,
  plan: CrawlPlan,
  url: string,
  finalUrl: string | undefined,
): Promise<boolean> {
  const fetched = normalizeUrl(url, false);
  const target = finalUrl ? normalizeUrl(finalUrl, false) : null;
  if (!fetched || !target) return true;
  const ignoreQuery = plan.req.ignoreQueryParameters ?? false;
  const keyOf = (u: string) => {
    const keyUrl = normalizeUrl(u, ignoreQuery) as string;
    return (plan.req.deduplicateSimilarURLs ?? true) ? similarityKey(keyUrl) : keyUrl;
  };
  if (keyOf(target) === keyOf(fetched)) return true;
  const targetUrl = new URL(target);
  if (plan.robots && !plan.robots.isAllowed(target)) {
    await store.pushRobotsBlocked(job.id, target);
    return false;
  }
  if (!inScope(plan, targetUrl) || !matchesFilters(plan, targetUrl)) {
    await store.pushError(job.id, {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      url,
      error: `Redirected to ${target}, which is outside the crawl scope`,
    });
    return false;
  }
  // A target that was already seen is crawled (or being crawled) under its own task.
  return (await store.markSeen(job.id, [keyOf(target)]))[0] === true;
}

export async function handleCrawlPage(engine: Engine, job: JobRecord, url: string, depth: number) {
  const { store } = engine.jobs;
  try {
    const plan = await planFor(store, job);
    const { document, links } = await scrapeUrl(engine, url, plan.req.scrapeOptions, { collectLinks: true });
    if ((await store.get(job.id))?.status !== "scraping") return;
    const start = normalizeUrl(plan.start.href, false);
    if (url !== start && !(await acceptRedirect(store, job, plan, url, document.metadata?.url as string | undefined))) return;
    // The start page always feeds discovery but only counts as a result if it passes the filters.
    if (url !== start || matchesFilters(plan, new URL(url))) {
      await store.pushDocument(job.id, document);
      await store.incr(job.id, "completed", 1);
      sendWebhook(engine.config, job, "page", [document]);
    }
    // `scheduled` only grows toward `limit` and then stays there, so a full crawl has nothing left to discover.
    const full = job.scheduled >= plan.limit;
    if ((plan.req.sitemap ?? "include") !== "only" && !full) await enqueueLinks(engine, job, plan, links ?? [], depth + 1);
  } catch (err) {
    await store.pushError(job.id, { id: crypto.randomUUID(), timestamp: new Date().toISOString(), url, error: toAppError(err).message });
  }
}
