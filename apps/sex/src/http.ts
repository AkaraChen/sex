import { randomUUID } from "node:crypto";
import { SearchRequest } from "@searxng-js/sex-search";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { Engine, ScrapeRequest } from "./engine.ts";
import { failure, HttpError } from "./errors.ts";

const ScrapeBody = z.object({ url: z.string().min(1) }).loose();
const MapBody = z.object({ url: z.string().min(1) }).loose();
const CrawlBody = z.object({ url: z.string().min(1) }).loose();
const BatchBody = z.object({ urls: z.array(z.string()).min(1) }).loose();

/**
 * The Firecrawl v2 HTTP API: scrape and search are answered here, map/crawl/batch are passed to firecrawl-local
 * unchanged, and everything else is a 404 (the v0 and v1 routes do not exist).
 */
export function createApp(engine: Engine): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const method = c.req.method;
    await next();
    c.header("access-control-allow-origin", "*");
    c.header("access-control-allow-headers", "authorization, content-type");
    c.header("access-control-allow-methods", "DELETE, GET, OPTIONS, POST");
    if (method !== "OPTIONS") c.header("vary", "origin");
  });
  app.options("*", (c) => c.body(null, 204));

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/v2/scrape", async (c) => {
    const request = parse(ScrapeBody, await json(c)) as ScrapeRequest;
    return c.json(await engine.scrape(request, c.req.raw.signal));
  });

  app.post("/v2/search", async (c) => {
    const request = parse(SearchRequest, await json(c));
    const { data, warning, provider } = await engine.search(request, c.req.raw.signal);
    return c.json({
      success: true as const,
      id: randomUUID(),
      creditsUsed: 0,
      provider,
      data,
      ...(warning ? { warning } : {}),
    });
  });

  app.post("/v2/map", async (c) => {
    const body = parse(MapBody, await json(c));
    return c.json(await engine.map(body, c.req.raw.signal));
  });

  app.post("/v2/crawl", async (c) => {
    const body = parse(CrawlBody, await json(c));
    return c.json(await engine.crawl(body, c.req.raw.signal));
  });

  app.get("/v2/crawl/:id", async (c) => c.json(await engine.crawlStatus(c.req.param("id"), c.req.raw.signal)));
  app.delete("/v2/crawl/:id", async (c) => c.json(await engine.crawlCancel(c.req.param("id"), c.req.raw.signal)));

  app.post("/v2/batch/scrape", async (c) => {
    const body = parse(BatchBody, await json(c));
    return c.json(await engine.batch(body, c.req.raw.signal));
  });

  app.get("/v2/batch/scrape/:id", async (c) => c.json(await engine.batchStatus(c.req.param("id"), c.req.raw.signal)));
  app.delete("/v2/batch/scrape/:id", async (c) =>
    c.json(await engine.batchCancel(c.req.param("id"), c.req.raw.signal)),
  );

  app.post("/v2/parse", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "BAD_REQUEST", "`file` is required (multipart/form-data)");
    const raw = form.get("options");
    let options: unknown;
    if (typeof raw === "string" && raw) {
      try {
        options = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "BAD_REQUEST", "`options` must be JSON");
      }
    }
    return c.json(await engine.parse(file, options, c.req.raw.signal));
  });

  app.notFound((c) => c.json({ success: false as const, error: "Route not found" }, 404));

  app.onError((err) => {
    const e = failure(err);
    return Response.json({ success: false as const, error: e.message, code: e.code }, { status: e.status });
  });

  return app;
}

async function json(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "The request body must be JSON");
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(400, "BAD_REQUEST", result.error.issues[0]?.message ?? "Invalid request body");
  return result.data;
}
