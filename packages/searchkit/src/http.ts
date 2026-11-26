import ky, { type BeforeErrorState, HTTPError, type KyInstance, ResponseSizeError } from "ky";
import { SearchError } from "./errors.ts";
import type { AdapterOptions, FetchTransport, SearchErrorCode, SearchResult, SearchUsage } from "./types.ts";
import { configuration, optionalNumber, optionalString, optionalStrings, record, resultUrl } from "./validation.ts";

export function adapterOptions(options: AdapterOptions): { apiKey: string; fetch: FetchTransport } {
  configuration(options, ["apiKey", "fetch"]);
  if (!/^[\x21-\x7e]+$/.test(options.apiKey)) throw new SearchError("configuration");
  const transport = options.fetch ?? globalThis.fetch;
  if (typeof transport !== "function") throw new SearchError("configuration");
  return { apiKey: options.apiKey, fetch: transport };
}

export function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Bodies over this size are not a search answer; ky stops the read and reports it. */
const MAX_BYTES = 10 * 1024 * 1024;

function codeFor(status: number): SearchErrorCode {
  if (status === 401 || status === 402 || status === 403 || status === 432 || status === 433) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500 || status === 408) return "unavailable";
  return "provider_error";
}

/** The middleware: every ky failure leaves here as a SearchError code, so call sites have no failure branches. */
function classify({ error }: BeforeErrorState): Error {
  if (error instanceof HTTPError) {
    const retryAfterMs = retryAfter(error.response.headers.get("retry-after"));
    return new SearchError(codeFor(error.response.status), {
      status: error.response.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (error instanceof ResponseSizeError) return new SearchError("invalid_response", { cause: error });
  return new SearchError("network", { cause: error });
}

// Fixed origin (no redirects), no cookies, no internal retry, capped body; the caller's signal is the only timer.
const clients = new WeakMap<FetchTransport, KyInstance>();
function oneKyPer(transport: FetchTransport): KyInstance {
  let client = clients.get(transport);
  if (!client) {
    client = ky.create({
      fetch: transport,
      retry: 0,
      redirect: "error",
      credentials: "omit",
      maxResponseSize: MAX_BYTES,
      hooks: { beforeError: [classify] },
    });
    clients.set(transport, client);
  }
  return client;
}

/** One request, JSON in, JSON out; anything else is a SearchError that left the middleware above. */
export async function jsonRequest(
  transport: FetchTransport,
  url: string | URL,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await oneKyPer(transport)(url, init);
  try {
    return record(await response.json());
  } catch (cause) {
    throw new SearchError("invalid_response", { cause });
  }
}

/** One provider row, lifted into the normalized result by naming its fields. */
export function mappedResult(
  value: unknown,
  provider: string,
  retrievedAt: string,
  fields: { snippet?: string; highlights?: string; score?: string },
  requestId?: string,
): SearchResult {
  const row = record(value);
  const url = resultUrl(row.url);
  const title = optionalString(row.title);
  const snippet = fields.snippet ? optionalString(row[fields.snippet]) : undefined;
  const highlights = fields.highlights ? optionalStrings(row[fields.highlights]) : undefined;
  const score = fields.score ? optionalNumber(row[fields.score]) : undefined;
  return {
    url,
    ...(title !== undefined ? { title } : {}),
    ...(snippet !== undefined ? { snippet } : {}),
    ...(highlights !== undefined ? { highlights } : {}),
    ...(score !== undefined ? { score } : {}),
    provenance: { provider, sourceUrl: url, retrievedAt, ...(requestId ? { requestId } : {}) },
  };
}
export function results(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new SearchError("invalid_response");
  return value;
}
export function usage(value: unknown, field: string, unit: SearchUsage["unit"]): SearchUsage | null {
  if (value === undefined || value === null) return null;
  const amount = optionalNumber(record(value)[field]);
  if (amount === undefined) return null;
  if (amount < 0) throw new SearchError("invalid_response");
  return { unit, value: amount };
}
