import { describe, expect, test } from "bun:test";
import { matchesQueryOperators, parseQueryOperators, planOperatorQuery } from "../src/operators.ts";

const ok = (query: string, url: string, title = "") => matchesQueryOperators({ url, title }, planOperatorQuery(query));

describe("parseQueryOperators", () => {
  test("reads site:, -site:, inurl:, intitle: and quoted values, any case", () => {
    expect(
      parseQueryOperators('SITE:Example.com -site:bad.example.com inurl:docs intitle:"Getting Started" -intitle:beta -inurl:old foo'),
    ).toEqual({
      sites: ["example.com"],
      excludedSites: ["bad.example.com"],
      inurl: ["docs"],
      intitle: ["getting started"],
      excludedInurl: ["old"],
      excludedIntitle: ["beta"],
    });
  });

  test("ignores operator-like text inside quoted phrases", () => {
    expect(parseQueryOperators('"how to use site:evil.com" foo').sites).toEqual([]);
  });

  test("reads nothing when a quote is left open", () => {
    expect(parseQueryOperators('foo "site:a.com bar').sites).toEqual([]);
  });

  test("normalizes scheme, trailing slash and unicode hosts", () => {
    expect(parseQueryOperators("site:https://Example.com/docs/").sites).toEqual(["example.com/docs"]);
    expect(parseQueryOperators("site:bücher.de").sites).toEqual(["xn--bcher-kva.de"]);
  });

  test("a hyphen inside a word is not a negation", () => {
    expect(parseQueryOperators("foo-site:a.com").sites).toEqual([]);
  });
});

describe("planOperatorQuery", () => {
  test("keeps the query without the site: plus inurl:/intitle: combination", () => {
    expect(planOperatorQuery("site:a.com foo").query).toBe("site:a.com foo");
    expect(planOperatorQuery("inurl:docs foo")).toMatchObject({ query: "inurl:docs foo", relaxed: false });
  });

  test("turns inurl:/intitle: next to site: into plain terms and drops negated ones", () => {
    const plan = planOperatorQuery('site:a.com inurl:docs intitle:"quick start" -inurl:old foo');
    expect(plan.relaxed).toBe(true);
    expect(plan.query).toBe('site:a.com docs "quick start" foo');
  });

  test("keeps the closing parenthesis of a dropped operator", () => {
    expect(planOperatorQuery("(site:a.com -inurl:old) foo").query).toBe("(site:a.com ) foo");
  });

  test("enforces nothing when OR joins anything but site: operators", () => {
    const plan = planOperatorQuery("site:a.com foo OR bar");
    expect(plan.operators.sites).toEqual([]);
    expect(plan.query).toBe("site:a.com foo OR bar");
  });

  test("keeps an OR chain of site: operators", () => {
    expect(planOperatorQuery("(site:a.com OR site:b.com) foo").operators.sites).toEqual(["a.com", "b.com"]);
  });
});

describe("matchesQueryOperators", () => {
  test("site: matches the host and its subdomains, not look-alikes", () => {
    expect(ok("site:example.com x", "https://example.com/a")).toBe(true);
    expect(ok("site:example.com x", "https://docs.example.com/a")).toBe(true);
    expect(ok("site:example.com x", "https://notexample.com/a")).toBe(false);
    expect(ok("site:example.com x", "https://example.com.evil.test/a")).toBe(false);
  });

  test("site: with a path, and -site:", () => {
    expect(ok("site:example.com/docs x", "https://example.com/docs/a")).toBe(true);
    expect(ok("site:example.com/docs x", "https://example.com/blog/a")).toBe(false);
    expect(ok("x -site:example.com", "https://example.com/a")).toBe(false);
    expect(ok("x -site:example.com", "https://other.test/a")).toBe(true);
  });

  test("relaxed inurl: / intitle: are enforced on the result", () => {
    const q = "site:example.com inurl:docs intitle:guide -intitle:beta";
    expect(ok(q, "https://example.com/docs/a", "The Guide")).toBe(true);
    expect(ok(q, "https://example.com/blog/a", "The Guide")).toBe(false);
    expect(ok(q, "https://example.com/docs/a", "Beta guide")).toBe(false);
    expect(ok(q, "https://example.com/docs/a", "Overview")).toBe(false);
  });

  test("a query without enforceable operators accepts everything, even odd URLs", () => {
    expect(ok("plain words", "not a url")).toBe(true);
    expect(ok("site:a.com x", "not a url")).toBe(false);
  });
});
