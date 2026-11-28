import { type CallTime, LocalService } from "@searxng-js/sex-local";
import { Parser } from "@searxng-js/sex-parse";
import {
  PROVIDERS,
  ProviderBackend,
  type SearchBackend,
  SearchBackendError,
  SearchChain,
  type SearchData,
  type SearchRequest,
  Searxng,
  SearxngBackend,
  withSearxngFallback,
} from "@searxng-js/sex-search";
import type { Config } from "./config.ts";
import { failure } from "./errors.ts";
import type { Logger } from "./log.ts";

const loggedSearchErrors = new WeakSet<object>();
const MAX_LOG_TEXT = 300;
const SECRET_PARAM_RE = /([?&](?:api[_-]?key|apikey|key|token|access[_-]?token)=)[^&\s]+/gi;
const SECRET_HEADER_RE =
  /\b((?:authorization\s*[:=]\s*bearer\s+|bearer\s+|(?:x-api-key|x-subscription-token)\s*[:=]\s*))\S+/gi;

/** Formats and options firecrawl-local has no equivalent for; they are refused with a warning, never silently dropped. */
const LOCAL_FORMATS = new Set(["markdown", "html", "rawHtml", "links"]);
const IGNORED = [
  "actions",
  "blockAds",
  "fastMode",
  "json",
  "summary",
  "changeTracking",
  "parsers",
  "maxAge",
  "storeInCache",
  "proxy",
  "redactPII",
  "zeroDataRetention",
  "onlyCleanContent",
  "lockdown",
  "minAge",
];

export interface ScrapeRequest {
  url: string;
  formats?: unknown[];
  timeout?: number;
  [key: string]: unknown;
}

export interface ScrapeResult {
  success: true;
  data: Record<string, unknown>;
}

/** What a scrape and a search run on: the firecrawl-local instance, the search chain, and the configuration they were built from. */
export class Engine {
  readonly local: LocalService;
  readonly searxng: Searxng;
  readonly parser: Parser;
  /** The configured providers in order, with SearXNG answering by default and falling back at the end. */
  readonly searchChain: SearchChain;

  constructor(
    readonly config: Config,
    private readonly log: Logger,
  ) {
    this.local = new LocalService({
      url: config.localUrl,
      token: config.localToken,
      binaryPath: config.localPath,
      chromePath: config.chromePath,
      browser: config.browser,
      allowPrivate: config.allowPrivate,
      timeoutMs: config.timeoutMs,
      onOutput: (line) => log.debug("firecrawl-local", { output: line }),
    });
    this.searxng = new Searxng({
      url: config.searxngUrl,
      binaryPath: config.searxngPath,
      onOutput: (line) => log.debug("searxng", { output: line }),
    });
    this.parser = new Parser({ path: config.parsePath, timeoutMs: config.parseTimeoutMs });
    this.searchChain = new SearchChain(this.buildChain());
  }

  /**
   * `SEX_SEARCH_PROVIDER` names the chain; an empty one is SearXNG alone. A configured chain gets
   * SearXNG appended as the fallback unless `!searxng` says otherwise — the app-side default,
   * spelled out as the explicit `withSearxngFallback` it is.
   */
  private buildChain(): SearchBackend[] {
    const searxng = new SearxngBackend(this.searxng);
    const excluded = new Set(this.config.searchExcluded);
    const backends: SearchBackend[] = [];
    for (const name of this.config.searchChain) {
      if (excluded.has(name)) continue;
      if (name === "searxng") {
        backends.push(searxng);
        continue;
      }
      const factory = PROVIDERS[name];
      if (!factory)
        throw new Error(
          `SEX_SEARCH_PROVIDER: unknown search provider "${name}" (known: searxng, ${Object.keys(PROVIDERS).sort().join(", ")})`,
        );
      if (!this.config.searchKeys[name])
        throw new Error(`SEX_SEARCH_PROVIDER: "${name}" needs SEX_SEARCH_${name.toUpperCase()}_KEY`);
      backends.push(
        new ProviderBackend(
          factory(this.config.searchKeys[name]),
          this.config.searchTimeoutMs ?? this.config.timeoutMs,
        ),
      );
    }
    const resolved = !backends.length
      ? [searxng]
      : excluded.has("searxng")
        ? backends
        : withSearxngFallback(backends, searxng);
    const chain = resolved.map((backend) => backend.id);
    return resolved.map((backend) => this.observeBackend(backend, chain));
  }

