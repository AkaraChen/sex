import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deadline } from "../src/deadline.ts";
import { SqliteChangeTracker } from "../src/engine/change-tracker.ts";
import type { Engine } from "../src/engine/engine.ts";
import { startMockLlm, testEngine } from "./helpers.ts";

const html = (body: string) =>
  `<html><head><title>Prices</title></head><body><main><h1>Prices</h1>${"<p>Some filler text so the page has content to extract.</p>".repeat(6)}${body}</main></body></html>`;

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
/** What the fixture serves at /p; tests change it between scrapes. */
let content = "<p>The plan costs 10 dollars.</p>";
let status = 200;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sex-track-"));
  server = Bun.serve({
    port: 0,
    fetch: () => new Response(html(content), { status, headers: { "content-type": "text/html" } }),
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const track = (engine: Engine, url: string, format: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  engine.scrape({ url, formats: ["markdown", { type: "changeTracking", ...format }], ...extra });

describe("changeTracking", () => {
  test("new, then same, then changed with a git diff", async () => {
    content = "<p>The plan costs 10 dollars.</p>";
    status = 200;
    const engine = testEngine({ dataDir: join(dir, "a") });
    try {
      const url = `${base}/p?a`;
      const first = await track(engine, url, { modes: ["git-diff"] });
      expect(first.changeTracking).toEqual({ previousScrapeAt: null, changeStatus: "new", visibility: "visible" });

      const second = await track(engine, url, { modes: ["git-diff"] });
      expect(second.changeTracking?.changeStatus).toBe("same");
      expect(second.changeTracking?.previousScrapeAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(second.changeTracking?.diff).toBeUndefined();

      content = "<p>The plan costs 12 dollars.</p>";
      const third = await track(engine, url, { modes: ["git-diff"] });
      const ct = third.changeTracking;
      expect(ct?.changeStatus).toBe("changed");
      expect(ct?.diff?.text).toContain("-The plan costs 10 dollars.");
      expect(ct?.diff?.text).toContain("+The plan costs 12 dollars.");
      type DiffJson = { files: Array<{ from: string; to: string; chunks: Array<{ changes: Array<Record<string, unknown>> }> }> };
      const diffJson = ct?.diff?.json as DiffJson;
      const files = diffJson.files;
      expect(files[0]).toMatchObject({ from: "previous.md", to: "current.md" });
      const changes = files[0]?.chunks.flatMap((c) => c.changes) ?? [];
      expect(changes.find((c) => c.type === "del")).toMatchObject({ del: true, content: "-The plan costs 10 dollars." });
      expect(changes.find((c) => c.type === "add")).toMatchObject({ add: true, content: "+The plan costs 12 dollars." });
      expect(changes.find((c) => c.type === "normal")).toMatchObject({ normal: true });

      // The new version replaced the old one.
      expect((await track(engine, url)).changeTracking?.changeStatus).toBe("same");
    } finally {
      await engine.close();
    }
  });

  test("whitespace does not make a change, moved text and a same-length edit do; no modes means no diff", async () => {
    content = "<p>Alpha beta.</p><p>Gamma delta.</p>";
    const engine = testEngine({ dataDir: join(dir, "b") });
    try {
      const url = `${base}/p?b`;
      await track(engine, url);
      content = "<p>Alpha   beta.</p>\n\n<p>Gamma\n delta.</p>";
      expect((await track(engine, url)).changeTracking?.changeStatus).toBe("same");
      // Same characters, other order.
      content = "<p>Gamma delta.</p><p>Alpha beta.</p>";
      const moved = await track(engine, url);
      expect(moved.changeTracking?.changeStatus).toBe("changed");
      expect(moved.changeTracking).not.toHaveProperty("diff");
      // Same length and same character counts per word set, one letter different.
      content = "<p>Gamma delta.</p><p>Alpha betb.</p>";
      expect((await track(engine, url)).changeTracking?.changeStatus).toBe("changed");
    } finally {
      await engine.close();
    }
  });

  test("a tag keeps its own previous scrape, an empty tag is no tag", async () => {
    content = "<p>Version one.</p>";
    const engine = testEngine({ dataDir: join(dir, "c") });
    try {
      const url = `${base}/p?c`;
      expect((await track(engine, url, { tag: "daily" })).changeTracking?.changeStatus).toBe("new");
      expect((await track(engine, url, { tag: "weekly" })).changeTracking?.changeStatus).toBe("new");
      expect((await track(engine, url)).changeTracking?.changeStatus).toBe("new");
      content = "<p>Version two.</p>";
      expect((await track(engine, url, { tag: "daily" })).changeTracking?.changeStatus).toBe("changed");
      // "weekly" still holds version one; "" is the untagged one, which has seen version one too.
      expect((await track(engine, url, { tag: "weekly" })).changeTracking?.changeStatus).toBe("changed");
      expect((await track(engine, url, { tag: "" })).changeTracking?.changeStatus).toBe("changed");
      expect((await track(engine, url, { tag: "daily" })).changeTracking?.changeStatus).toBe("same");
      expect((await track(engine, `${url}2`, { tag: "daily" })).changeTracking?.changeStatus).toBe("new");
    } finally {
      await engine.close();
    }
  });

  test("a 404 is removed and does not replace the stored version; a 404 on the first scrape is removed without one", async () => {
    content = "<p>Still here.</p>";
    status = 200;
    const engine = testEngine({ dataDir: join(dir, "d") });
    try {
      const url = `${base}/p?d`;
      await track(engine, url);
      status = 404;
      const gone = await track(engine, url);
      expect(gone.changeTracking?.changeStatus).toBe("removed");
      expect(gone.changeTracking?.previousScrapeAt).not.toBeNull();
      expect((await track(engine, `${url}2`)).changeTracking).toMatchObject({ changeStatus: "removed", previousScrapeAt: null });
      status = 200;
      expect((await track(engine, url)).changeTracking?.changeStatus).toBe("same");
    } finally {
      status = 200;
      await engine.close();
    }
  });

  test("the previous scrape survives a restart", async () => {
    content = "<p>Persisted.</p>";
    const url = `${base}/p?e`;
    const first = testEngine({ dataDir: join(dir, "e") });
    await track(first, url);
    await first.close();
    const second = testEngine({ dataDir: join(dir, "e") });
    try {
      expect((await track(second, url)).changeTracking?.changeStatus).toBe("same");
    } finally {
      await second.close();
    }
  });

  test("it needs the markdown format and a data dir", async () => {
    const engine = testEngine();
    try {
      expect(engine.changeTracker).toBeUndefined();
      expect(engine.scrape({ url: `${base}/p`, formats: ["markdown", "changeTracking"] })).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
        message: expect.stringContaining("SEX_DATA_DIR"),
      });
    } finally {
      await engine.close();
    }
    const withDir = testEngine({ dataDir: join(dir, "f") });
    try {
      expect(withDir.scrape({ url: `${base}/p`, formats: ["changeTracking"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(withDir.scrape({ url: `${base}/p`, formats: ["markdown", "changeTracking"] })).resolves.toBeDefined();
    } finally {
      await withDir.close();
    }
  });

  test("a store that cannot be read is a warning, not a failed scrape", async () => {
    content = "<p>Unreadable.</p>";
    const engine = testEngine({ dataDir: join(dir, "g") });
    try {
      const broken = {
        get: () => Promise.reject(new Error("disk")),
        put: () => Promise.reject(new Error("disk")),
        diff: () => undefined,
        close: () => {},
      };
      Object.assign(engine, { changeTracker: broken });
      const doc = await track(engine, `${base}/p?g`);
      expect(doc.changeTracking).toBeUndefined();
      expect(doc.warning).toContain("Comparing failed");
      expect(doc.markdown).toContain("Unreadable.");
    } finally {
      await engine.close();
    }
  });
});

describe("changeTracking json mode", () => {
  let llm: ReturnType<typeof startMockLlm>;
  let reply: (system: string, user: string) => string;
  const userOf = (r: (typeof llm.requests)[number]) => r.messages.find((m) => m.role === "user")?.content ?? "";
  const systemOf = (r: (typeof llm.requests)[number]) => r.messages.find((m) => m.role === "system")?.content ?? "";
  beforeAll(() => {
    llm = startMockLlm((body) => reply(systemOf(body), userOf(body)));
  });
  afterAll(() => llm.stop());

  test("without a schema the LLM describes the changes; unchanged pages cost no call", async () => {
    content = "<p>Price: 10.</p>";
    reply = () => '{"price":{"from":"10","to":"12"}}';
    const engine = testEngine({ dataDir: join(dir, "h"), llmModel: "m", llmBaseUrl: llm.url });
    try {
      const url = `${base}/p?h`;
      const format = { modes: ["json"], prompt: "What happened to the price?" };
      await track(engine, url, format);
      await track(engine, url, format);
      expect(llm.requests).toHaveLength(0);
      content = "<p>Price: 12.</p>";
      const doc = await track(engine, url, format);
      expect(doc.changeTracking?.json).toEqual({ price: { from: "10", to: "12" } });
      expect(llm.requests).toHaveLength(1);
      const user = userOf(llm.requests[0] as never);
      expect(user).toContain("Price: 10.");
      expect(user).toContain("Price: 12.");
      expect(user).toContain("What happened to the price?");
    } finally {
      await engine.close();
    }
  });

  test("with a schema both versions are extracted and compared field by field", async () => {
    content = "<p>Price: 10. Stock: 5.</p>";
    llm.requests.length = 0;
    reply = (_s, user) => (user.includes("Price: 10") ? '{"price":10,"stock":5}' : '{"price":12,"stock":5}');
    const engine = testEngine({ dataDir: join(dir, "i"), llmModel: "m", llmBaseUrl: llm.url });
    try {
      const url = `${base}/p?i`;
      const schema = { type: "object", properties: { price: { type: "number" }, stock: { type: "number" } } };
      await track(engine, url, { modes: ["json"], schema });
      content = "<p>Price: 12. Stock: 5.</p>";
      const doc = await track(engine, url, { modes: ["json"], schema });
      expect(doc.changeTracking?.json).toEqual({ price: { previous: 10, current: 12 } });
      expect(llm.requests).toHaveLength(2);
    } finally {
      await engine.close();
    }
  });

  test("a failing LLM costs the json, not the scrape or the stored version", async () => {
    content = "<p>Fails: one.</p>";
    const engine = testEngine({ dataDir: join(dir, "j"), llmModel: "m", llmBaseUrl: llm.url });
    try {
      const url = `${base}/p?j`;
      await track(engine, url, { modes: ["json"] });
      content = "<p>Fails: two.</p>";
      reply = () => "not json at all";
      const doc = await track(engine, url, { modes: ["json"] });
      expect(doc.changeTracking?.changeStatus).toBe("changed");
      expect(doc.changeTracking?.json).toBeUndefined();
      expect(doc.warning).toContain("Structured diff generation failed");
      expect((await track(engine, url)).changeTracking?.changeStatus).toBe("same");
    } finally {
      await engine.close();
    }
  });

  test("without an LLM the json mode is a 501, the git-diff mode is not", async () => {
    const engine = testEngine({ dataDir: join(dir, "k") });
    try {
      expect(track(engine, `${base}/p?k`, { modes: ["json"] })).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
      expect(track(engine, `${base}/p?k`, { modes: ["git-diff"] })).resolves.toBeDefined();
    } finally {
      await engine.close();
    }
  });
});

describe("SqliteChangeTracker", () => {
  test("keeps one row per (url, tag), replaced by put, and never expires it", async () => {
    const tracker = new SqliteChangeTracker(join(dir, "tracker.sqlite"));
    await tracker.put("https://a.test/", null, "one", 1);
    await tracker.put("https://a.test/", "t", "tagged", 2);
    await tracker.put("https://a.test/", null, "two ".repeat(1000), 1_000);
    expect(await tracker.get("https://a.test/", null)).toEqual({ markdown: "two ".repeat(1000), scrapedAt: 1_000 });
    expect(await tracker.get("https://a.test/", "t")).toEqual({ markdown: "tagged", scrapedAt: 2 });
    expect(await tracker.get("https://a.test/", "other")).toBeUndefined();
    tracker.close();
    const reopened = new SqliteChangeTracker(join(dir, "tracker.sqlite"));
    expect((await reopened.get("https://a.test/", "t"))?.markdown).toBe("tagged");
    reopened.close();
  });

  test("diff gives up on a deadline that has run out instead of blocking", () => {
    const tracker = new SqliteChangeTracker(":memory:");
    const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i} ${Math.random()}`).join("\n");
    const started = Date.now();
    const diff = tracker.diff(lines(20_000, "a"), lines(20_000, "b"), Deadline.start(50));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(diff).toBeUndefined();
    tracker.close();
  });
});
