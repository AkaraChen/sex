#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { type ConfigOverrides, defaultDataDir, resolveConfig } from "./config.ts";
import { Engine } from "./core/engine.ts";
import { AppError, toAppError } from "./errors.ts";
import { log, setLogLevel } from "./log.ts";
import { type Document, type FormatOption, type ScrapeOptions, ScrapeRequest, SearchRequest } from "./schemas.ts";
import { VERSION } from "./version.ts";

const commonArgs = {
  "searxng-url": {
    type: "string",
    description: "Use a running SearXNG at this base URL instead of starting one (env SEX_SEARXNG_URL; default: sex runs SearXNG itself)",
  },
  "searxng-path": { type: "string", description: "SearXNG executable to run (env SEX_SEARXNG_PATH; default: the bundled binary)" },
  "searxng-settings": { type: "string", description: "settings.yml for the SearXNG sex runs (env SEX_SEARXNG_SETTINGS)" },
  lightpanda: { type: "boolean", description: "Spawn a local Lightpanda browser for page rendering (env SEX_LIGHTPANDA)" },
  "lightpanda-path": { type: "string", description: "Path to the lightpanda binary (env SEX_LIGHTPANDA_PATH)" },
  "cdp-url": { type: "string", description: "Use an existing CDP browser, e.g. ws://127.0.0.1:9222 (env SEX_CDP_URL)" },
  docs: { type: "boolean", description: "Convert PDFs, office documents and images with here-docs: structure + local OCR (env SEX_DOCS)" },
  "llm-model": { type: "string", description: "Enable LLM features with this model (env SEX_LLM_MODEL)" },
  "llm-base-url": { type: "string", description: "OpenAI-compatible base URL (env SEX_LLM_BASE_URL, default https://api.openai.com/v1)" },
  "llm-api-key": { type: "string", description: "LLM API key (env SEX_LLM_API_KEY or OPENAI_API_KEY)" },
  "allow-private-network": { type: "boolean", description: "Allow fetching localhost/private IPs (env SEX_ALLOW_PRIVATE_NETWORK)" },
  "user-agent": { type: "string", description: "User-Agent for page fetches (env SEX_USER_AGENT)" },
  concurrency: { type: "string", description: "Max concurrent page scrapes (env SEX_CONCURRENCY, default 8)" },
  timeout: { type: "string", description: "Default per-page timeout in ms (env SEX_TIMEOUT, default 30000)" },
  "log-level": { type: "string", description: "debug | info | warn | error | silent (env SEX_LOG_LEVEL)" },
} as const;

type CommonArgs = { [K in keyof typeof commonArgs]?: (typeof commonArgs)[K]["type"] extends "boolean" ? boolean : string };

/** Strict integer parse: `30s` or `abc` is an error, not a silent NaN. Empty means unset. */
const int = (v: string | undefined, label: string): number | undefined => {
  if (v === undefined || v.trim() === "") return undefined;
  if (!/^\d+$/.test(v.trim())) throw new AppError(400, "CONFIG_INVALID", `${label} must be an integer (got ${JSON.stringify(v)})`);
  return Number(v.trim());
};
const list = (v: string | undefined) =>
  v
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const serverArgs = {
  ...commonArgs,
  "data-dir": {
    type: "string",
    description: "Directory for the job database and task queue (env SEX_DATA_DIR, default $XDG_DATA_HOME/sex or ~/.local/share/sex)",
  },
  "cors-origin": {
    type: "string",
    description: "Comma-separated browser origins allowed cross-origin, e.g. https://app.example.com (env SEX_CORS_ORIGINS; default none)",
  },
  "allowed-host": {
    type: "string",
    description: "Comma-separated Host header hostnames accepted (env SEX_ALLOWED_HOSTS; default: localhost names when bound to loopback)",
  },
} as const;

function engineFrom(
  args: CommonArgs & { "data-dir"?: string; "cors-origin"?: string; "allowed-host"?: string },
  defaults: { allowPrivateNetwork: boolean; dataDir?: string },
): Engine {
  if (args["log-level"]) setLogLevel(args["log-level"]);
  const overrides: ConfigOverrides = {
    searxngUrl: args["searxng-url"],
    searxngPath: args["searxng-path"],
    searxngSettings: args["searxng-settings"],
    lightpanda: args.lightpanda,
    lightpandaPath: args["lightpanda-path"],
    cdpUrl: args["cdp-url"],
    docs: args.docs,
    llmModel: args["llm-model"],
    llmBaseUrl: args["llm-base-url"],
    llmApiKey: args["llm-api-key"],
    allowPrivateNetwork: args["allow-private-network"],
    userAgent: args["user-agent"],
    concurrency: int(args.concurrency, "--concurrency"),
    timeout: int(args.timeout, "--timeout"),
    dataDir: args["data-dir"],
    corsOrigins: args["cors-origin"],
    allowedHosts: args["allowed-host"],
  };
  return new Engine(resolveConfig(overrides, defaults));
}

/** Builds the engine, or prints a CONFIG_INVALID error and returns undefined with exit code 2. */
function engineOrExit(
  args: CommonArgs & { "data-dir"?: string },
  defaults: { allowPrivateNetwork: boolean; dataDir?: string },
): Engine | undefined {
  try {
    return engineFrom(args, defaults);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "CONFIG_INVALID") throw err;
    process.stderr.write(`error: ${err.code}: ${err.message}\n`);
    process.exitCode = 2;
    return undefined;
  }
}

