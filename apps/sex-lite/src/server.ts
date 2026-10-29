import { McpServer } from "@modelcontextprotocol/server";
import type { BaseEngine } from "@sex/core/engine.ts";
import { coreRoutes } from "@sex/core/http/procedures.ts";
import { type AppSpec, createHttpApp, serveHttpApp } from "@sex/core/http/server.ts";
import { registerFetchAndSearch } from "@sex/core/mcp/tools.ts";
import { VERSION } from "./version.ts";

const INSTRUCTIONS =
  "Web search (SearXNG) and page fetching (Defuddle). Use web_search to find pages, web_fetch to read one page as markdown.";

/** The MCP tools: web_fetch and web_search only. */
export function buildMcpServer(engine: BaseEngine): McpServer {
  const server = new McpServer({ name: "sex-lite", version: VERSION }, { instructions: INSTRUCTIONS });
  registerFetchAndSearch(server, engine, { llmFormats: false });
  return server;
}

const spec: AppSpec<BaseEngine> = {
  name: "sex-lite",
  version: VERSION,
  description:
    "Self-hosted, Firecrawl v2 compatible web search (SearXNG) and fetch (Defuddle): /v2/search and /v2/scrape only. Point a Firecrawl SDK's apiUrl at this server.",
  router: coreRoutes,
  mcp: buildMcpServer,
};

/** `/v2/scrape`, `/v2/search` and MCP at `/mcp`. `close` aborts in-flight MCP exchanges; call it on shutdown. */
export const createApp = (engine: BaseEngine, opts: { bindHost?: string } = {}) => createHttpApp(engine, spec, opts);

export const serveHttp = (engine: BaseEngine, opts: { port: number; host: string }) => serveHttpApp(engine, spec, opts);
