import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { matchesQueryOperators, parseQueryOperators, planOperatorQuery } from "@searxng-js/sex-search";

/** The fields of `actual` named in `expected` must equal it. */
const matches = (actual: unknown, expected: Record<string, unknown>) =>
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((k) => [k, (actual as Record<string, unknown>)[k]])), expected);

const ok = (query: string, url: string, title = "") => matchesQueryOperators({ url, title }, planOperatorQuery(query));

describe("parseQueryOperators", () => {
  test("reads site:, -site:, inurl:, intitle: and quoted values, any case", () => {
    assert.deepEqual(
      parseQueryOperators('SITE:Example.com -site:bad.example.com inurl:docs intitle:"Getting Started" -intitle:beta -inurl:old foo'),
      {
        sites: ["example.com"],
        excludedSites: ["bad.example.com"],
        inurl: ["docs"],
        intitle: ["getting started"],
        excludedInurl: ["old"],
        excludedIntitle: ["beta"],
      },
    );
  });

  test("ignores operator-like text inside quoted phrases", () => {
    assert.deepEqual(parseQueryOperators('"how to use site:evil.com" foo').sites, []);
  });

  test("reads nothing when a quote is left open", () => {
    assert.deepEqual(parseQueryOperators('foo "site:a.com bar').sites, []);
  });

  test("normalizes scheme, trailing slash and unicode hosts", () => {
    assert.deepEqual(parseQueryOperators("site:https://Example.com/docs/").sites, ["example.com/docs"]);
    assert.deepEqual(parseQueryOperators("site:bücher.de").sites, ["xn--bcher-kva.de"]);
  });

  test("a hyphen inside a word is not a negation", () => {
    assert.deepEqual(parseQueryOperators("foo-site:a.com").sites, []);
  });
});

describe("planOperatorQuery", () => {
  test("keeps the query without the site: plus inurl:/intitle: combination", () => {
    assert.equal(planOperatorQuery("site:a.com foo").query, "site:a.com foo");
    matches(planOperatorQuery("inurl:docs foo"), { query: "inurl:docs foo", relaxed: false });
  });

  test("turns inurl:/intitle: next to site: into plain terms and drops negated ones", () => {
    const plan = planOperatorQuery('site:a.com inurl:docs intitle:"quick start" -inurl:old foo');
    assert.equal(plan.relaxed, true);
    assert.equal(plan.query, 'site:a.com docs "quick start" foo');
  });

  test("keeps the closing parenthesis of a dropped operator", () => {
    assert.equal(planOperatorQuery("(site:a.com -inurl:old) foo").query, "(site:a.com ) foo");
  });

  test("enforces nothing when OR joins anything but site: operators", () => {
    const plan = planOperatorQuery("site:a.com foo OR bar");
    assert.deepEqual(plan.operators.sites, []);
    assert.equal(plan.query, "site:a.com foo OR bar");
  });

  test("keeps an OR chain of site: operators", () => {
    assert.deepEqual(planOperatorQuery("(site:a.com OR site:b.com) foo").operators.sites, ["a.com", "b.com"]);
  });
});

describe("matchesQueryOperators", () => {
  test("site: matches the host and its subdomains, not look-alikes", () => {
    assert.equal(ok("site:example.com x", "https://example.com/a"), true);
    assert.equal(ok("site:example.com x", "https://docs.example.com/a"), true);
    assert.equal(ok("site:example.com x", "https://notexample.com/a"), false);
    assert.equal(ok("site:example.com x", "https://example.com.evil.test/a"), false);
  });

  test("site: with a path, and -site:", () => {
    assert.equal(ok("site:example.com/docs x", "https://example.com/docs/a"), true);
    assert.equal(ok("site:example.com/docs x", "https://example.com/blog/a"), false);
    assert.equal(ok("x -site:example.com", "https://example.com/a"), false);
    assert.equal(ok("x -site:example.com", "https://other.test/a"), true);
  });

  test("relaxed inurl: / intitle: are enforced on the result", () => {
    const q = "site:example.com inurl:docs intitle:guide -intitle:beta";
    assert.equal(ok(q, "https://example.com/docs/a", "The Guide"), true);
    assert.equal(ok(q, "https://example.com/blog/a", "The Guide"), false);
    assert.equal(ok(q, "https://example.com/docs/a", "Beta guide"), false);
    assert.equal(ok(q, "https://example.com/docs/a", "Overview"), false);
  });

  test("a query without enforceable operators accepts everything, even odd URLs", () => {
    assert.equal(ok("plain words", "not a url"), true);
    assert.equal(ok("site:a.com x", "not a url"), false);
  });
});
