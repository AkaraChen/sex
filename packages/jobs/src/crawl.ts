import { assertPublicUrl, decodeBody, parseHttpUrl, safeFetch } from "@searxng-js/sex-egress";
import { toAppError } from "@searxng-js/sex-errors";
import {
  basePathOf,
  compilePatterns,
  isAcceptablePattern,
  isSkippableFile,
  mapSite,
  matchesPatterns,
  normalizeUrl,
  parseRobots,
  type Robots,
  robotsTextFor,
  sitemapUrls,
} from "@searxng-js/sex-map";
import { assertScrapeCapabilities, scrapeUrl } from "@searxng-js/sex-scrape";
import type { z } from "zod";
import { validateWebhook } from "./backend.ts";
import { type JobsContext, requireLlm } from "./context.ts";
import { type TaskEffects, taskEffects } from "./effects.ts";
import { CrawlRequest } from "./schemas.ts";
import type { JobRecord, JobStore, OutboxTask } from "./types.ts";
import { sendWebhook } from "./webhook.ts";

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
function validateDerived(out: Record<string, unknown>, logger: JobsContext["logger"]): Record<string, unknown> {
  const valid: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(out)) {
    if (!DERIVABLE_KEYS.includes(key)) continue;
    const parsed = derivableFieldSchemas[key]?.safeParse(value);
    if (!parsed?.success) {
      logger?.debug("dropped prompt-derived crawl option", { key, reason: "invalid type" });
      continue;
    }
    if (key === "includePaths" || key === "excludePaths") {
      const patterns = (parsed.data as string[]).filter(isAcceptablePattern);
      if (patterns.length !== (parsed.data as string[]).length)
        logger?.debug("dropped invalid or unsafe regex from prompt-derived crawl option", { key });
      valid[key] = patterns;
    } else {
      valid[key] = parsed.data;
    }
  }
  return valid;
}

/** URLs of the site shown to the model that turns a crawl prompt into options (Firecrawl's is 50 too). */
const SITE_STRUCTURE_URLS = 50;
/** Mapping the site must not hold up starting the crawl for long. */
const SITE_STRUCTURE_TIMEOUT_MS = 15_000;

/**
 * Uses the LLM to turn a natural-language prompt into crawl options. It is shown a sample of the site's URLs
 * (sitemap and the start page's links, over the whole site) so path regexes match real paths; a site that
 * cannot be mapped means the model works from the prompt alone.
 */
