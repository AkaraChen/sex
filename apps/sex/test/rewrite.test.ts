import { afterAll, describe, expect, test } from "bun:test";
import { fileKindOf, rewriteUrl } from "@sex/core/rewrite.ts";
import { testEngine } from "./helpers.ts";

const rewrite = (u: string) => rewriteUrl(new URL(u)).href;

describe("rewriteUrl", () => {
  test("Docs and Slides become PDF exports", () => {
    expect(rewrite("https://docs.google.com/document/d/abc_123-X/edit?usp=sharing")).toBe(
      "https://docs.google.com/document/d/abc_123-X/export?format=pdf",
    );
    expect(rewrite("https://docs.google.com/presentation/d/abc/edit#slide=id.p")).toBe(
      "https://docs.google.com/presentation/d/abc/export?format=pdf",
    );
  });

  test("Sheets become CSV exports and keep the sheet id", () => {
    expect(rewrite("https://docs.google.com/spreadsheets/d/abc/edit#gid=42")).toBe(
      "https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=42",
    );
    expect(rewrite("https://docs.google.com/spreadsheets/d/abc/edit")).toBe("https://docs.google.com/spreadsheets/d/abc/export?format=csv");
  });

  test("Drive file links become direct downloads", () => {
    expect(rewrite("https://drive.google.com/file/d/abc/view?usp=sharing")).toBe("https://drive.google.com/uc?export=download&id=abc");
    expect(rewrite("https://drive.google.com/open?id=abc")).toBe("https://drive.google.com/uc?export=download&id=abc");
  });

  test("other URLs, including look-alike hosts, are left alone", () => {
    for (const u of [
      "https://example.com/document/d/abc/edit",
      "https://docs.google.com.evil.test/document/d/abc/edit",
      "http://docs.google.com/document/d/abc/edit",
      "https://docs.google.com/forms/d/abc/edit",
      "https://drive.google.com/drive/folders/abc",
    ]) {
      expect(rewrite(u)).toBe(new URL(u).href);
    }
  });

  test("fileKindOf looks at the path extension only", () => {
    expect(fileKindOf(new URL("https://x.test/a/report.PDF?download=1"))).toBe("document");
    expect(fileKindOf(new URL("https://x.test/a.png"))).toBe("image");
    expect(fileKindOf(new URL("https://x.test/a.html?f=a.pdf"))).toBeUndefined();
  });
});

describe("browser is skipped for files", () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("plain text body", { headers: { "content-type": "text/plain" } }),
  });
  // The CDP endpoint is dead: any attempt to use the browser fails.
  const engine = testEngine({ cdpUrl: "ws://127.0.0.1:1/" });
  afterAll(async () => {
    await engine.close();
    server.stop(true);
  });

  test("a .pdf URL is fetched over HTTP without touching the browser", async () => {
    const doc = await engine.scrape({ url: `http://127.0.0.1:${server.port}/file.pdf`, formats: ["markdown"] });
    expect(doc.markdown).toContain("plain text body");
  });

  test("an HTML URL still needs the browser", async () => {
    await expect(engine.scrape({ url: `http://127.0.0.1:${server.port}/page`, formats: ["markdown"] })).rejects.toBeDefined();
  });
});
