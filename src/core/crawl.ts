import type { z } from "zod";
import { toAppError } from "../errors.ts";
import { log } from "../log.ts";
import { CrawlRequest } from "../schemas.ts";
import { Deadline } from "./deadline.ts";
import type { Engine } from "./engine.ts";
import { type TaskEffects, taskEffects } from "./jobs/effects.ts";
import { type JobRecord, type JobStore, type OutboxTask, sendWebhook, validateWebhook } from "./jobs/index.ts";
import { normalizeUrl, sitemapUrls } from "./map.ts";
import { assertPublicUrl, decodeBody, parseHttpUrl, safeFetch } from "./net.ts";
import { parseRobots, type Robots, robotsTextFor } from "./robots.ts";
import { assertScrapeCapabilities, scrapeUrl } from "./scrape.ts";
import { basePathOf, compilePatterns, isAcceptablePattern, isSkippableFile, matchesPatterns } from "./url-filter.ts";

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
      const patterns = (parsed.data as string[]).filter(isAcceptablePattern);
      if (patterns.length !== (parsed.data as string[]).length)
        log.debug("dropped invalid or unsafe regex from prompt-derived crawl option", { key });
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
  const out = await engine.llm.crawlOptions(url, prompt, Deadline.unbounded());
  return validateDerived(out ?? {});
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
    includes: compilePatterns(req.includePaths, "includePaths"),
    excludes: compilePatterns(req.excludePaths, "excludePaths"),
    robots: robotsTxt ? parseRobots(robotsTxt, req.robotsUserAgent ?? "sex") : undefined,
    baseHost: stripWww(start.hostname),
    basePath: basePathOf(start.pathname),
  };
  if (plans.size > 200) plans.delete(plans.keys().next().value as string);
  plans.set(job.id, plan);
  return plan;
}

function matchesFilters(plan: CrawlPlan, url: URL): boolean {
  return matchesPatterns(plan.req.regexOnFullURL ? url.href : url.pathname, plan.includes, plan.excludes);
}

function isSameSite(plan: CrawlPlan, url: URL): boolean {
  const host = stripWww(url.hostname);
  return host === plan.baseHost || (!!plan.req.allowSubdomains && host.endsWith(`.${plan.baseHost}`));
}

/** External links are only followed from pages of the start site, and never to an external home page. */
function inScope(plan: CrawlPlan, url: URL, fromExternal = false): boolean {
  if (!isSameSite(plan, url)) return !!plan.req.allowExternalLinks && !fromExternal && !(url.pathname === "/" && !url.search);
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
  compilePatterns(req.includePaths, "includePaths");
  compilePatterns(req.excludePaths, "excludePaths");

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
async function enqueueLinks(
  engine: Engine,
  job: JobRecord,
  plan: CrawlPlan,
  links: string[],
  depth: number,
  owner: string | undefined,
  isStart = false,
  fromExternal = false,
) {
  const { store } = engine.jobs;
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
    if (!isStart && (isSkippableFile(url, engine.docs.enabled) || !inScope(plan, url, fromExternal) || !matchesFilters(plan, url)))
      continue;
    const key = dedupe ? similarityKey(keyUrl) : keyUrl;
    if (!candidates.has(key)) candidates.set(key, fetchUrl);
  }
  if (!candidates.size) return;

  const found = [...candidates].map(([key, url]) => ({ key, url, blocked: plan.robots ? !plan.robots.isAllowed(url) : false }));
  const scheduled = await store.schedule(job.id, owner, found, {
    limit: plan.limit,
    depth,
    intervalMs: (req.delay ?? 0) * 1000,
    now: Date.now(),
  });
  await queuePages(engine, job, scheduled);
}

/**
 * Queues page tasks that `store.schedule` recorded, then clears them from the outbox. A crash in between leaves them
 * there, and the owner's redelivery queues them again under the same taskIds, so the queue may hold a task twice
 * but a page is neither lost nor counted twice (its document, failure and settle are claimed per taskId).
 */
