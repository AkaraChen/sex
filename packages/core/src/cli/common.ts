import type { CoreConfigOverrides } from "../config.ts";
import type { BaseEngine } from "../engine.ts";
import { AppError, toAppError } from "../errors.ts";
import { log, setLogLevel } from "../log.ts";
import { type Document, type FormatOption, type ScrapeOptions, ScrapeRequest, type SearchData, SearchRequest } from "../schemas.ts";

/** Flags every command of sex and sex-lite takes: SearXNG, fetching and logging. */
export const coreArgs = {
  "searxng-url": {
    type: "string",
    description: "Use a running SearXNG at this base URL instead of starting one (env SEX_SEARXNG_URL; default: SearXNG runs embedded)",
  },
  "searxng-path": { type: "string", description: "SearXNG executable to run (env SEX_SEARXNG_PATH; default: the bundled binary)" },
  "searxng-settings": { type: "string", description: "settings.yml for the embedded SearXNG (env SEX_SEARXNG_SETTINGS)" },
  "allow-private-network": { type: "boolean", description: "Allow fetching localhost/private IPs (env SEX_ALLOW_PRIVATE_NETWORK)" },
  "user-agent": { type: "string", description: "User-Agent for page fetches (env SEX_USER_AGENT)" },
  concurrency: { type: "string", description: "Max concurrent page scrapes (env SEX_CONCURRENCY, default 8)" },
  timeout: { type: "string", description: "Default per-page timeout in ms (env SEX_TIMEOUT, default 30000)" },
  "log-level": { type: "string", description: "debug | info | warn | error | silent (env SEX_LOG_LEVEL)" },
} as const;

/** Flags of `serve`: who may call the API, and where it listens. */
export const httpArgs = {
  "cors-origin": {
    type: "string",
    description: "Comma-separated browser origins allowed cross-origin, e.g. https://app.example.com (env SEX_CORS_ORIGINS; default none)",
  },
  "allowed-host": {
    type: "string",
    description: "Comma-separated Host header hostnames accepted (env SEX_ALLOWED_HOSTS; default: localhost names when bound to loopback)",
  },
  port: { type: "string", alias: "p", description: "Port (env PORT, default 3002)" },
  host: { type: "string", description: "Bind address (env HOST, default 127.0.0.1)" },
} as const;

/** citty's parsed values for a flag table. */
export type ArgValues<T extends Record<string, { type: string }>> = {
  [K in keyof T]?: T[K]["type"] extends "boolean" ? boolean : string;
};

/** Strict integer parse: `30s` or `abc` is an error, not a silent NaN. Empty means unset. */
export const int = (v: string | undefined, label: string): number | undefined => {
  if (v === undefined || v.trim() === "") return undefined;
  if (!/^\d+$/.test(v.trim())) throw new AppError("CONFIG_INVALID", `${label} must be an integer (got ${JSON.stringify(v)})`);
  return Number(v.trim());
};

export const list = (v: string | undefined) =>
  v
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Applies --log-level and maps the core flags to config overrides. */
export function coreOverrides(args: ArgValues<typeof coreArgs> & Partial<ArgValues<typeof httpArgs>>): CoreConfigOverrides {
  if (args["log-level"]) setLogLevel(args["log-level"]);
  return {
    searxngUrl: args["searxng-url"],
    searxngPath: args["searxng-path"],
    searxngSettings: args["searxng-settings"],
    allowPrivateNetwork: args["allow-private-network"],
    userAgent: args["user-agent"],
    concurrency: int(args.concurrency, "--concurrency"),
    timeout: int(args.timeout, "--timeout"),
    corsOrigins: args["cors-origin"],
    allowedHosts: args["allowed-host"],
  };
}

/** Builds the engine, or prints a CONFIG_INVALID error and returns undefined with exit code 2. */
export function engineOrExit<E>(make: () => E): E | undefined {
  try {
    return make();
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "CONFIG_INVALID") throw err;
    process.stderr.write(`error: ${err.code}: ${err.message}\n`);
    process.exitCode = 2;
    return undefined;
  }
}

