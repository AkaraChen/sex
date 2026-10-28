import { describe, expect, test } from "bun:test";
import { buildTable, ruleToTableLine } from "../scripts/adblock.ts";
import { AdBlockList, siteOf } from "../src/engine/adblock.ts";

describe("ruleToTableLine", () => {
  test("keeps domain block rules, third-party-only rules and exceptions", () => {
    expect(ruleToTableLine("||ads.example.com^")).toBe("ads.example.com");
    expect(ruleToTableLine("||Tracker.Example.COM^$third-party")).toBe("~tracker.example.com");
    expect(ruleToTableLine("||tracker.example.com^$3p")).toBe("~tracker.example.com");
    expect(ruleToTableLine("@@||cdn.example.com^")).toBe("@cdn.example.com");
  });

  test("drops everything a domain table cannot express", () => {
    for (const line of [
      "! comment",
      "[Adblock Plus 2.0]",
      "example.com##.ad",
      "||example.com/ads/",
      "||example.com^$script",
      "||example.com^$third-party,image",
      "||example.com^$domain=a.com",
      "||example.com",
      "||example.*^",
      "|https://example.com^",
      "/banner/*/ad",
      "||com^",
      "@@||example.com^$document",
    ]) {
      expect(ruleToTableLine(line)).toBeUndefined();
    }
  });
});

describe("buildTable", () => {
  test("sorts, deduplicates and lets a plain block rule replace a third-party-only one", () => {
    const table = buildTable(["||b.test^\n||a.test^$third-party", "||a.test^\n||b.test^\n@@||c.test^\n||d.test^$third-party"]);
    expect(table).toBe("@c.test\na.test\nb.test\n~d.test\n");
  });
});

describe("siteOf", () => {
  test("two labels, three under country-code second levels, IPs whole", () => {
    expect(siteOf("example.com")).toBe("example.com");
    expect(siteOf("www.news.example.com")).toBe("example.com");
    expect(siteOf("www.example.co.uk")).toBe("example.co.uk");
    expect(siteOf("a.b.example.com.au")).toBe("example.com.au");
    expect(siteOf("a.b.example.uk")).toBe("example.uk");
    expect(siteOf("localhost")).toBe("localhost");
    expect(siteOf("127.0.0.1")).toBe("127.0.0.1");
    expect(siteOf("[::1]")).toBe("[::1]");
  });
});

describe("AdBlockList", () => {
  const list = AdBlockList.parse("ads.test\n@fine.ads.test\n@ok.test\nok.test\n~pixel.test\ntracker.co.uk\n");

  test("matches the domain and its subdomains, by label", () => {
    expect(list.blocks("ads.test", "site.test")).toBe(true);
    expect(list.blocks("a.b.ads.test", "site.test")).toBe(true);
    expect(list.blocks("tracker.co.uk", "site.test")).toBe(true);
    // Not a substring or a plain string suffix match.
    expect(list.blocks("badads.test", "site.test")).toBe(false);
    expect(list.blocks("ads.test.evil.example", "site.test")).toBe(false);
    expect(list.blocks("test", "site.test")).toBe(false);
    expect(list.blocks("co.uk", "site.test")).toBe(false);
    expect(list.blocks("localhost", "localhost")).toBe(false);
  });

  test("an exception wins over a block rule, at any level", () => {
    expect(list.blocks("fine.ads.test", "site.test")).toBe(false);
    expect(list.blocks("x.fine.ads.test", "site.test")).toBe(false);
    expect(list.blocks("other.ads.test", "site.test")).toBe(true);
    expect(list.blocks("ok.test", "site.test")).toBe(false);
  });

  test("a third-party-only rule applies when the request leaves the page's site", () => {
    expect(list.blocks("pixel.test", "site.test")).toBe(true);
    expect(list.blocks("img.pixel.test", "site.test")).toBe(true);
    expect(list.blocks("pixel.test", "pixel.test")).toBe(false);
    expect(list.blocks("img.pixel.test", "pixel.test")).toBe(false);
  });

  test("an empty list blocks nothing", () => {
    expect(AdBlockList.empty.size).toBe(0);
    expect(AdBlockList.empty.blocks("ads.test", "site.test")).toBe(false);
  });
});
