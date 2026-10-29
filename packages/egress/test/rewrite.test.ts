import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileKindOf, rewriteUrl } from "@searxng-js/sex-egress";

const rewrite = (u: string) => rewriteUrl(new URL(u)).href;

describe("rewriteUrl", () => {
  test("Docs and Slides become PDF exports", () => {
    assert.equal(
      rewrite("https://docs.google.com/document/d/abc_123-X/edit?usp=sharing"),
      "https://docs.google.com/document/d/abc_123-X/export?format=pdf",
    );
    assert.equal(
      rewrite("https://docs.google.com/presentation/d/abc/edit#slide=id.p"),
      "https://docs.google.com/presentation/d/abc/export?format=pdf",
    );
  });

  test("Sheets become CSV exports and keep the sheet id", () => {
    assert.equal(
      rewrite("https://docs.google.com/spreadsheets/d/abc/edit#gid=42"),
      "https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=42",
    );
    assert.equal(
      rewrite("https://docs.google.com/spreadsheets/d/abc/edit"),
      "https://docs.google.com/spreadsheets/d/abc/export?format=csv",
    );
  });

  test("Drive file links become direct downloads", () => {
    assert.equal(rewrite("https://drive.google.com/file/d/abc/view?usp=sharing"), "https://drive.google.com/uc?export=download&id=abc");
    assert.equal(rewrite("https://drive.google.com/open?id=abc"), "https://drive.google.com/uc?export=download&id=abc");
  });

  test("other URLs, including look-alike hosts, are left alone", () => {
    for (const u of [
      "https://example.com/document/d/abc/edit",
      "https://docs.google.com.evil.test/document/d/abc/edit",
      "http://docs.google.com/document/d/abc/edit",
      "https://docs.google.com/forms/d/abc/edit",
      "https://drive.google.com/drive/folders/abc",
    ]) {
      assert.equal(rewrite(u), new URL(u).href);
    }
  });

  test("fileKindOf looks at the path extension only", () => {
    assert.equal(fileKindOf(new URL("https://x.test/a/report.PDF?download=1")), "document");
    assert.equal(fileKindOf(new URL("https://x.test/a.png")), "image");
    assert.equal(fileKindOf(new URL("https://x.test/a.html?f=a.pdf")), undefined);
  });
});
