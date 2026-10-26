import { createMcpHandler } from "@modelcontextprotocol/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Engine } from "../core/engine.ts";
import { log } from "../log.ts";
import { buildServer } from "../mcp/server.ts";
import { VERSION } from "../version.ts";
import { router } from "./router.ts";

interface Issue {
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
  message: string;
}

/** Caller-supplied request ids are accepted only when they are short and token-safe. */
const REQUEST_ID = /^[\w.-]{1,128}$/;

const formatPath = (path: Issue["path"]) =>
  (path ?? []).map((p) => (typeof p === "object" && p !== null && "key" in p ? String(p.key) : String(p))).join(".");

/** Firecrawl-shaped error body: `{ success: false, error, code, details }`. */
function encodeError(error: { code: string; message: string; data: unknown; cause?: unknown }) {
  const cause = error.cause as { issues?: Issue[] } | undefined;
  if (Array.isArray(cause?.issues)) {
    const details = cause.issues.map((i) => ({ path: formatPath(i.path), message: i.message }));
    const summary = details
      .slice(0, 3)
      .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
      .join("; ");
    if (error.code === "BAD_REQUEST") {
      return { success: false, code: "BAD_REQUEST", error: `Invalid request body: ${summary}`, details };
    }
    // Output validation failed: this is a server bug, not a client error.
    return { success: false, code: "INVALID_RESPONSE", error: `Server produced an invalid response: ${summary}`, details };
  }
  return { success: false, code: error.code, error: error.message, ...(error.data !== undefined ? { details: error.data } : {}) };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const LOCALHOST_NAMES = ["localhost", "127.0.0.1", "[::1]"];

/** Parses a Host header value (`host[:port]`) into its normalised host and hostname, or undefined when malformed. */
function parseHost(hostHeader: string): { host: string; hostname: string } | undefined {
  try {
    const url = new URL(`http://${hostHeader}`);
    return { host: url.host, hostname: url.hostname };
  } catch {
    return undefined;
  }
}

const denied = (status: number, code: string, error: string) => Response.json({ success: false, code, error }, { status });

/**
 * DNS-rebinding and cross-site guard shared by the HTTP API and the MCP endpoint.
 * Returns a 403 response when the request must be refused, otherwise undefined.
 * - Host: when `allowedHosts` is set it must match; else on a loopback bind only localhost names pass.
 * - Origin: absent (non-browser clients) is allowed; otherwise it must be in `corsOrigins` or same-host.
 */
export function checkBrowserAccess(
  req: Request,
  opts: { bindHost?: string; corsOrigins: string[]; allowedHosts: string[] },
): Response | undefined {
  // Host is normally always sent; fall back to the request URL's host for callers that build requests without it.
  const hostHeader = req.headers.get("host") ?? new URL(req.url).host;
  const parsedHost = parseHost(hostHeader);
  if (opts.allowedHosts.length > 0) {
    if (!parsedHost || !opts.allowedHosts.includes(parsedHost.hostname)) {
      return denied(403, "HOST_NOT_ALLOWED", `Host header not allowed: ${hostHeader}`);
    }
  } else if (opts.bindHost && LOOPBACK_HOSTS.has(opts.bindHost)) {
    if (!parsedHost || !LOCALHOST_NAMES.includes(parsedHost.hostname)) {
      return denied(403, "HOST_NOT_ALLOWED", `Host header not allowed: ${hostHeader}`);
    }
  }

  const origin = req.headers.get("origin");
  if (origin !== null) {
    if (opts.corsOrigins.includes(origin)) return undefined;
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (originHost === undefined || !parsedHost || originHost !== parsedHost.host) {
      return denied(403, "ORIGIN_NOT_ALLOWED", `Origin not allowed: ${origin}`);
    }
  }
  return undefined;
}

/**
 * The Hono app for the REST API (oRPC) and MCP over streamable HTTP at `/mcp`, both behind the same Host/Origin checks and CORS.
 * `close` aborts in-flight MCP exchanges; call it on shutdown.
 */
export function createApp(engine: Engine, opts: { bindHost?: string } = {}): { app: Hono; close: () => Promise<void> } {
  const handler = new OpenAPIHandler(router, {
    customErrorResponseBodyEncoder: encodeError,
    plugins: [
      new OpenAPIReferencePlugin({
        schemaConverters: [new ZodToJsonSchemaConverter()],
        docsPath: "/docs",
        specPath: "/openapi.json",
        docsTitle: "sex API",
        specGenerateOptions: {
          info: {
            title: "sex",
            version: VERSION,
            description:
              "Self-hosted, Firecrawl v2 compatible web search (SearXNG) and fetch (Defuddle) API. Point a Firecrawl SDK's apiUrl at this server.",
          },
        },
      }),
    ],
  });

  const mcp = createMcpHandler(() => buildServer(engine));

  const app = new Hono();
  const { corsOrigins, allowedHosts } = engine.config;
  app.use("*", async (c, next) => {
    const refused = checkBrowserAccess(c.req.raw, { bindHost: opts.bindHost, corsOrigins, allowedHosts });
    if (refused) return refused;
    await next();
  });
  if (corsOrigins.length > 0) {
    app.use(
      "*",
      cors({ origin: corsOrigins, allowHeaders: ["authorization", "content-type", "x-request-id"], exposeHeaders: ["x-request-id"] }),
    );
  }
  app.get("/", (c) => c.redirect("/docs"));
  app.get("/health", (c) => c.json({ status: "ok", version: VERSION, ...engine.describe() }));
  // Registered before the oRPC middleware below, so the router never sees (or reads the body of) MCP requests.
  app.all("/mcp", (c) => mcp.fetch(c.req.raw));
  app.use("*", async (c, next) => {
    const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
    const started = performance.now();
    const incoming = c.req.header("x-request-id");
    const rid = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: "/",
      context: { engine, origin: `${proto}://${host}` },
    });
    if (matched) {
      const fields = { method: c.req.method, path: c.req.path, status: response.status, ms: Math.round(performance.now() - started), rid };
      if (response.status >= 500) log.warn("http", fields);
      else log.info("http", fields);
      const out = c.newResponse(response.body, response);
      out.headers.set("x-request-id", rid);
      return out;
    }
    await next();
  });
  app.notFound((c) => c.json({ success: false, code: "NOT_FOUND", error: `No route for ${c.req.method} ${c.req.path}` }, 404));
  return { app, close: mcp.close };
}

export function serveHttp(engine: Engine, opts: { port: number; host: string }) {
  const { app, close } = createApp(engine, { bindHost: opts.host });
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    fetch: app.fetch,
    // Scrapes, searches with scrapeOptions and maps can legitimately take minutes.
    idleTimeout: 255,
  });
  const url = `http://${opts.host}:${server.port}`;
  log.info("http server listening", { url, docs: `${url}/docs`, mcp: `${url}/mcp`, ...engine.describe() });
  return {
    server,
    /** Aborts in-flight MCP exchanges, then closes the listener and its open connections. */
    stop: async () => {
      await close();
      await server.stop(true);
    },
  };
}
