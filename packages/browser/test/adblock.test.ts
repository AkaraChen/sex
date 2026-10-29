import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AdBlockList, siteOf } from "@searxng-js/sex-browser";
import { buildTable, ruleToTableLine } from "../scripts/adblock.ts";

describe("ruleToTableLine", () => {
  test("keeps domain block rules, third-party-only rules and exceptions", () => {
    assert.equal(ruleToTableLine("||ads.example.com^"), "ads.example.com");
    assert.equal(ruleToTableLine("||Tracker.Example.COM^$third-party"), "~tracker.example.com");
    assert.equal(ruleToTableLine("||tracker.example.com^$3p"), "~tracker.example.com");
    assert.equal(ruleToTableLine("@@||cdn.example.com^"), "@cdn.example.com");
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
      assert.equal(ruleToTableLine(line), undefined);
    }
  });
});

describe("buildTable", () => {
  test("sorts, deduplicates and lets a plain block rule replace a third-party-only one", () => {
    const table = buildTable(["||b.test^\n||a.test^$third-party", "||a.test^\n||b.test^\n@@||c.test^\n||d.test^$third-party"]);
    assert.equal(table, "@c.test\na.test\nb.test\n~d.test\n");
  });
});

describe("siteOf", () => {
  test("two labels, three under country-code second levels, IPs whole", () => {
    assert.equal(siteOf("example.com"), "example.com");
    assert.equal(siteOf("www.news.example.com"), "example.com");
    assert.equal(siteOf("www.example.co.uk"), "example.co.uk");
    assert.equal(siteOf("a.b.example.com.au"), "example.com.au");
    assert.equal(siteOf("a.b.example.uk"), "example.uk");
    assert.equal(siteOf("localhost"), "localhost");
    assert.equal(siteOf("127.0.0.1"), "127.0.0.1");
    assert.equal(siteOf("[::1]"), "[::1]");
  });
});

describe("AdBlockList", () => {
  const list = AdBlockList.parse("ads.test\n@fine.ads.test\n@ok.test\nok.test\n~pixel.test\ntracker.co.uk\n");

  test("matches the domain and its subdomains, by label", () => {
    assert.equal(list.blocks("ads.test", "site.test"), true);
    assert.equal(list.blocks("a.b.ads.test", "site.test"), true);
    assert.equal(list.blocks("tracker.co.uk", "site.test"), true);
    // Not a substring or a plain string suffix match.
    assert.equal(list.blocks("badads.test", "site.test"), false);
    assert.equal(list.blocks("ads.test.evil.example", "site.test"), false);
    assert.equal(list.blocks("test", "site.test"), false);
    assert.equal(list.blocks("co.uk", "site.test"), false);
    assert.equal(list.blocks("localhost", "localhost"), false);
  });

  test("an exception wins over a block rule, at any level", () => {
    assert.equal(list.blocks("fine.ads.test", "site.test"), false);
    assert.equal(list.blocks("x.fine.ads.test", "site.test"), false);
    assert.equal(list.blocks("other.ads.test", "site.test"), true);
    assert.equal(list.blocks("ok.test", "site.test"), false);
  });

  test("a third-party-only rule applies when the request leaves the page's site", () => {
    assert.equal(list.blocks("pixel.test", "site.test"), true);
    assert.equal(list.blocks("img.pixel.test", "site.test"), true);
    assert.equal(list.blocks("pixel.test", "pixel.test"), false);
    assert.equal(list.blocks("img.pixel.test", "pixel.test"), false);
  });

  test("an empty list blocks nothing", () => {
    assert.equal(AdBlockList.empty.size, 0);
    assert.equal(AdBlockList.empty.blocks("ads.test", "site.test"), false);
  });
});
