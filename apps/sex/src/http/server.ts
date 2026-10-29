import { type AppSpec, createHttpApp, serveHttpApp } from "@sex/core/http/server.ts";
import type { Engine } from "../engine/engine.ts";
import { buildServer } from "../mcp/server.ts";
import { VERSION } from "../version.ts";
import { router } from "./router.ts";

const spec: AppSpec<Engine> = {
  name: "sex",
  version: VERSION,
  description:
    "Self-hosted, Firecrawl v2 compatible web search (SearXNG) and fetch (Defuddle) API. Point a Firecrawl SDK's apiUrl at this server.",
  router,
  mcp: buildServer,
};

/** The REST API (oRPC) and MCP over streamable HTTP at `/mcp`. `close` aborts in-flight MCP exchanges; call it on shutdown. */
export const createApp = (engine: Engine, opts: { bindHost?: string } = {}) => createHttpApp(engine, spec, opts);

export const serveHttp = (engine: Engine, opts: { port: number; host: string }) => serveHttpApp(engine, spec, opts);
