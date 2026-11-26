import ky, { type BeforeErrorState, type Hooks, HTTPError, TimeoutError } from "ky";

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
  const base = options.baseUrl.replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 60_000;
  const hooks: Hooks = { beforeError: [toLocalError(base)] };
  if (options.token) {
    const token = options.token;
    hooks.beforeRequest = [({ request }) => void request.headers.set("authorization", `Bearer ${token}`)];
  }
  const client = ky.create({ retry: 0, ...(options.fetch ? { fetch: options.fetch } : {}), hooks });

  async function request(
    method: "DELETE" | "GET" | "POST",
    path: string,
    time: CallTime | undefined,
    body?: Record<string, unknown>,
  ): Promise<JsonResponse> {
    // ky owns the timer: a caller deadline just shortens the same one timeout.
    const timeout =
      time?.deadlineAt === undefined ? timeoutMs : Math.min(timeoutMs, Math.max(1, time.deadlineAt - Date.now()));
    const response = await client(`${base}/${path}`, {
      method,
      ...(body === undefined ? {} : { json: body }),
      timeout,
      ...(time?.signal ? { signal: time.signal } : {}),
    });
    const text = await response.text();
    const parsed = parseJson(text);
    if (parsed === undefined)
      throw new LocalError(502, "BAD_RESPONSE", `firecrawl-local answered a non-JSON body (${response.status})`, text);
    return parsed as JsonResponse;
  }

  const post = (path: string, body: Record<string, unknown>, time?: CallTime) => request("POST", path, time, body);

  return {
    scrape: (body, time) => post("v2/scrape", body, time),
    map: (body, time) => post("v2/map", body, time),
    crawl: (body, time) => post("v2/crawl", body, time),
    crawlStatus: (id, time) => request("GET", `v2/crawl/${encodeURIComponent(id)}`, time),
    crawlCancel: (id, time) => request("DELETE", `v2/crawl/${encodeURIComponent(id)}`, time),
    batch: (body, time) => post("v2/batch/scrape", body, time),
    batchStatus: (id, time) => request("GET", `v2/batch/scrape/${encodeURIComponent(id)}`, time),
    batchCancel: (id, time) => request("DELETE", `v2/batch/scrape/${encodeURIComponent(id)}`, time),
    health: async () => {
      try {
        return (await client(`${base}/health`, { timeout: 1000, throwHttpErrors: false })).ok;
      } catch {
        return false;
      }
    },
  };
}

/** The middleware: every ky failure leaves here as the one LocalError its caller needs. */
function toLocalError(base: string) {
  return ({ error }: BeforeErrorState): Error => {
    if (error instanceof HTTPError) {
      // ky pre-parses the failed body into `error.data`; the response keeps only status and headers.
      const parsed =
        typeof error.data === "object" && error.data !== null ? (error.data as Record<string, unknown>) : undefined;
      const text = typeof error.data === "string" ? error.data : parsed === undefined ? "" : JSON.stringify(parsed);
      const detail = typeof parsed?.error === "string" ? parsed.error : text.slice(0, 300);
      return new LocalError(
        error.response.status,
        codeOf(parsed, error.response.status),
        detail || `HTTP ${error.response.status}`,
        text,
        { cause: error },
      );
    }
    if (error instanceof TimeoutError || isAbort(error))
      return new LocalError(499, "TIMEOUT", "Timed out", "", { cause: error });
    return new LocalError(
      503,
      "LOCAL_UNAVAILABLE",
      `firecrawl-local is not reachable at ${base}: ${error instanceof Error ? error.message : String(error)}`,
      "",
      { cause: error },
    );
  };
}

/** A caller cancellation surfaces as an AbortError somewhere in the cause chain. */
function isAbort(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause instanceof Error ? e.cause : undefined) {
    if (e.name === "AbortError") return true;
  }
  return false;
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