/** Prints the first schema issue as `error: BAD_REQUEST: path: message` and exits with code 2. */
export function invalidRequest(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) {
  const issue = error.issues[0];
  const where = issue?.path.map(String).join(".");
  process.stderr.write(`error: BAD_REQUEST: ${where ? `${where}: ` : ""}${issue?.message ?? "invalid request"}\n`);
  process.exitCode = 2;
}

/** Runs a one-shot command, printing errors as `error: CODE: message` and always shutting the engine down. */
export async function oneShot(engine: BaseEngine, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    const e = toAppError(err);
    process.stderr.write(`error: ${e.code}: ${e.message}\n`);
    process.exitCode = 1;
  } finally {
    await engine.close();
  }
}

/** Starts what the engine runs up front (SearXNG, ...); a broken install prints `error: CODE: message` and exits 1. */
export async function warmupOrExit(engine: BaseEngine): Promise<boolean> {
  try {
    await engine.warmup();
    return true;
  } catch (err) {
    const e = toAppError(err);
    process.stderr.write(`error: ${e.code}: ${e.message}\n`);
    await engine.close();
    process.exit(1);
  }
}

/** Closes the engine on SIGINT/SIGTERM, after `beforeClose` (e.g. stopping the server whose requests use the engine). */
export function onShutdown(engine: BaseEngine, beforeClose?: () => Promise<void> | void) {
  const stop = async () => {
    try {
      await beforeClose?.();
    } catch (err) {
      log.warn("shutdown step failed", { error: toAppError(err).message });
    }
    await engine.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** Where `serve` listens: --port / --host, then PORT / HOST, then 127.0.0.1:3002. */
export function listenAddress(args: ArgValues<typeof httpArgs>): { port: number; host: string } {
  return {
    port: int(args.port, "--port") ?? int(process.env.PORT, "PORT") ?? 3002,
    host: args.host ?? process.env.HOST ?? "127.0.0.1",
  };
}

// ---------------------------------------------------------------- search

/** The flags of `search` beyond the core ones. */
export const searchArgs = {
  query: { type: "positional", description: "Search query", required: true },
  limit: { type: "string", alias: "n", description: "Results per source (default 5)" },
  sources: { type: "string", description: "Comma-separated: web,news,images (default web)" },
  categories: { type: "string", description: "Comma-separated: github,research,pdf,developer,gov" },
  tbs: { type: "string", description: "Time filter: qdr:h|d|w|m|y" },
  lang: { type: "string", description: "Search language, e.g. en, zh-CN" },
  "include-domains": { type: "string", description: "Comma-separated domains to restrict to" },
  "exclude-domains": { type: "string", description: "Comma-separated domains to exclude" },
  scrape: { type: "boolean", description: "Also fetch each result as markdown" },
  json: { type: "boolean", description: "Print the raw JSON response" },
} as const;

/** Runs `search` on an engine and prints the results (or the JSON response with --json). */
export async function runSearch(engine: BaseEngine, args: ArgValues<typeof searchArgs> & { _: string[] }) {
  await oneShot(engine, async () => {
    const query = [args.query, ...args._.slice(1)].join(" ");
    const req = {
      query,
      limit: int(args.limit, "--limit"),
      sources: list(args.sources) as SearchRequest["sources"],
      categories: list(args.categories) as SearchRequest["categories"],
      tbs: args.tbs,
      lang: args.lang,
      includeDomains: list(args["include-domains"]),
      excludeDomains: list(args["exclude-domains"]),
      scrapeOptions: args.scrape ? { formats: ["markdown"] } : undefined,
    };
    const parsed = SearchRequest.safeParse(req);
    if (!parsed.success) return invalidRequest(parsed.error);
    const { data, warning } = await engine.search(parsed.data);
    if (args.json) {
      console.log(JSON.stringify({ success: true, data, ...(warning ? { warning } : {}) }, null, 2));
      return;
    }
    if (warning) log.warn(warning);
    printSearch(data);
  });
}

function printSearch(data: SearchData) {
  const sections: Array<
    [string, Array<{ url?: string; title?: string; description?: string; snippet?: string; imageUrl?: string; markdown?: string }>]
  > = [
    ["web", data.web ?? []],
    ["news", data.news ?? []],
    ["images", data.images ?? []],
  ];
  const multiple = sections.filter(([, items]) => items.length).length > 1;
  for (const [name, items] of sections) {
    if (!items.length) continue;
    if (multiple) console.log(`== ${name} ==\n`);
    items.forEach((r, i) => {
      console.log(`${i + 1}. ${r.title || "(untitled)"}\n   ${r.url ?? r.imageUrl ?? ""}`);
      const text = r.description || r.snippet;
      if (text) console.log(`   ${text}`);
      if (name === "images" && r.imageUrl) console.log(`   image: ${r.imageUrl}`);
      if (r.markdown) console.log(`\n${r.markdown}\n`);
      console.log();
    });
  }
}

// ---------------------------------------------------------------- fetch

export const parseJsonArg = async (value: string): Promise<unknown> => {
  const text = value.trim().startsWith("{") ? value : await Bun.file(value).text();
  return JSON.parse(text);
};

/** The flags of `fetch` both products take. */
export const fetchArgs = {
  url: { type: "positional", description: "URL to fetch", required: true },
  full: { type: "boolean", description: "Keep the whole page instead of only the main content" },
  "include-tags": { type: "string", description: "Comma-separated CSS selectors to keep" },
  "exclude-tags": { type: "string", description: "Comma-separated CSS selectors to remove" },
  mobile: { type: "boolean", description: "Emulate a mobile device" },
  options: { type: "string", description: "Extra Firecrawl scrape options as inline JSON or a file path" },
  json: { type: "boolean", description: "Print the full JSON document" },
} as const;

/**
 * Runs `fetch` on an engine and prints the page: markdown (or the one format asked for) as is, anything else as JSON.
 * `fromFlags` reads the product's own flags (inside the error handling); `--options` formats replace its formats.
 */
export async function runFetch(
  engine: BaseEngine,
  args: ArgValues<typeof fetchArgs>,
  fromFlags: () => Promise<{ formats: FormatOption[]; waitFor?: number }>,
) {
  await oneShot(engine, async () => {
    const extra = args.options ? ((await parseJsonArg(args.options)) as ScrapeOptions) : {};
    const own = await fromFlags();
    const effectiveFormats = extra.formats ?? own.formats;
    const req = {
      ...extra,
      url: args.url,
      formats: effectiveFormats,
      onlyMainContent: args.full ? false : extra.onlyMainContent,
      includeTags: list(args["include-tags"]) ?? extra.includeTags,
      excludeTags: list(args["exclude-tags"]) ?? extra.excludeTags,
      waitFor: own.waitFor ?? extra.waitFor,
      mobile: args.mobile ?? extra.mobile,
    };
    const parsed = ScrapeRequest.safeParse(req);
    if (!parsed.success) return invalidRequest(parsed.error);
    const doc: Document = await engine.scrape(parsed.data);
    const requested = new Set(effectiveFormats.map((f) => (typeof f === "string" ? f : f.type)));
    if (args.json) {
      console.log(JSON.stringify({ success: true, data: doc }, null, 2));
    } else if (requested.size === 1 && requested.has("markdown")) {
      console.log(doc.markdown ?? "");
    } else if (requested.size === 1 && requested.has("json")) {
      console.log(JSON.stringify(doc.json, null, 2));
    } else if (requested.size === 1 && requested.has("summary")) {
      console.log(doc.summary ?? "");
    } else {
      console.log(JSON.stringify(doc, null, 2));
    }
  });
}
