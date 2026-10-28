/**
 * Every error code sex returns, with what a caller (or the engine) may assume about it.
 *
 * - `status`: the HTTP status. Failures that will come out the same on a second try are never 502/503: the Firecrawl SDK
 *   retries those, which for an LLM-backed request means paying for the same refusal three times. 502/503 are for a
 *   backend that is down (`*_UNAVAILABLE`) or answering with an error of its own (`LLM_ERROR`, `SEARCH_BACKEND_ERROR`).
 * - `retryable`: whether trying the same request again can succeed. Advisory; it is sent to HTTP clients and read by
 *   sex's own retry loops (SearXNG).
 * - `fallback`: whether a failure of the browser path can be answered by fetching the page over plain HTTP instead.
 *   False when the HTTP fetch would fail the same way (DNS, TLS, blocked address) or the request asked for something
 *   only a browser does (that check is made by the caller: actions).
 */
export interface ErrorSpec {
  readonly status: number;
  readonly retryable: boolean;
  readonly fallback: boolean;
}

const spec = (status: number, retryable = false, fallback = false): ErrorSpec => ({ status, retryable, fallback });

export const ERRORS = {
  // The request itself is wrong.
  BAD_REQUEST: spec(400),
  CONFIG_INVALID: spec(400),
  NOT_FOUND: spec(404),
  JOB_FINISHED: spec(409),
  /** A browser action failed (selector not found, script threw): a property of the request, not of the site. */
  ACTION_FAILED: spec(400),

  // This server cannot do it.
  NOT_SUPPORTED: spec(501),
  BROWSER_NOT_CONFIGURED: spec(501),
  LLM_NOT_CONFIGURED: spec(501),
  BROWSER_INTERCEPTION_UNSUPPORTED: spec(501),
  PRIVATE_NETWORK_BLOCKED: spec(403),
  SCRAPE_PROMPT_INJECTION_DETECTED: spec(403),

  // Time: the scrape's deadline ran out, or the caller gave up.
  SCRAPE_TIMEOUT: spec(408, true),
  /** The caller cancelled, or a step that has its own limit (an LLM call, a SearXNG request) timed out. */
  TIMEOUT: spec(408),

  // The target page.
  SCRAPE_DNS_RESOLUTION_ERROR: spec(500),
  SCRAPE_SSL_ERROR: spec(500),
  /** The site refused, reset or dropped the connection, or the browser reported another `net::ERR_*`. */
  SCRAPE_SITE_ERROR: spec(500, true, true),
  /** Any other failure to fetch the page. */
  FETCH_FAILED: spec(500, false, true),
  TOO_MANY_REDIRECTS: spec(508),
  RESPONSE_TOO_LARGE: spec(413),
  UNSUPPORTED_FILE: spec(415),

  // Files and extraction.
  DOCUMENT_PARSE_FAILED: spec(422),
  PDF_PARSE_FAILED: spec(422),
  DOCUMENT_CONVERT_FAILED: spec(500),
  EXTRACT_FAILED: spec(500),
  EXTRACT_TIMEOUT: spec(422),

  // The LLM. A reply that was refused, cut off or does not fit the schema is deterministic for this input.
  LLM_REFUSED: spec(422),
  LLM_INVALID_OUTPUT: spec(422),
  LLM_INCOMPLETE_OUTPUT: spec(422),
  /** The endpoint answered 4xx (bad key, unknown model, request refused): a configuration error, the same on every try. */
  LLM_REQUEST_REJECTED: spec(500),
  LLM_RATE_LIMITED: spec(429, true),
  LLM_ERROR: spec(502, true),
  LLM_UNAVAILABLE: spec(502, true),

  // Backends that are down.
  BROWSER_UNAVAILABLE: spec(502, true, true),
  DOCS_UNAVAILABLE: spec(502, true),
  SEARCH_BACKEND_UNAVAILABLE: spec(502, true),
  SEARCH_BACKEND_ERROR: spec(502),

  INTERNAL_ERROR: spec(500),
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERRORS;

export const isErrorCode = (code: unknown): code is ErrorCode => typeof code === "string" && Object.hasOwn(ERRORS, code);

/**
 * Error type shared by every layer. The HTTP layer turns it into a Firecrawl-style
 * `{ success: false, error, code, details }` body, the MCP layer into a tool error, and the CLI into a message on stderr.
 * The status and the retry / fallback hints come from the `ERRORS` catalog, never from the throw site.
 */
export class AppError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly fallback: boolean;

  /** `overrides.retryable` is for the few codes whose answer depends on the instance (SearXNG: a 5xx is worth retrying, a 403 is not). */
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    overrides?: { retryable?: boolean },
  ) {
    super(message);
    this.name = "AppError";
    const s = ERRORS[code];
    this.status = s.status;
    this.retryable = overrides?.retryable ?? s.retryable;
    this.fallback = s.fallback;
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError("BAD_REQUEST", message, details);

export const notFound = (message: string) => new AppError("NOT_FOUND", message);

export const unsupported = (what: string) => new AppError("NOT_SUPPORTED", `${what} is not supported by this server.`);

export const BROWSER_HINT =
  "Start with --lightpanda (spawns a local Lightpanda) or --cdp-url <ws://...> (any CDP browser), or set SEX_LIGHTPANDA=1 / SEX_CDP_URL.";
export const LLM_HINT =
  "Pass --llm-model (plus --llm-base-url / --llm-api-key for non-OpenAI endpoints), or set SEX_LLM_MODEL / SEX_LLM_BASE_URL / SEX_LLM_API_KEY.";

/** A request needs a capability (browser, LLM, ...) that this deployment does not provide. */
export const browserRequired = (what: string) =>
  new AppError("BROWSER_NOT_CONFIGURED", `Browser is not configured on this server. ${what} needs a browser. ${BROWSER_HINT}`);
export const llmRequired = (what: string) =>
  new AppError("LLM_NOT_CONFIGURED", `LLM is not configured on this server. ${what} needs an LLM. ${LLM_HINT}`);

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new AppError("TIMEOUT", err.message || "Operation timed out");
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AppError("INTERNAL_ERROR", message);
}
