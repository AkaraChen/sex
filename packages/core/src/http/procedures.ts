import { randomUUID } from "node:crypto";
import { ORPCError, os } from "@orpc/server";
import type { BaseEngine } from "../engine.ts";
import { AppError, toAppError } from "../errors.ts";
import { log } from "../log.ts";
import { ScrapeRequest, ScrapeResponse, SearchRequest, SearchResponse } from "../schemas.ts";

export interface HttpContext<E extends BaseEngine = BaseEngine> {
  engine: E;
  /** Public origin of this server, used to build job status URLs. */
  origin: string;
}

/** The procedure builder for a product's routes: AppErrors become oRPC errors so the response carries the right status and body. */
export function procedureBase<E extends BaseEngine>() {
  return os.$context<HttpContext<E>>().use(async ({ next }) => {
    try {
      return await next();
    } catch (err) {
      if (err instanceof ORPCError) throw err;
      const e = toAppError(err);
      if (e.status >= 500) {
        // Errors raised on purpose (an unreachable site, a refused LLM reply) need no stack; an unexpected one does.
        log.error("request failed", { code: e.code, error: e.message, stack: err instanceof AppError ? undefined : (err as Error)?.stack });
      }
      throw new ORPCError(e.code, { status: e.status, message: e.message, data: e.details, cause: e });
    }
  });
}

/** Results per source over HTTP when `limit` is absent (Firecrawl's default; the CLI and MCP keep 5 to spare an LLM tokens). */
const HTTP_SEARCH_LIMIT = 10;

const base = procedureBase<BaseEngine>();

/** `/v2/scrape` and `/v2/search`, served by sex and sex-lite alike. */
export const coreRoutes = {
  scrape: base
    .route({ method: "POST", path: "/v2/scrape", tags: ["Scrape"], summary: "Scrape a single URL" })
    .input(ScrapeRequest)
    .output(ScrapeResponse)
    .handler(async ({ input, context, signal }) => ({ success: true as const, data: await context.engine.scrape(input, signal) })),

  search: base
    .route({ method: "POST", path: "/v2/search", tags: ["Search"], summary: "Search the web via SearXNG, optionally scraping results" })
    .input(SearchRequest)
    .output(SearchResponse)
    .handler(async ({ input, context, signal }) => {
      const { data, warning } = await context.engine.search({ ...input, limit: input.limit ?? HTTP_SEARCH_LIMIT }, signal);
      return { success: true as const, id: randomUUID(), creditsUsed: 0, data, ...(warning ? { warning } : {}) };
    }),
};
