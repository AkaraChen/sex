import type { SearchAttempt, SearchErrorCode } from "./types.ts";

const messages: Record<SearchErrorCode, string> = {
  invalid_request: "Invalid search request.",
  unsupported_option: "A configured provider does not support the requested option.",
  configuration: "Invalid search provider configuration.",
  auth: "Provider authentication or account authorization failed.",
  rate_limit: "Provider rate limit reached.",
  network: "Search transport failed.",
  unavailable: "Search provider is temporarily unavailable.",
  attempt_timeout: "Search attempt exceeded its time budget.",
  timeout: "Search exceeded its total time budget.",
  aborted: "Search was cancelled.",
  invalid_response: "Provider returned an invalid search response.",
  provider_error: "Provider rejected the search request.",
};

/** Deliberately excludes raw provider bodies, transport messages and abort reasons. */
export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly attempts: readonly SearchAttempt[];
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: SearchErrorCode,
    details: {
      attempts?: readonly SearchAttempt[];
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(messages[code], "cause" in details ? { cause: details.cause } : undefined);
    this.name = "SearchError";
    this.code = code;
    this.attempts = Object.freeze((details.attempts ?? []).map((a) => Object.freeze({ ...a })));
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}
