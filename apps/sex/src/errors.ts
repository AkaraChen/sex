import { LocalError, StartServerError } from "@searxng-js/sex-local";
import { ParserError, ParserTimeoutError, ParserUnavailableError } from "@searxng-js/sex-parse";
import { SearchBackendError } from "@searxng-js/sex-search";

/** An HTTP failure with the status and code the response carries. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/** Maps anything thrown by the packages onto the response it becomes. */
export function failure(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof LocalError) {
    if (err.code === "TIMEOUT") return new HttpError(504, "TIMEOUT", err.message, { cause: err });
    if (err.code === "LOCAL_UNAVAILABLE") return new HttpError(503, "SCRAPE_UNAVAILABLE", err.message, { cause: err });
    // A token or upstream failure is ours, not the caller's.
    if (err.status >= 500 || err.status === 401 || err.status === 403) {
      return new HttpError(502, err.code, err.message, { cause: err });
    }
    return new HttpError(err.status, err.code, err.message, { cause: err });
  }
  if (err instanceof SearchBackendError) return new HttpError(502, "SEARCH_BACKEND_ERROR", err.message, { cause: err });
  if (err instanceof ParserUnavailableError)
    return new HttpError(503, "PARSE_UNAVAILABLE", err.message, { cause: err });
  if (err instanceof ParserTimeoutError) return new HttpError(504, "TIMEOUT", err.message, { cause: err });
  if (err instanceof ParserError) return new HttpError(500, "PARSE_FAILED", err.message, { cause: err });
  if (err instanceof StartServerError) return new HttpError(503, "SCRAPE_UNAVAILABLE", err.message, { cause: err });
  return new HttpError(500, "INTERNAL", err instanceof Error ? err.message : String(err), { cause: err });
}
