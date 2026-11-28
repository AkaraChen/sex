import { expect, test } from "bun:test";
import { SearchBackendError } from "@searxng-js/sex-search";
import { failure } from "../src/errors.ts";

test("maps SearchBackendError statuses to the expected HTTP status and code", () => {
  const cases: Array<[backendStatus: number, httpStatus: number, code: string]> = [
    [504, 504, "TIMEOUT"],
    [408, 504, "TIMEOUT"],
    [429, 429, "SEARCH_RATE_LIMITED"],
    [503, 503, "SEARCH_UNAVAILABLE"],
    [401, 502, "SEARCH_BACKEND_ERROR"],
    [403, 502, "SEARCH_BACKEND_ERROR"],
    [500, 502, "SEARCH_BACKEND_ERROR"],
    [502, 502, "SEARCH_BACKEND_ERROR"],
    [400, 502, "SEARCH_BACKEND_ERROR"],
    [599, 502, "SEARCH_BACKEND_ERROR"],
  ];

  for (const [backendStatus, httpStatus, code] of cases) {
    const source = new SearchBackendError(`backend failed (${backendStatus})`, backendStatus);
    const mapped = failure(source);
    expect(mapped.status).toBe(httpStatus);
    expect(mapped.code).toBe(code);
    expect(mapped.message).toBe(source.message);
    expect(mapped.cause).toBe(source);
  }
});
