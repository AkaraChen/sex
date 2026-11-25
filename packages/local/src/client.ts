/** The time one call has: the caller's cancellation and, optionally, a wall-clock deadline. */
export interface CallTime {
  signal?: AbortSignal;
  /** Epoch milliseconds. The call is cut off at this instant. */
  deadlineAt?: number;
}

export interface ClientOptions {
  /** `http://127.0.0.1:port`, with or without a trailing slash. */
  baseUrl: string;
  token?: string;
  /** The `fetch` requests go through; replace it for proxies, retries or tests. */
  fetch?: typeof fetch;
  /** Per-request timeout. Default: 60 s. */
  timeoutMs?: number;
}

/** A Firecrawl-shaped success body. The `data` field is whatever the route returns. */
export interface JsonResponse {
  success: true;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export class LocalError extends Error {
  /** The HTTP status the child answered with, or 499 (timeout) / 503 (unreachable). */
  readonly status: number;
  readonly code: string;
  readonly body: string;

  constructor(status: number, code: string, message: string, body = "", options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export interface LocalClient {
  scrape(body: Record<string, unknown>, time?: CallTime): Promise<JsonResponse>;
  map(body: Record<string, unknown>, time?: CallTime): Promise<JsonResponse>;
  crawl(body: Record<string, unknown>, time?: CallTime): Promise<JsonResponse>;
  crawlStatus(id: string, time?: CallTime): Promise<JsonResponse>;
  crawlCancel(id: string, time?: CallTime): Promise<JsonResponse>;
  batch(body: Record<string, unknown>, time?: CallTime): Promise<JsonResponse>;
  batchStatus(id: string, time?: CallTime): Promise<JsonResponse>;
  batchCancel(id: string, time?: CallTime): Promise<JsonResponse>;
  health(): Promise<boolean>;
}

export function createClient(options: ClientOptions): LocalClient {
  const f = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 60_000;

  async function request(path: string, init: RequestInit, time?: CallTime): Promise<JsonResponse> {
    const headers: Record<string, string> = { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) };
    if (init.body !== undefined && !(init.body instanceof FormData)) headers["content-type"] = "application/json";

    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (time?.signal) signals.push(time.signal);
    if (time?.deadlineAt !== undefined) signals.push(AbortSignal.timeout(Math.max(1, time.deadlineAt - Date.now())));

    let response: Response;
    try {
      response = await f(`${base}${path}`, { ...init, headers, signal: AbortSignal.any(signals) });
    } catch (err) {
      if (signals.some((signal) => signal.aborted)) {
        throw new LocalError(499, "TIMEOUT", "Timed out", "", { cause: err });
      }
      throw new LocalError(
        503,
        "LOCAL_UNAVAILABLE",
        `firecrawl-local is not reachable at ${base}: ${message(err)}`,
        "",
        {
          cause: err,
        },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      const parsed = parseJson(text);
      const error = typeof parsed?.error === "string" ? parsed.error : text.slice(0, 300);
      throw new LocalError(response.status, codeOf(parsed, response.status), error || `HTTP ${response.status}`, text);
    }
    const parsed = parseJson(text);
    if (parsed === undefined) {
      throw new LocalError(502, "BAD_RESPONSE", `firecrawl-local answered a non-JSON body (${response.status})`, text);
    }
    return parsed as JsonResponse;
  }

  const post = (path: string, body: Record<string, unknown>, time?: CallTime) =>
    request(path, { method: "POST", body: JSON.stringify(body) }, time);

  return {
    scrape: (body, time) => post("/v2/scrape", body, time),
    map: (body, time) => post("/v2/map", body, time),
    crawl: (body, time) => post("/v2/crawl", body, time),
    crawlStatus: (id, time) => request(`/v2/crawl/${encodeURIComponent(id)}`, { method: "GET" }, time),
    crawlCancel: (id, time) => request(`/v2/crawl/${encodeURIComponent(id)}`, { method: "DELETE" }, time),
    batch: (body, time) => post("/v2/batch/scrape", body, time),
    batchStatus: (id, time) => request(`/v2/batch/scrape/${encodeURIComponent(id)}`, { method: "GET" }, time),
    batchCancel: (id, time) => request(`/v2/batch/scrape/${encodeURIComponent(id)}`, { method: "DELETE" }, time),
    health: async () => {
      try {
        const response = await f(`${base}/health`, {
          headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
          signal: AbortSignal.timeout(1000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function codeOf(parsed: Record<string, unknown> | undefined, status: number): string {
  return typeof parsed?.code === "string" ? parsed.code : `HTTP_${status}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