/** Prints the first schema issue as `error: BAD_REQUEST: path: message` and exits with code 2. */
function invalidRequest(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }) {
  const issue = error.issues[0];
  const where = issue?.path.map(String).join(".");
  process.stderr.write(`error: BAD_REQUEST: ${where ? `${where}: ` : ""}${issue?.message ?? "invalid request"}\n`);
  process.exitCode = 2;
}

/** Runs a one-shot command, printing errors as `error: CODE: message` and always shutting the engine down. */
async function oneShot(engine: Engine, fn: () => Promise<void>) {
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

/** Starts SearXNG, the browser and document converter up front; a broken install prints `error: CODE: message` and exits 1. */
async function warmupOrExit(engine: Engine): Promise<boolean> {
  try {
    await engine.searxng.warmup();
    await engine.browser.warmup();
    await engine.docs.warmup();
    return true;
  } catch (err) {
    const e = toAppError(err);
    process.stderr.write(`error: ${e.code}: ${e.message}\n`);
    await engine.close();
    process.exit(1);
  }
}

/** Closes the engine on SIGINT/SIGTERM, after `beforeClose` (e.g. stopping the server whose requests use the engine). */
function onShutdown(engine: Engine, beforeClose?: () => Promise<void> | void) {
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

const parseJsonArg = async (value: string): Promise<unknown> => {
  const text = value.trim().startsWith("{") ? value : await Bun.file(value).text();
  return JSON.parse(text);
};

const search = defineCommand({
  meta: { name: "search", description: "Search the web via SearXNG" },
  args: {
    ...commonArgs,
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
  },
  run: async ({ args }) => {
    const engine = engineOrExit(args, { allowPrivateNetwork: true });
    if (!engine) return;
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
    });
  },
});

const fetchCmd = defineCommand({
  meta: { name: "fetch", description: "Fetch a URL and print it as markdown (or other formats)" },
  args: {
    ...commonArgs,
    url: { type: "positional", description: "URL to fetch", required: true },
    formats: {
      type: "string",
      alias: "f",
      description: "Comma-separated: markdown,html,rawHtml,links,images,summary (default markdown)",
    },
    full: { type: "boolean", description: "Keep the whole page instead of only the main content" },
    "include-tags": { type: "string", description: "Comma-separated CSS selectors to keep" },
    "exclude-tags": { type: "string", description: "Comma-separated CSS selectors to remove" },
    "wait-for": { type: "string", description: "Extra ms to wait after load (browser only)" },
    mobile: { type: "boolean", description: "Emulate a mobile device" },
    "json-prompt": { type: "string", description: "LLM extraction prompt (adds the json format)" },
    "json-schema": { type: "string", description: "JSON Schema (inline JSON or file path) for LLM extraction" },
    options: { type: "string", description: "Extra Firecrawl scrape options as inline JSON or a file path" },
    json: { type: "boolean", description: "Print the full JSON document" },
  },
  run: async ({ args }) => {
    const engine = engineOrExit(args, { allowPrivateNetwork: true });
    if (!engine) return;
    await oneShot(engine, async () => {
      const formats: FormatOption[] = (list(args.formats) ?? []) as FormatOption[];
      if (!formats.length && !args["json-prompt"] && !args["json-schema"]) formats.push("markdown");
      if (args["json-prompt"] || args["json-schema"]) {
        formats.push({
          type: "json",
          prompt: args["json-prompt"],
          schema: args["json-schema"] ? ((await parseJsonArg(args["json-schema"])) as Record<string, unknown>) : undefined,
        });
      }
      const extra = args.options ? ((await parseJsonArg(args.options)) as ScrapeOptions) : {};
      const effectiveFormats = extra.formats ?? formats;
      const req = {
        ...extra,
        url: args.url,
        formats: effectiveFormats,
        onlyMainContent: args.full ? false : extra.onlyMainContent,
        includeTags: list(args["include-tags"]) ?? extra.includeTags,
        excludeTags: list(args["exclude-tags"]) ?? extra.excludeTags,
        waitFor: int(args["wait-for"], "--wait-for") ?? extra.waitFor,
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
  },
});

const serve = defineCommand({
  meta: {
    name: "serve",
    description: "Run the Firecrawl-compatible HTTP API and MCP over HTTP (docs at /docs, spec at /openapi.json, MCP at /mcp)",
  },
  args: {
    ...serverArgs,
    port: { type: "string", alias: "p", description: "Port (env PORT, default 3002)" },
    host: { type: "string", description: "Bind address (env HOST, default 127.0.0.1)" },
  },
  run: async ({ args }) => {
    const engine = engineOrExit(args, { allowPrivateNetwork: false, dataDir: defaultDataDir() });
    if (!engine) return;
    let stopServer: (() => Promise<void>) | undefined;
    onShutdown(engine, () => stopServer?.());
    if (!(await warmupOrExit(engine))) return;
    // Opening the job backend starts the worker, which resumes tasks left in the queue by a previous run.
    void engine.jobs;
    const { serveHttp } = await import("./http/server.ts");
    stopServer = serveHttp(engine, {
      port: int(args.port, "--port") ?? int(process.env.PORT, "PORT") ?? 3002,
      host: args.host ?? process.env.HOST ?? "127.0.0.1",
    }).stop;
  },
});

const main = defineCommand({
  meta: { name: "sex", version: VERSION, description: "Self-hosted, Firecrawl-compatible web search + fetch" },
  subCommands: { search, fetch: fetchCmd, serve, http: serve },
});

runMain(main);
