import { describe, expect, test } from "bun:test";
import { AppError, ERRORS, type ErrorCode, isErrorCode, toAppError } from "../src/errors.ts";
import { networkError } from "../src/net.ts";

describe("error catalog", () => {
  test("an AppError takes its status and hints from the catalog", () => {
    const err = new AppError("SCRAPE_TIMEOUT", "slow");
    expect(err).toMatchObject({ status: 408, code: "SCRAPE_TIMEOUT", retryable: true, fallback: false });
    expect(new AppError("BROWSER_UNAVAILABLE", "down")).toMatchObject({ status: 502, retryable: true, fallback: true });
  });

  test("retryable can be decided per instance for codes that depend on the cause", () => {
    expect(new AppError("SEARCH_BACKEND_ERROR", "5xx", undefined, { retryable: true }).retryable).toBe(true);
    expect(new AppError("SEARCH_BACKEND_ERROR", "403").retryable).toBe(false);
  });

  test("502 and 503 are kept for backends that are down or answering with an error of their own", () => {
    const upstream = Object.entries(ERRORS)
      .filter(([, spec]) => spec.status === 502 || spec.status === 503)
      .map(([code]) => code)
      .sort();
    expect(upstream).toEqual(
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
    for (const code of deterministic) expect(ERRORS[code].status).not.toBe(502);
    expect(ERRORS.LLM_REFUSED.status).toBe(422);
    expect(ERRORS.LLM_INVALID_OUTPUT.status).toBe(422);
    expect(ERRORS.LLM_INCOMPLETE_OUTPUT.status).toBe(422);
    expect(ERRORS.FETCH_FAILED.status).toBe(500);
  });

  test("a page that cannot be loaded the same way over HTTP does not offer the fallback", () => {
    for (const code of [
      "SCRAPE_DNS_RESOLUTION_ERROR",
      "SCRAPE_SSL_ERROR",
      "PRIVATE_NETWORK_BLOCKED",
      "SCRAPE_TIMEOUT",
      "TIMEOUT",
    ] as const) {
      expect(ERRORS[code].fallback).toBe(false);
    }
    for (const code of ["SCRAPE_SITE_ERROR", "FETCH_FAILED", "BROWSER_UNAVAILABLE"] as const) expect(ERRORS[code].fallback).toBe(true);
  });

  test("isErrorCode knows the catalog and nothing inherited", () => {
    expect(isErrorCode("PDF_PARSE_FAILED")).toBe(true);
    expect(isErrorCode("toString")).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
  });

  test("toAppError maps aborts to TIMEOUT and anything else to INTERNAL_ERROR", () => {
    expect(toAppError(new DOMException("aborted", "AbortError"))).toMatchObject({ status: 408, code: "TIMEOUT" });
    expect(toAppError(new Error("x"))).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
  });
});

/** What fetch() rejects with in Bun: a TypeError whose `code` names the failure. */
const bunError = (code: string, message = code) => Object.assign(new TypeError(message), { code });

describe("networkError", () => {
  const url = "https://example.test/page";
  const classify = (err: unknown, opts?: { skipTlsVerification?: boolean }) => networkError(err, url, opts);

  test.each([["ENOTFOUND"], ["EAI_AGAIN"], ["EAI_NODATA"]])("%s is a DNS error", (code) => {
    expect(classify(bunError(code))).toMatchObject({ status: 500, code: "SCRAPE_DNS_RESOLUTION_ERROR", retryable: false });
  });

  test.each([
    ["DEPTH_ZERO_SELF_SIGNED_CERT"],
    ["SELF_SIGNED_CERT_IN_CHAIN"],
    ["CERT_HAS_EXPIRED"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
    ["ERR_TLS_CERT_ALTNAME_INVALID"],
  ])("%s is an SSL error that points at skipTlsVerification", (code) => {
    const err = classify(bunError(code));
    expect(err).toMatchObject({ status: 500, code: "SCRAPE_SSL_ERROR" });
    expect(err.message).toContain("skipTlsVerification");
  });

  test("the skipTlsVerification hint is left out when it was already set", () => {
    const err = classify(bunError("CERT_HAS_EXPIRED"), { skipTlsVerification: true });
    expect(err.code).toBe("SCRAPE_SSL_ERROR");
    expect(err.message).not.toContain("skipTlsVerification");
  });

  test("a TLS handshake that fails for another reason is an SSL error without the hint", () => {
    const err = classify(bunError("EPROTO", "EPROTO: The TLS handshake failed."));
    expect(err.code).toBe("SCRAPE_SSL_ERROR");
    expect(err.message).not.toContain("skipTlsVerification");
  });

  test.each([["ECONNREFUSED"], ["ECONNRESET"], ["ETIMEDOUT"], ["EHOSTUNREACH"], ["ConnectionRefused"]])(
    "%s is a site error that can be retried and answered over HTTP",
    (code) => {
      expect(classify(bunError(code))).toMatchObject({ status: 500, code: "SCRAPE_SITE_ERROR", retryable: true, fallback: true });
    },
  );

  test("the code is found on the cause too", () => {
    const err = new Error("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }) });
    expect(classify(err).code).toBe("SCRAPE_DNS_RESOLUTION_ERROR");
  });

  test.each<[string, ErrorCode]>([
    ["net::ERR_NAME_NOT_RESOLVED at https://example.test/page", "SCRAPE_DNS_RESOLUTION_ERROR"],
    ["net::ERR_CERT_AUTHORITY_INVALID at https://example.test/page", "SCRAPE_SSL_ERROR"],
    ["net::ERR_CERT_DATE_INVALID at https://example.test/page", "SCRAPE_SSL_ERROR"],
    ["net::ERR_SSL_PROTOCOL_ERROR at https://example.test/page", "SCRAPE_SSL_ERROR"],
    ["net::ERR_CONNECTION_REFUSED at https://example.test/page", "SCRAPE_SITE_ERROR"],
    ["net::ERR_CONNECTION_RESET at https://example.test/page", "SCRAPE_SITE_ERROR"],
    ["net::ERR_EMPTY_RESPONSE at https://example.test/page", "SCRAPE_SITE_ERROR"],
    ["net::ERR_SOMETHING_NEW at https://example.test/page", "SCRAPE_SITE_ERROR"],
    ["CouldntResolveHost at https://example.test/page", "SCRAPE_DNS_RESOLUTION_ERROR"],
    ["PeerFailedVerification at https://example.test/page", "SCRAPE_SSL_ERROR"],
    ["SslConnectError at https://example.test/page", "SCRAPE_SSL_ERROR"],
    ["CouldntConnect at https://example.test/page", "SCRAPE_SITE_ERROR"],
    ["RecvError at https://example.test/page", "SCRAPE_SITE_ERROR"],
  ])("browser error %s is %s", (message, expected) => {
    expect(classify(new Error(message)).code).toBe(expected);
  });

  test("a certificate error from the browser mentions skipTlsVerification", () => {
    expect(classify(new Error("net::ERR_CERT_AUTHORITY_INVALID at x")).message).toContain("skipTlsVerification");
  });

  test("anything unrecognised is FETCH_FAILED with the original message", () => {
    const err = classify(new Error("Protocol error (Page.navigate): Target closed"));
    expect(err).toMatchObject({ status: 500, code: "FETCH_FAILED", fallback: true });
    expect(err.message).toContain("Target closed");
    expect(classify(bunError("ERR_INVALID_ARG_TYPE", "bad option")).code).toBe("FETCH_FAILED");
    expect(classify("plain string").code).toBe("FETCH_FAILED");
  });
});
