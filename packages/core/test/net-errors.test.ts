import { describe, expect, test } from "bun:test";
import type { ErrorCode } from "@searxng-js/sex-errors";
import { networkError } from "../src/net.ts";

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