async function queuePages(engine: Engine, job: JobRecord, scheduled: OutboxTask[]) {
  if (!scheduled.length) return;
  const { store, queue } = engine.jobs;
  const now = Date.now();
  const ids = scheduled.map((t) => t.taskId);
  try {
    await queue.add(
      scheduled.map((t) => ({
        task: { type: "page" as const, jobId: job.id, taskId: t.taskId, url: t.url, depth: t.depth },
        delayMs: Math.max(0, t.runAt - now),
      })),
    );
  } catch (err) {
    // Nothing will run or settle these tasks (this one is not redelivered), so give their counts back.
    await store.released(job.id, ids, false);
    throw err;
  }
  await store.released(job.id, ids, true);
}

/** Queues the pages a crashed delivery of this task scheduled but did not get into the queue. */
async function resumeQueueing(engine: Engine, job: JobRecord, taskId: string | undefined) {
  if (taskId !== undefined) await queuePages(engine, job, await engine.jobs.store.outbox(job.id, taskId));
}

export async function handleCrawlStart(engine: Engine, jobId: string, taskId?: string) {
  const { store } = engine.jobs;
  try {
    const job = await store.get(jobId);
    if (job?.status !== "scraping") return;
    const req = job.options as unknown as CrawlRequest;
    const start = new URL(job.url as string);
    await resumeQueueing(engine, job, taskId);
    await taskEffects(engine, job, taskId).started();

    if (!req.ignoreRobotsTxt) {
      const robotsTxt = await safeFetch(`${start.origin}/robots.txt`, {
        deadline: Deadline.start(10_000),
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
    await enqueueLinks(engine, job, plan, [start.href], 0, taskId, true);
    if (mode !== "skip") {
      const blocked = new Set<string>();
      const accept = (raw: string) => {
        const norm = normalizeUrl(raw, false);
        if (!norm) return false;
        const url = new URL(norm);
        if (isSkippableFile(url, engine.docs.enabled) || !inScope(plan, url) || !matchesFilters(plan, url)) return false;
        if (plan.robots && !plan.robots.isAllowed(norm)) {
          blocked.add(norm);
          return false;
        }
        return true;
      };
      const urls = await sitemapUrls(engine, start.origin, plan.limit, Deadline.unbounded(), {
        accept,
        scopePath: plan.basePath,
        robots: plan.robots,
      }).catch(() => []);
      for (const url of blocked) await store.pushRobotsBlocked(job.id, url);
      await enqueueLinks(engine, job, plan, urls, 0, taskId);
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
  fx: TaskEffects,
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
    await fx.failure(url, `Redirected to ${target}, which is outside the crawl scope`);
    return false;
  }
  // A target that was already seen is crawled (or being crawled) under its own task.
  return (await store.markSeen(job.id, [keyOf(target)]))[0] === true;
}

export async function handleCrawlPage(engine: Engine, job: JobRecord, url: string, depth: number, taskId?: string) {
  const { store } = engine.jobs;
  const fx = taskEffects(engine, job, taskId);
  try {
    await resumeQueueing(engine, job, taskId);
    const plan = await planFor(store, job);
    const { document, links } = await scrapeUrl(engine, url, plan.req.scrapeOptions, { collectLinks: true });
    if ((await store.get(job.id))?.status !== "scraping") return;
    const start = normalizeUrl(plan.start.href, false);
    if (url !== start && !(await acceptRedirect(store, fx, job, plan, url, document.metadata?.url as string | undefined))) return;
    // The start page always feeds discovery but only counts as a result if it passes the filters.
    if (url !== start || matchesFilters(plan, new URL(url))) {
      await fx.page(document, { countCompleted: true });
    }
    // `scheduled` only grows toward `limit` and then stays there, so a full crawl has nothing left to discover.
    const full = job.scheduled >= plan.limit;
    if ((plan.req.sitemap ?? "include") !== "only" && !full)
      await enqueueLinks(engine, job, plan, links ?? [], depth + 1, taskId, false, !isSameSite(plan, new URL(document.metadata?.url ?? url)));
  } catch (err) {
    await fx.failure(url, toAppError(err).message);
  }
}
