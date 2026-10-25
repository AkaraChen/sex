import { badRequest, toAppError } from "../errors.ts";
import type { CrawlRequest } from "../schemas.ts";
import type { Engine } from "./engine.ts";
import { type JobRecord, sendWebhook, settleTask, validateWebhook } from "./jobs/index.ts";
import { normalizeUrl, sitemapUrls } from "./map.ts";
import { assertPublicUrl, decodeBody, parseHttpUrl, safeFetch } from "./net.ts";
import { parseRobots, type Robots } from "./robots.ts";
import { assertScrapeCapabilities, scrapeUrl } from "./scrape.ts";

const DERIVABLE_KEYS = [
  "includePaths",
  "excludePaths",
  "maxDiscoveryDepth",
  "crawlEntireDomain",
  "allowSubdomains",
  "allowExternalLinks",
  "sitemap",
  "limit",
] as const;

/** Uses the LLM to turn a natural-language prompt into crawl options. */
export async function crawlParamsFromPrompt(engine: Engine, url: string, prompt: string): Promise<Record<string, unknown>> {
  engine.llm.require("Crawl prompts");
  const out = (await engine.llm.json(
    "Crawl prompts",
    `You configure a web crawler. Given a start URL and an instruction, return a JSON object with only the relevant keys among:
includePaths (string[] of regexes matched against URL pathnames), excludePaths (string[] of regexes), maxDiscoveryDepth (integer),
crawlEntireDomain (boolean, follow links outside the start path), allowSubdomains (boolean), allowExternalLinks (boolean),
sitemap ("include" | "skip" | "only"), limit (integer, max pages).`,
    `Start URL: ${url}\nInstruction: ${prompt}`,
  )) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(out ?? {}).filter(([k]) => (DERIVABLE_KEYS as readonly string[]).includes(k)));
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

const plans = new Map<string, CrawlPlan>();

