#!/usr/bin/env bun
import type { FormatOption } from "@searxng-js/sex-scrape";
import {
  type ArgValues,
  coreArgs,
  coreOverrides,
  engineOrExit,
  fetchArgs,
  httpArgs,
  list,
  listenAddress,
  onShutdown,
  runFetch,
  runSearch,
  searchArgs,
  warmupOrExit,
} from "@searxng-js/sex-server/cli";
import { resolveCoreConfig } from "@searxng-js/sex-server/config";
import { defineCommand, runMain } from "citty";
import { liteEngine } from "./engine.ts";
import { VERSION } from "./version.ts";

const engineFrom = (args: Partial<ArgValues<typeof coreArgs & typeof httpArgs>>, defaults: { allowPrivateNetwork: boolean }) =>
  engineOrExit(() => liteEngine(resolveCoreConfig(coreOverrides(args), defaults)));

const search = defineCommand({
  meta: { name: "search", description: "Search the web via SearXNG" },
  args: { ...coreArgs, ...searchArgs },
  run: async ({ args }) => {
    const engine = engineFrom(args, { allowPrivateNetwork: true });
    if (engine) await runSearch(engine, args);
  },
});

const fetchCmd = defineCommand({
  meta: { name: "fetch", description: "Fetch a URL and print it as markdown (or other formats)" },
  args: {
    ...coreArgs,
    ...fetchArgs,
    formats: { type: "string", alias: "f", description: "Comma-separated: markdown,html,rawHtml,links,images (default markdown)" },
  },
  run: async ({ args }) => {
    const engine = engineFrom(args, { allowPrivateNetwork: true });
    if (!engine) return;
    await runFetch(engine, args, async () => {
      const formats = (list(args.formats) ?? []) as FormatOption[];
      return { formats: formats.length ? formats : ["markdown"] };
    });
  },
});

const serve = defineCommand({
  meta: {
    name: "serve",
    description: "Run the Firecrawl-compatible HTTP API (/v2/search, /v2/scrape) and MCP over HTTP (docs at /docs, MCP at /mcp)",
  },
  args: { ...coreArgs, ...httpArgs },
  run: async ({ args }) => {
    const engine = engineFrom(args, { allowPrivateNetwork: false });
    if (!engine) return;
    let stopServer: (() => Promise<void>) | undefined;
    onShutdown(engine, () => stopServer?.());
    if (!(await warmupOrExit(engine))) return;
    const { serveHttp } = await import("./server.ts");
    stopServer = serveHttp(engine, listenAddress(args)).stop;
  },
});

const main = defineCommand({
  meta: { name: "sex-lite", version: VERSION, description: "Self-hosted, Firecrawl-compatible web search + fetch (lite)" },
  subCommands: { search, fetch: fetchCmd, serve, http: serve },
});

runMain(main);
