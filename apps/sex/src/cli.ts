#!/usr/bin/env bun
import {
  type ArgValues,
  coreArgs,
  coreOverrides,
  engineOrExit,
  fetchArgs,
  httpArgs,
  int,
  list,
  listenAddress,
  onShutdown,
  parseJsonArg,
  runFetch,
  runSearch,
  searchArgs,
  warmupOrExit,
} from "@searxng-js/sex-server/cli";
import { defineCommand, runMain } from "citty";
import { defaultDataDir, resolveConfig } from "./config.ts";
import { Engine } from "./engine/engine.ts";
import type { FormatOption } from "./schemas.ts";
import { VERSION } from "./version.ts";

const commonArgs = {
  ...coreArgs,
  lightpanda: { type: "boolean", description: "Spawn a local Lightpanda browser for page rendering (env SEX_LIGHTPANDA)" },
  "lightpanda-path": { type: "string", description: "Path to the lightpanda binary (env SEX_LIGHTPANDA_PATH)" },
  "block-media": { type: "boolean", description: "Block image and audio / video requests in browser scrapes (env SEX_BLOCK_MEDIA)" },
  "cdp-url": { type: "string", description: "Use an existing CDP browser, e.g. ws://127.0.0.1:9222 (env SEX_CDP_URL)" },
  docs: { type: "boolean", description: "Convert PDFs, office documents and images with here-docs: structure + local OCR (env SEX_DOCS)" },
  "llm-model": { type: "string", description: "Enable LLM features with this model (env SEX_LLM_MODEL)" },
  "llm-small-model": {
    type: "string",
    description:
      "Cheaper model for extract planning, schema, crawl prompt and /* page selection calls (env SEX_LLM_SMALL_MODEL, default: the main model)",
  },
  "llm-base-url": { type: "string", description: "OpenAI-compatible base URL (env SEX_LLM_BASE_URL, default https://api.openai.com/v1)" },
  "llm-api-key": { type: "string", description: "LLM API key (env SEX_LLM_API_KEY or OPENAI_API_KEY)" },
} as const;

const serverArgs = {
  ...commonArgs,
  ...httpArgs,
  "data-dir": {
    type: "string",
    description: "Directory for the job database and task queue (env SEX_DATA_DIR, default $XDG_DATA_HOME/sex or ~/.local/share/sex)",
  },
  "documents-url": {
    type: "string",
    description:
      "Where job documents go: s3://bucket[/prefix] (credentials from S3_* / AWS_* env) or file:///path (env SEX_DOCUMENTS_URL, default <data-dir>/documents)",
  },
} as const;

/** Builds the engine, or prints a CONFIG_INVALID error and returns undefined with exit code 2. */
const engineFrom = (args: Partial<ArgValues<typeof serverArgs>>, defaults: { allowPrivateNetwork: boolean; dataDir?: string }) =>
  engineOrExit(
    () =>
      new Engine(
        resolveConfig(
          {
            ...coreOverrides(args),
            lightpanda: args.lightpanda,
            lightpandaPath: args["lightpanda-path"],
            cdpUrl: args["cdp-url"],
            blockMedia: args["block-media"],
            docs: args.docs,
            llmModel: args["llm-model"],
            llmSmallModel: args["llm-small-model"],
            llmBaseUrl: args["llm-base-url"],
            llmApiKey: args["llm-api-key"],
            dataDir: args["data-dir"],
            documentsUrl: args["documents-url"],
          },
          defaults,
        ),
      ),
  );

const search = defineCommand({
  meta: { name: "search", description: "Search the web via SearXNG" },
  args: { ...commonArgs, ...searchArgs },
  run: async ({ args }) => {
    const engine = engineFrom(args, { allowPrivateNetwork: true });
    if (engine) await runSearch(engine, args);
  },
});

const fetchCmd = defineCommand({
  meta: { name: "fetch", description: "Fetch a URL and print it as markdown (or other formats)" },
  args: {
    ...commonArgs,
    ...fetchArgs,
    formats: {
      type: "string",
      alias: "f",
      description: "Comma-separated: markdown,html,rawHtml,links,images,summary (default markdown)",
    },
    "wait-for": { type: "string", description: "Extra ms to wait after load (browser only)" },
    "json-prompt": { type: "string", description: "LLM extraction prompt (adds the json format)" },
    "json-schema": { type: "string", description: "JSON Schema (inline JSON or file path) for LLM extraction" },
  },
  run: async ({ args }) => {
    const engine = engineFrom(args, { allowPrivateNetwork: true });
    if (!engine) return;
    await runFetch(engine, args, async () => {
      const formats: FormatOption[] = (list(args.formats) ?? []) as FormatOption[];
      if (!formats.length && !args["json-prompt"] && !args["json-schema"]) formats.push("markdown");
      if (args["json-prompt"] || args["json-schema"]) {
        formats.push({
          type: "json",
          prompt: args["json-prompt"],
          schema: args["json-schema"] ? ((await parseJsonArg(args["json-schema"])) as Record<string, unknown>) : undefined,
        });
      }
      return { formats, waitFor: int(args["wait-for"], "--wait-for") };
    });
  },
});

const serve = defineCommand({
  meta: {
    name: "serve",
    description: "Run the Firecrawl-compatible HTTP API and MCP over HTTP (docs at /docs, spec at /openapi.json, MCP at /mcp)",
  },
  args: serverArgs,
  run: async ({ args }) => {
    const engine = engineFrom(args, { allowPrivateNetwork: false, dataDir: defaultDataDir() });
    if (!engine) return;
    let stopServer: (() => Promise<void>) | undefined;
    onShutdown(engine, () => stopServer?.());
    if (!(await warmupOrExit(engine))) return;
    // Opening the job backend starts the worker, which resumes tasks left in the queue by a previous run.
    void engine.jobs;
    const { serveHttp } = await import("./http/server.ts");
    stopServer = serveHttp(engine, listenAddress(args)).stop;
  },
});

const main = defineCommand({
  meta: { name: "sex", version: VERSION, description: "Self-hosted, Firecrawl-compatible web search + fetch" },
  subCommands: { search, fetch: fetchCmd, serve, http: serve },
});

runMain(main);