  private observeBackend(backend: SearchBackend, chain: readonly string[]): SearchBackend {
    return {
      id: backend.id,
      search: async (request, time) => {
        try {
          return await backend.search(request, time);
        } catch (err) {
          this.logSearchFailure(err, backend.id, chain);
          if (typeof err === "object" && err !== null) loggedSearchErrors.add(err);
          throw err;
        }
      },
    };
  }

  private logSearchFailure(err: unknown, provider: string | undefined, chain: readonly string[]): void {
    const mapped = failure(err);
    const secrets = Object.values(this.config.searchKeys);
    const cause = err instanceof Error ? err.cause : undefined;
    const resolvedProvider = provider ?? providerFromCause(cause);
    const causeSummary = summarizeCause(cause, secrets);
    this.log.debug("search failed", {
      ...(resolvedProvider ? { provider: resolvedProvider } : {}),
      chain: [...chain],
      status: err instanceof SearchBackendError ? err.status : mapped.status,
      ...(err instanceof SearchBackendError && err.status !== mapped.status ? { httpStatus: mapped.status } : {}),
      code: mapped.code,
      ...(err instanceof SearchBackendError ? { transient: err.transient } : {}),
      error: truncate(redactSecrets(err instanceof Error ? err.message : String(err), secrets)),
      ...(causeSummary ? { cause: causeSummary } : {}),
    });
  }

  /** Scrapes through firecrawl-local and answers the Firecrawl v2 scrape shape. */
  async scrape(request: ScrapeRequest, signal?: AbortSignal): Promise<ScrapeResult> {
    const warnings: string[] = [];
    const body: Record<string, unknown> = { ...request };

    for (const key of IGNORED) {
      if (!(key in body)) continue;
      delete body[key];
      warnings.push(`\`${key}\` is not supported and was ignored`);
    }

    if (Array.isArray(body.formats)) {
      const names = body.formats.map(formatName);
      const kept = names.filter((name): name is string => !!name && LOCAL_FORMATS.has(name));
      const dropped = names.filter((name) => !!name && !LOCAL_FORMATS.has(name));
      if (dropped.length) warnings.push(`unsupported format(s): ${dropped.join(", ")}`);
      body.formats = kept.length ? kept : ["markdown"];
    }

    const time: CallTime = { signal };
    if (typeof body.timeout === "number" && body.timeout > 0) time.deadlineAt = Date.now() + body.timeout;

    const client = await this.local.client();
    const response = await client.scrape(body, time);
    const data = response.data ?? {};
    if (warnings.length) {
      data.warning = [data.warning, warnings.join("; ")]
        .filter((value) => typeof value === "string" && value)
        .join(" ");
    }
    return { success: true, data };
  }

  /** Searches the configured chain and answers the Firecrawl v2 search shape; `provider` names who answered. */
  async search(
    request: SearchRequest,
    signal?: AbortSignal,
  ): Promise<{ data: SearchData; warning?: string; provider: string }> {
    const time: CallTime = { signal };
    if (request.timeout) time.deadlineAt = Date.now() + request.timeout;
    try {
      const result = await this.searchChain.search(request, time);
      if (result.provider !== this.searchChain.ids[0]) {
        const secrets = Object.values(this.config.searchKeys);
        this.log.debug("search fallback", {
          provider: result.provider,
          chain: this.searchChain.ids,
          warnings: result.warnings.map((warning) => truncate(redactSecrets(warning, secrets))),
        });
      }
      return {
        data: result.data,
        warning: result.warnings.length ? result.warnings.join("; ") : undefined,
        provider: result.provider,
      };
    } catch (err) {
      if (typeof err !== "object" || err === null || !loggedSearchErrors.has(err)) {
        this.logSearchFailure(err, undefined, this.searchChain.ids);
      }
      throw err;
    }
  }