export async function crawlParamsFromPrompt(ctx: JobsContext, url: string, prompt: string): Promise<Record<string, unknown>> {
  const llm = requireLlm(ctx, "Crawl prompts");
  let siteUrls: string[] = [];
  try {
    const { links } = await mapSite(
      ctx,
      { url, limit: SITE_STRUCTURE_URLS, sitemap: "include", filterByPath: false, timeout: SITE_STRUCTURE_TIMEOUT_MS },
      undefined,
      { skipSearch: true },
    );
    // The start URL alone says nothing about the site's structure.
    if (links.length > 1) siteUrls = links.map((l) => l.url);
  } catch (err) {
    ctx.logger?.debug("crawl prompt: mapping the site failed, continuing without its structure", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const out = await llm.crawlOptions(url, prompt, {}, siteUrls);
  return validateDerived(out ?? {}, ctx.logger);
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

/**
 * `defaults` apply only where neither the prompt nor the request sets an option. `promptGeneratedOptions` is what the
 * LLM derived from `prompt` (after validation); the options the crawl runs with are `job.options`.
 */
export async function startCrawl(
  ctx: JobsContext,
  input: CrawlRequest,
  defaults: Partial<CrawlRequest> = {},
): Promise<{ job: JobRecord; promptGeneratedOptions?: Record<string, unknown> }> {
  const start = parseHttpUrl(input.url.trim());
  await assertPublicUrl(start, ctx.settings.allowPrivateNetwork);
  assertScrapeCapabilities(ctx, input.scrapeOptions);
  await validateWebhook(ctx, input.webhook);
  const derived = input.prompt ? await crawlParamsFromPrompt(ctx, start.href, input.prompt) : {};
  // Explicit options win over prompt-derived ones, which win over defaults.
  const req = {
    ...defaults,
    ...derived,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
  } as CrawlRequest;
  compilePatterns(req.includePaths, "includePaths");
  compilePatterns(req.excludePaths, "excludePaths");

  const { store, scheduler } = ctx.jobs;
  const job = await store.create({ kind: "crawl", url: start.href, options: req as unknown as Record<string, unknown> });
  await store.incr(job.id, "pending", 1);
  try {
    await scheduler.add([{ task: { type: "crawl-start", jobId: job.id, taskId: crypto.randomUUID() } }]);
  } catch (err) {
    // Nothing will run or settle this task, so undo the count and fail the job.
    await store.incr(job.id, "pending", -1);
    await store.finish(job.id, "failed", { error: toAppError(err).message });
    throw err;
  }
  return { job, promptGeneratedOptions: input.prompt ? derived : undefined };
}

/** Filters candidate links and enqueues the new ones as page tasks, respecting the limit. */
async function enqueueLinks(
  ctx: JobsContext,
  job: JobRecord,
  plan: CrawlPlan,
  links: string[],
  depth: number,
  owner: string | undefined,
  isStart = false,
  fromExternal = false,
) {
  const { store } = ctx.jobs;
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
    if (!isStart && (isSkippableFile(url, ctx.docs?.enabled ?? false) || !inScope(plan, url, fromExternal) || !matchesFilters(plan, url)))
      continue;
    const key = dedupe ? similarityKey(keyUrl) : keyUrl;
    if (!candidates.has(key)) candidates.set(key, fetchUrl);
  }
  if (!candidates.size) return;

  const found = [...candidates].map(([key, url]) => ({ key, url, blocked: plan.robots ? !plan.robots.isAllowed(url) : false }));
  const scheduled = await store.schedule(job.id, owner, found, {
    limit: plan.limit,
    depth,
  });
  await queuePages(ctx, job, scheduled);
}

/**
 * Queues page tasks that `store.schedule` recorded, then clears them from the outbox. A crash in between leaves them
 * there, and the owner's redelivery queues them again under the same taskIds, so the queue may hold a task twice
 * but a page is neither lost nor counted twice (its document, failure and settle are claimed per taskId).
 */
async function queuePages(ctx: JobsContext, job: JobRecord, scheduled: OutboxTask[]) {
  if (!scheduled.length) return;
  const { store, scheduler } = ctx.jobs;
  const ids = scheduled.map((t) => t.taskId);
  try {
    await scheduler.add(
      scheduled.map((t) => ({ task: { type: "page" as const, jobId: job.id, taskId: t.taskId, url: t.url, depth: t.depth } })),
      job.options,
    );
  } catch (err) {
    // Nothing will run or settle these tasks (this one is not redelivered), so give their counts back.
    await store.released(job.id, ids, false);
    throw err;
  }
  await store.released(job.id, ids, true);
}

/** Queues the pages a crashed delivery of this task scheduled but did not get into the queue. */
async function resumeQueueing(ctx: JobsContext, job: JobRecord, taskId: string | undefined) {
  if (taskId !== undefined) await queuePages(ctx, job, await ctx.jobs.store.outbox(job.id, taskId));
}

export async function handleCrawlStart(ctx: JobsContext, jobId: string, taskId?: string) {
  const { store } = ctx.jobs;
  try {
    const job = await store.get(jobId);
    if (job?.status !== "scraping") return;
    const req = job.options as unknown as CrawlRequest;
    const start = new URL(job.url as string);
    await resumeQueueing(ctx, job, taskId);
    await taskEffects(ctx, job, taskId).started();

    if (!req.ignoreRobotsTxt) {
      const robotsTxt = await safeFetch(`${start.origin}/robots.txt`, {
        signal: AbortSignal.timeout(10_000),
        allowPrivateNetwork: ctx.settings.allowPrivateNetwork,
        proxy: ctx.settings.proxyUrl,
        userAgent: ctx.settings.userAgent,
        maxBodyBytes: ctx.settings.maxBodyBytes,
      })
        .then((res) => robotsTextFor(res.status, () => decodeBody(res.body, res.contentType)))
        .catch(() => "");
      await store.setRobotsTxt(jobId, robotsTxt);
    }
    const plan = await planFor(store, job);
    // The start URL is crawled in every mode; the root site and sitemapped pages have discovery depth 0.
    const mode = req.sitemap ?? "include";
    await enqueueLinks(ctx, job, plan, [start.href], 0, taskId, true);
    if (mode !== "skip") {
      const blocked = new Set<string>();
      const accept = (raw: string) => {
        const norm = normalizeUrl(raw, false);
        if (!norm) return false;
        const url = new URL(norm);
        if (isSkippableFile(url, ctx.docs?.enabled ?? false) || !inScope(plan, url) || !matchesFilters(plan, url)) return false;
        if (plan.robots && !plan.robots.isAllowed(norm)) {
          blocked.add(norm);
          return false;
        }
        return true;
      };
      const urls = await sitemapUrls(
        ctx,
        start.origin,
        plan.limit,
        {},
        {
          accept,
          scopePath: plan.basePath,
          robots: plan.robots,
        },
      ).catch(() => []);
      for (const url of blocked) await store.pushRobotsBlocked(job.id, url);
      await enqueueLinks(ctx, job, plan, urls, 0, taskId);
    }
  } catch (err) {
    const e = toAppError(err);
    if (await store.finish(jobId, "failed", { error: e.message })) {
      const job = await store.get(jobId);
      if (job) await sendWebhook(ctx, job, "failed", [], e.message);
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
  taskId: string | undefined,
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
  // A target that was already seen is crawled (or being crawled) under its own task; one this task marked itself,
  // before it crashed, is this page.
  return store.claimSeen(job.id, taskId, keyOf(target));
}

export async function handleCrawlPage(ctx: JobsContext, job: JobRecord, url: string, depth: number, taskId?: string) {
  const { store } = ctx.jobs;
  const fx = taskEffects(ctx, job, taskId);
  try {
    await resumeQueueing(ctx, job, taskId);
    const plan = await planFor(store, job);
    const { document, links } = await scrapeUrl(ctx, url, plan.req.scrapeOptions, { collectLinks: true });
    if ((await store.get(job.id))?.status !== "scraping") return;
    const start = normalizeUrl(plan.start.href, false);
    if (url !== start && !(await acceptRedirect(store, fx, job, plan, url, document.metadata?.url as string | undefined, taskId))) return;
    // The start page always feeds discovery but only counts as a result if it passes the filters.
    if (url !== start || matchesFilters(plan, new URL(url))) {
      await fx.page(document);
    }
    // `scheduled` only grows toward `limit` and then stays there, so a full crawl has nothing left to discover.
    const full = job.scheduled >= plan.limit;
    if ((plan.req.sitemap ?? "include") !== "only" && !full)
      await enqueueLinks(ctx, job, plan, links ?? [], depth + 1, taskId, false, !isSameSite(plan, new URL(document.metadata?.url ?? url)));
  } catch (err) {
    const e = toAppError(err);
    await fx.failure(url, e.message, e.code);
  }
}
