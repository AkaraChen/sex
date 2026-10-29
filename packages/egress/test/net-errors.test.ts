import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { networkError } from "@searxng-js/sex-egress";

/** The fields of `actual` named in `expected` must equal it. */
const matches = (actual: unknown, expected: Record<string, unknown>) =>
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((k) => [k, (actual as Record<string, unknown>)[k]])), expected);

/** What fetch() rejects with in Bun: a TypeError whose `code` names the failure. */
const bunError = (code: string, message = code) => Object.assign(new TypeError(message), { code });

describe("networkError", () => {
  const url = "https://example.test/page";
  const classify = (err: unknown, opts?: { skipTlsVerification?: boolean }) => networkError(err, url, opts);

  for (const code of ["ENOTFOUND", "EAI_AGAIN", "EAI_NODATA"]) {
    test(`${code} is a DNS error`, () => {
      matches(classify(bunError(code)), { status: 500, code: "SCRAPE_DNS_RESOLUTION_ERROR", retryable: false });
    });
  }

  for (const code of [
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ]) {
    test(`${code} is an SSL error that points at skipTlsVerification`, () => {
      const err = classify(bunError(code));
      matches(err, { status: 500, code: "SCRAPE_SSL_ERROR" });
      assert.ok(err.message.includes("skipTlsVerification"));
    });
  }

  test("the skipTlsVerification hint is left out when it was already set", () => {
    const err = classify(bunError("CERT_HAS_EXPIRED"), { skipTlsVerification: true });
    assert.equal(err.code, "SCRAPE_SSL_ERROR");
    assert.ok(!err.message.includes("skipTlsVerification"));
  });

  test("a TLS handshake that fails for another reason is an SSL error without the hint", () => {
    const err = classify(bunError("EPROTO", "EPROTO: The TLS handshake failed."));
    assert.equal(err.code, "SCRAPE_SSL_ERROR");
    assert.ok(!err.message.includes("skipTlsVerification"));
  });

  for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ConnectionRefused"]) {
    test(`${code} is a site error that can be retried and answered over HTTP`, () => {
      matches(classify(bunError(code)), { status: 500, code: "SCRAPE_SITE_ERROR", retryable: true, fallback: true });
    });
  }

  test("the code is found on the cause too", () => {
    const err = new Error("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }) });
    assert.equal(classify(err).code, "SCRAPE_DNS_RESOLUTION_ERROR");
  });

  const browserErrors: [string, string][] = [
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
  ];
  for (const [message, expected] of browserErrors) {
    test(`browser error ${message} is ${expected}`, () => {
      assert.equal(classify(new Error(message)).code, expected);
    });
  }

  test("a certificate error from the browser mentions skipTlsVerification", () => {
    assert.ok(classify(new Error("net::ERR_CERT_AUTHORITY_INVALID at x")).message.includes("skipTlsVerification"));
  });

  test("anything unrecognised is FETCH_FAILED with the original message", () => {
    const err = classify(new Error("Protocol error (Page.navigate): Target closed"));
    matches(err, { status: 500, code: "FETCH_FAILED", fallback: true });
    assert.ok(err.message.includes("Target closed"));
    assert.equal(classify(bunError("ERR_INVALID_ARG_TYPE", "bad option")).code, "FETCH_FAILED");
    assert.equal(classify("plain string").code, "FETCH_FAILED");
  });
});
