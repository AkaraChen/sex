import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Engine } from "../core/engine.ts";
import { log } from "../log.ts";
import { VERSION } from "../version.ts";
import { router } from "./router.ts";

interface Issue {
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>;
  message: string;
}

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

export function createApp(engine: Engine): Hono {
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

  const app = new Hono();
  app.use("*", cors());
  app.get("/", (c) => c.redirect("/docs"));
  app.get("/health", (c) => c.json({ status: "ok", version: VERSION, ...engine.describe() }));
  app.use("*", async (c, next) => {
    const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
    const started = performance.now();
    const { matched, response } = await handler.handle(c.req.raw, {
      prefix: "/",
      context: { engine, origin: `${proto}://${host}` },
    });
    if (matched) {
      log.info("http", { method: c.req.method, path: c.req.path, status: response.status, ms: Math.round(performance.now() - started) });
      return c.newResponse(response.body, response);
    }
    await next();
  });
  app.notFound((c) => c.json({ success: false, code: "NOT_FOUND", error: `No route for ${c.req.method} ${c.req.path}` }, 404));
  return app;
}

export function serveHttp(engine: Engine, opts: { port: number; host: string }) {
  const app = createApp(engine);
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.host,
    fetch: app.fetch,
    // Scrapes, searches with scrapeOptions and maps can legitimately take minutes.
    idleTimeout: 255,
  });
  log.info("http server listening", {
    url: `http://${opts.host}:${server.port}`,
    docs: `http://${opts.host}:${server.port}/docs`,
    ...engine.describe(),
  });
  return server;
}