function planFor(job: JobRecord): CrawlPlan {
  const cached = plans.get(job.id);
  // Plans are built after crawl-start stored robots.txt, so they never need refreshing.
  if (cached) return cached;
  const req = job.options as unknown as CrawlRequest;
  const start = new URL(job.url as string);
  const plan: CrawlPlan = {
    req,
    start,
    limit: req.limit ?? 10_000,
    includes: compile(req.includePaths, "includePaths"),
    excludes: compile(req.excludePaths, "excludePaths"),
    robots: job.robotsTxt ? parseRobots(job.robotsTxt, req.robotsUserAgent ?? "sex") : undefined,
    baseHost: stripWww(start.hostname),
    basePath: start.pathname.endsWith("/") ? start.pathname : start.pathname.replace(/\/[^/]*$/, "/"),
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
  return !!plan.req.crawlEntireDomain || url.pathname.startsWith(plan.basePath) || url.href === plan.start.href;
}

export async function startCrawl(engine: Engine, input: CrawlRequest): Promise<JobRecord> {
  const start = parseHttpUrl(input.url.trim());
  await assertPublicUrl(start, engine.config.allowPrivateNetwork);
  assertScrapeCapabilities(engine, input.scrapeOptions);
  await validateWebhook(engine, input.webhook);
  const derived = input.prompt ? await crawlParamsFromPrompt(engine, start.href, input.prompt) : {};
  // Explicit options win over prompt-derived ones.
  const req = { ...derived, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as CrawlRequest;
  compile(req.includePaths, "includePaths");
  compile(req.excludePaths, "excludePaths");

  const { store, queue } = engine.jobs;
  const job = await store.create({ kind: "crawl", url: start.href, options: req as unknown as Record<string, unknown> });
  await store.incr(job.id, "pending", 1);
  await queue.add([{ task: { type: "crawl-start", jobId: job.id } }]);
  return job;
}

/** Filters candidate links and enqueues the new ones as page tasks, respecting limit and delay. */
async function enqueueLinks(engine: Engine, job: JobRecord, plan: CrawlPlan, links: string[], depth: number, isStart = false) {
  const { store, queue } = engine.jobs;
  const { req } = plan;
  if (req.maxDiscoveryDepth !== undefined && depth > req.maxDiscoveryDepth) return;
  const ignoreQuery = req.ignoreQueryParameters ?? false;
  const dedupe = req.deduplicateSimilarURLs ?? true;

  const candidates = new Map<string, string>();
  for (const raw of links) {
    const normalized = normalizeUrl(raw, ignoreQuery);
    if (!normalized) continue;
    const url = new URL(normalized);
    if (!isStart && (!inScope(plan, url) || !matchesFilters(plan, url))) continue;
    const key = dedupe ? similarityKey(normalized) : normalized;
    if (!candidates.has(key)) candidates.set(key, normalized);
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
    const lastSlot = await store.incr(job.id, "slots", allowed.length);
    const firstSlot = lastSlot - allowed.length;
    delays = allowed.map((_, i) => Math.max(0, job.createdAt + (firstSlot + i) * req.delay! * 1000 - Date.now()));
  }
  await queue.add(allowed.map((url, i) => ({ task: { type: "page" as const, jobId: job.id, url, depth }, delayMs: delays[i] })));
}

export async function handleCrawlStart(engine: Engine, jobId: string) {
  const { store } = engine.jobs;
  try {
    let job = await store.get(jobId);
    if (job?.status !== "scraping") return;
    const req = job.options as unknown as CrawlRequest;
    const start = new URL(job.url as string);
    sendWebhook(job, "started");

    if (!req.ignoreRobotsTxt) {
      const robotsTxt = await safeFetch(`${start.origin}/robots.txt`, {
        timeout: 10_000,
        allowPrivateNetwork: engine.config.allowPrivateNetwork,
        userAgent: engine.config.userAgent,
        maxBodyBytes: engine.config.maxBodyBytes,
      })
        .then((res) => (res.status < 400 ? decodeBody(res.body, res.contentType) : ""))
        .catch(() => "");
      await store.patch(jobId, { robotsTxt });
      job = { ...job, robotsTxt };
    }
    const plan = planFor(job);
    const mode = req.sitemap ?? "include";
    if (mode !== "only") await enqueueLinks(engine, job, plan, [start.href], 0, true);
    if (mode !== "skip") {
      const urls = await sitemapUrls(engine, start.origin, plan.limit * 2).catch(() => []);
      await enqueueLinks(engine, job, plan, urls, 1);
    }
  } catch (err) {
    const e = toAppError(err);
    if (await store.finish(jobId, "failed", { error: e.message })) {
      const job = await store.get(jobId);
      if (job) sendWebhook(job, "failed", [], e.message);
    }
  } finally {
    await settleTask(engine.jobs.store, jobId);
  }
}

export async function handleCrawlPage(engine: Engine, job: JobRecord, url: string, depth: number) {
  const { store } = engine.jobs;
  try {
    const plan = planFor(job);
    const { document, links } = await scrapeUrl(engine, url, plan.req.scrapeOptions, { collectLinks: true });
    if ((await store.get(job.id))?.status !== "scraping") return;
    const start = normalizeUrl(plan.start.href, plan.req.ignoreQueryParameters ?? false);
    // The start page always feeds discovery but only counts as a result if it passes the filters.
    if (url !== start || matchesFilters(plan, new URL(url))) {
      await store.pushDocument(job.id, document);
      await store.incr(job.id, "completed", 1);
      sendWebhook(job, "page", [document]);
    }
    if ((plan.req.sitemap ?? "include") !== "only") await enqueueLinks(engine, job, plan, links ?? [], depth + 1);
  } catch (err) {
    await store.pushError(job.id, { id: crypto.randomUUID(), timestamp: new Date().toISOString(), url, error: toAppError(err).message });
  } finally {
    await settleTask(engine.jobs.store, job.id);
  }
}
