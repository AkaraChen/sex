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

/** Bodies over this size are not a search answer; stop reading at ten MiB. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * One POST/GET, JSON in, JSON out. Fixed origins (no redirects), no cookies, the caller's signal
 * as the only timer, and every failure arriving as a SearchError code.
 */
export async function jsonRequest(
  transport: FetchTransport,
  url: string | URL,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await transport(url, { ...init, redirect: "error", credentials: "omit" });
  } catch (cause) {
    if (cause instanceof SearchError) throw cause;
    throw new SearchError("network", { cause });
  }
  if (!response.ok) {
    const status = response.status;
    const code: SearchErrorCode =
      status === 401 || status === 403 || status === 402 || status === 432 || status === 433
        ? "auth"
        : status === 429
          ? "rate_limit"
          : (status >= 500 && status <= 599) || status === 408
            ? "unavailable"
            : "provider_error";
    const retryAfterMs = retryAfter(response.headers.get("retry-after"));
    void response.body?.cancel().catch(() => {});
    throw new SearchError(code, { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  const reader = response.body?.getReader();
  try {
    while (reader) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > MAX_BYTES) throw new SearchError("invalid_response");
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } catch (cause) {
    if (cause instanceof SearchError) throw cause;
    throw new SearchError("network", { cause });
  } finally {
    void response.body?.cancel().catch(() => {});
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SearchError("invalid_response");
  }
  return record(body);
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
