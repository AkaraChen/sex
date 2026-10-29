import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AppError, BLOCKED_STATUSES, ERRORS, type ErrorCode, isBlocked, isErrorCode, toAppError } from "@searxng-js/sex-errors";

/** The fields of `actual` named in `expected` must equal it (no prototype comparison, unlike partialDeepStrictEqual). */
const matches = (actual: object, expected: Record<string, unknown>) =>
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((k) => [k, (actual as Record<string, unknown>)[k]])), expected);

describe("error catalog", () => {
  test("an AppError takes its status and hints from the catalog", () => {
    const err = new AppError("SCRAPE_TIMEOUT", "slow");
    matches(err, { status: 408, code: "SCRAPE_TIMEOUT", retryable: true, fallback: false });
    matches(new AppError("BROWSER_UNAVAILABLE", "down"), { status: 502, retryable: true, fallback: true });
  });

  test("retryable can be decided per instance for codes that depend on the cause", () => {
    assert.equal(new AppError("SEARCH_BACKEND_ERROR", "5xx", undefined, { retryable: true }).retryable, true);
    assert.equal(new AppError("SEARCH_BACKEND_ERROR", "403").retryable, false);
  });

  test("isBlocked is the one rule for a block worth a retry through another proxy", () => {
    assert.deepEqual(BLOCKED_STATUSES, [403, 429]);
    for (const status of [200, 301, 401, 404, 500, 503]) assert.equal(isBlocked(status), false);
    for (const status of BLOCKED_STATUSES) assert.equal(isBlocked(status), true);
    assert.equal(isBlocked(new AppError("SCRAPE_SITE_ERROR", "reset")), true);
    // Judged by code, not by the 403 these carry: a different proxy changes neither.
    assert.equal(isBlocked(new AppError("PRIVATE_NETWORK_BLOCKED", "private")), false);
    assert.equal(isBlocked(new AppError("SCRAPE_PROMPT_INJECTION_DETECTED", "injection")), false);
    assert.equal(isBlocked(new AppError("SCRAPE_TIMEOUT", "slow")), false);
    assert.equal(isBlocked(new AppError("FETCH_FAILED", "other")), false);
  });

  test("only retryable failures are blocks", () => {
    const blocked = Object.entries(ERRORS).filter(([, spec]) => spec.blocked);
    assert.deepEqual(
      blocked.map(([code]) => code),
      ["SCRAPE_SITE_ERROR"],
    );
    for (const [, spec] of blocked) assert.equal(spec.retryable, true);
  });

  test("502 and 503 are kept for backends that are down or answering with an error of their own", () => {
    const upstream = Object.entries(ERRORS)
      .filter(([, spec]) => spec.status === 502 || spec.status === 503)
      .map(([code]) => code)
      .sort();
    assert.deepEqual(
      upstream,
      [
        "BROWSER_UNAVAILABLE",
        "DOCS_UNAVAILABLE",
        "LLM_ERROR",
        "LLM_UNAVAILABLE",
        "SEARCH_BACKEND_ERROR",
        "SEARCH_BACKEND_UNAVAILABLE",
      ].sort(),
    );
  });

  test("failures that come out the same on a retry are not 502", () => {
    const deterministic: ErrorCode[] = [
      "LLM_REFUSED",
      "LLM_INVALID_OUTPUT",
      "LLM_INCOMPLETE_OUTPUT",
      "FETCH_FAILED",
      "SCRAPE_DNS_RESOLUTION_ERROR",
      "SCRAPE_SSL_ERROR",
      "SCRAPE_SITE_ERROR",
    ];
    for (const code of deterministic) assert.notEqual(ERRORS[code].status, 502);
    assert.equal(ERRORS.LLM_REFUSED.status, 422);
    assert.equal(ERRORS.LLM_INVALID_OUTPUT.status, 422);
    assert.equal(ERRORS.LLM_INCOMPLETE_OUTPUT.status, 422);
    assert.equal(ERRORS.FETCH_FAILED.status, 500);
  });

  test("a page that cannot be loaded the same way over HTTP does not offer the fallback", () => {
    for (const code of [
      "SCRAPE_DNS_RESOLUTION_ERROR",
      "SCRAPE_SSL_ERROR",
      "PRIVATE_NETWORK_BLOCKED",
      "SCRAPE_TIMEOUT",
      "TIMEOUT",
    ] as const) {
      assert.equal(ERRORS[code].fallback, false);
    }
    for (const code of ["SCRAPE_SITE_ERROR", "FETCH_FAILED", "BROWSER_UNAVAILABLE"] as const) assert.equal(ERRORS[code].fallback, true);
  });

  test("isErrorCode knows the catalog and nothing inherited", () => {
    assert.equal(isErrorCode("PDF_PARSE_FAILED"), true);
    assert.equal(isErrorCode("toString"), false);
    assert.equal(isErrorCode(undefined), false);
  });

  test("toAppError maps aborts to TIMEOUT and anything else to INTERNAL_ERROR", () => {
    matches(toAppError(new DOMException("aborted", "AbortError")), { status: 408, code: "TIMEOUT" });
    matches(toAppError(new Error("x")), { status: 500, code: "INTERNAL_ERROR" });
  });
});

describe("AppError.isInstance", () => {
  test("recognises an AppError and nothing else", () => {
    assert.equal(AppError.isInstance(new AppError("BAD_REQUEST", "x")), true);
    assert.equal(AppError.isInstance(new Error("x")), false);
    assert.equal(AppError.isInstance({ code: "BAD_REQUEST", status: 400 }), false);
    assert.equal(AppError.isInstance(undefined), false);
    assert.equal(AppError.isInstance(null), false);
  });

  test("the marker is Symbol.for('searxng-js.sex.error') set to true", () => {
    assert.equal((new AppError("BAD_REQUEST", "x") as unknown as Record<symbol, unknown>)[Symbol.for("searxng-js.sex.error")], true);
  });

  test("status, retryable, fallback and blocked live on the instance and isBlocked reads them", () => {
    const err = new AppError("SCRAPE_SITE_ERROR", "reset");
    assert.deepEqual(
      { status: err.status, retryable: err.retryable, fallback: err.fallback, blocked: err.blocked },
      { status: 500, retryable: true, fallback: true, blocked: true },
    );
    // An error from another copy (maybe an older catalog) is judged by its own fields, not by looking its code up here.
    const foreign = Object.assign(new AppError("FETCH_FAILED", "x"), { blocked: true });
    assert.equal(isBlocked(foreign), true);
  });

  test("two separately bundled copies recognise each other's errors; instanceof does not", async () => {
    // The source file or the built one, whichever the package name resolves to here.
    const entry = fileURLToPath(import.meta.resolve("@searxng-js/sex-errors"));
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "sex-errors-"));
    try {
      const files = [join(dir, "a.js"), join(dir, "b.js")];
      for (const out of files) execFileSync("bun", ["build", entry, "--outfile", out, "--target", "node"], { stdio: "pipe" });
      const [copyA, copyB] = await Promise.all(files.map((f) => import(f)));
      assert.notEqual(copyA.AppError, copyB.AppError);
      const thrown = (() => {
        try {
          throw new copyA.AppError("BAD_REQUEST", "from a");
        } catch (e) {
          return e;
        }
      })();
      assert.equal(copyB.AppError.isInstance(thrown), true);
      assert.equal(AppError.isInstance(thrown), true);
      assert.equal(thrown instanceof copyB.AppError, false);
      assert.equal(copyB.toAppError(thrown), thrown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