  async map(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).map(body, { signal });
  }

  async crawl(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).crawl(body, { signal });
  }

  async crawlStatus(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).crawlStatus(id, { signal });
  }

  async crawlCancel(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).crawlCancel(id, { signal });
  }

  async batch(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).batch(body, { signal });
  }

  async batchStatus(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).batchStatus(id, { signal });
  }

  async batchCancel(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return (await this.local.client()).batchCancel(id, { signal });
  }

  /** `/v2/parse`: the file goes to here-docs as a subprocess, and its Markdown comes back as a Document. */
  async parse(file: Blob, options?: unknown, signal?: AbortSignal): Promise<ScrapeResult> {
    const filename = (file as File).name || "upload";
    const warnings: string[] = [];
    const requested = (options as { formats?: unknown } | undefined)?.formats;
    if (Array.isArray(requested)) {
      const ignored = requested.filter((format) => format !== "markdown");
      if (ignored.length) warnings.push(`unsupported format(s): ${ignored.join(", ")}`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = await this.parser.parse({ bytes, filename }, { signal });
    const data: Record<string, unknown> = { markdown: parsed.markdown, metadata: { sourceURL: filename } };
    const all = [...parsed.warnings, ...warnings];
    if (all.length) data.warning = all.join("; ");
    return { success: true, data };
  }

  /** Starts the child processes. Failures are logged, not fatal: the first request pays for them. */
  async warmup(): Promise<void> {
    const pending: Promise<unknown>[] = [this.local.warmup()];
    if (this.searchChain.ids.includes("searxng")) pending.push(this.searxng.warmup());
    const results = await Promise.allSettled(pending);
    for (const result of results) {
      if (result.status === "rejected") {
        this.log.warn("warmup failed", {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  describe(): { search: string; firecrawlLocal: string; searxng: string } {
    return {
      search: this.searchChain.ids.join(" -> "),
      firecrawlLocal: this.local.describe(),
      searxng: this.searxng.describe(),
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.local.close(), this.searxng.close()]);
  }
}

function formatName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "type" in value) return String((value as { type: unknown }).type);
  return undefined;
}

function providerFromCause(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("attempts" in cause)) return undefined;
  const attempts = (cause as { attempts?: unknown }).attempts;
  if (!Array.isArray(attempts) || !attempts.length) return undefined;
  const last = attempts.at(-1);
  if (typeof last === "object" && last !== null && typeof (last as { provider?: unknown }).provider === "string") {
    return (last as { provider: string }).provider;
  }
  return undefined;
}

function summarizeCause(cause: unknown, secrets: readonly string[], depth = 0): Record<string, unknown> | undefined {
  if (cause === undefined || cause === null || depth > 2) return undefined;
  if (typeof cause !== "object") return { message: truncate(redactSecrets(String(cause), secrets)) };
  const record = cause as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  if (typeof record.name === "string" && record.name) summary.name = record.name;
  if (typeof record.code === "string" && record.code) summary.code = record.code;
  if (typeof record.status === "number" && Number.isFinite(record.status)) summary.status = record.status;
  if (typeof record.retryAfterMs === "number" && Number.isFinite(record.retryAfterMs)) {
    summary.retryAfterMs = record.retryAfterMs;
  }
  if (typeof record.message === "string" && record.message) {
    summary.message = truncate(redactSecrets(record.message, secrets));
  }
  if ("cause" in record && record.cause !== undefined && record.cause !== cause) {
    const inner = summarizeCause(record.cause, secrets, depth + 1);
    if (inner) summary.cause = inner;
  }
  return Object.keys(summary).length ? summary : undefined;
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text.replace(SECRET_PARAM_RE, "$1[REDACTED]").replace(SECRET_HEADER_RE, "$1[REDACTED]");
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    out = out.replaceAll(secret, "[REDACTED]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.replaceAll(encoded, "[REDACTED]");
  }
  return out;
}

function truncate(text: string): string {
  return text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT)}…` : text;
}
