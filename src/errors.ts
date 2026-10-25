/**
 * Error type shared by every layer. The HTTP layer turns it into a
 * Firecrawl-style `{ success: false, error, code, details }` body, the MCP
 * layer into a tool error, and the CLI into a message on stderr.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details);

export const notFound = (message: string) => new AppError(404, "NOT_FOUND", message);

/** A request needs a capability (browser, LLM, ...) that this deployment does not provide. */
export const notConfigured = (feature: string, hint: string) =>
  new AppError(501, `${feature.toUpperCase()}_NOT_CONFIGURED`, `${feature} is not configured on this server. ${hint}`);

export const unsupported = (what: string) => new AppError(501, "NOT_SUPPORTED", `${what} is not supported by this server.`);

export const BROWSER_HINT =
  "Start with --lightpanda (spawns a local Lightpanda) or --cdp-url <ws://...> (any CDP browser), or set SEX_LIGHTPANDA=1 / SEX_CDP_URL.";
export const LLM_HINT =
  "Pass --llm-model (plus --llm-base-url / --llm-api-key for non-OpenAI endpoints), or set SEX_LLM_MODEL / SEX_LLM_BASE_URL / SEX_LLM_API_KEY.";

export const browserRequired = (what: string) => notConfigured("Browser", `${what} needs a browser. ${BROWSER_HINT}`);
export const llmRequired = (what: string) => notConfigured("LLM", `${what} needs an LLM. ${LLM_HINT}`);

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new AppError(408, "TIMEOUT", err.message || "Operation timed out");
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AppError(500, "INTERNAL_ERROR", message);
}
