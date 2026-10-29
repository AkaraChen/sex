// LLM-backed formats against a mock OpenAI-compatible endpoint.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ChatRequest, type Reply, startMockLlm } from "../lib/llm.ts";
import { killAll, type Server } from "../lib/proc.ts";
import { html, type Site, site } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { kindOf, llmFlags, scrape, startSex, userOf } from "./helpers.ts";

const PRICE_SCHEMA = { type: "object", properties: { price: { type: "number" } }, required: ["price"] };
const JSON_FORMAT = { type: "json", schema: PRICE_SCHEMA };

let page: Site;
let big: Site;
let srv: Server;
let bare: Server;
let llm: ReturnType<typeof startMockLlm>;

/** What the mock answers; each test replaces it. `calls` holds the requests of the current test. */
let behave: (req: ChatRequest, nth: number) => Reply = () => "{}";
let calls: ChatRequest[] = [];

/** The numbered lines of a select-lines prompt: [number, text]. */
const numbered = (req: ChatRequest): Array<[number, string]> =>
  [...userOf(req).matchAll(/^(\d+): (.*)$/gm)].map((m) => [Number(m[1]), m[2] as string]);

beforeAll(async () => {
  page = site(() =>
    html(
      "Widget shop",
      `<h1>Widget</h1><p>The Widget costs 42 dollars.</p><p>It is blue and sturdy.</p><p>It comes with a warranty. ${"Filler sentence about widgets. ".repeat(8)}</p>`,
    ),
  );
  big = site(() =>
    html("Big", Array.from({ length: 120 }, (_, i) => `<p>Line ${i} of a very long page with plenty of words in it.</p>`).join("")),
  );
  llm = startMockLlm((req) => {
    calls.push(req);
    return behave(req, calls.length);
  });
  srv = await startSex(llmFlags(llm), { env: { SEX_LLM_MAX_INPUT_CHARS: "1000" } });
  bare = await startSex();
});

afterAll(async () => {
  page.stop();
  big.stop();
  llm.stop();
  await killAll();
  removeTempDirs();
});

beforeEach(() => {
  calls = [];
  behave = () => "{}";
});

describe("formats", () => {
  test("json with a schema sends the schema and returns the model's object", async () => {
    behave = () => JSON.stringify({ price: 42 });
    const r = await scrape(srv, { url: `${page.url}/`, formats: ["markdown", JSON_FORMAT] });
    expect(r.status).toBe(200);
    expect(r.body.data.json).toEqual({ price: 42 });
    expect(r.body.data.markdown).toContain("42 dollars");
    expect(calls).toHaveLength(1);
    const call = calls[0] as ChatRequest;
    expect(kindOf(call)).toBe("extract");
    expect(call.model).toBe("test-model");
    expect(JSON.stringify(call)).toContain('"price"');
    // The page is handed over inside tags, as untrusted content.
    expect(userOf(call)).toContain("<page");
    expect(userOf(call)).toContain("The Widget costs 42 dollars");
  });

  test("json with only a prompt", async () => {
    behave = () => JSON.stringify({ colour: "blue" });
    const r = await scrape(srv, { url: `${page.url}/`, formats: [{ type: "json", prompt: "What colour is the widget?" }] });
    expect(r.status).toBe(200);
    expect(r.body.data.json).toEqual({ colour: "blue" });
    expect(userOf(calls[0] as ChatRequest)).toContain("What colour is the widget?");
  });

  test("summary and question", async () => {
    behave = (req) => (kindOf(req) === "summary" ? "A blue widget for 42 dollars." : "It is blue.");
    const r = await scrape(srv, {
      url: `${page.url}/`,
      formats: [{ type: "summary" }, { type: "question", question: "What colour is it?" }],
    });
    expect(r.status).toBe(200);
    expect(r.body.data.summary).toBe("A blue widget for 42 dollars.");
    expect(r.body.data.answer).toBe("It is blue.");
    const q = calls.find((c) => kindOf(c) === "answer");
    expect(userOf(q as ChatRequest)).toContain("What colour is it?");
  });

  test("highlights are quoted verbatim from the page (the model only picks line numbers)", async () => {
    behave = (req) => {
      const line = numbered(req).find(([, text]) => text.includes("warranty"));
      return JSON.stringify([line?.[0]]);
    };
    const r = await scrape(srv, { url: `${page.url}/`, formats: [{ type: "highlights", query: "warranty terms" }] });
    expect(r.status).toBe(200);
    expect(r.body.data.highlights).toContain("It comes with a warranty.");
    expect(r.body.data.highlights).not.toContain("42 dollars");
  });

  test("a query in directQuote mode returns page text only", async () => {
    behave = (req) => {
      const line = numbered(req).find(([, text]) => text.includes("blue"));
      // An out-of-range number is dropped rather than invented.
      return JSON.stringify([line?.[0], 9999]);
    };
    const r = await scrape(srv, { url: `${page.url}/`, formats: [{ type: "query", prompt: "colour", mode: "directQuote" }] });
    expect(r.status).toBe(200);
    expect(r.body.data.answer).toBe("It is blue and sturdy.");
  });

  test("a schema that is not valid JSON Schema is a 400 before any model call", async () => {
    const r = await scrape(srv, { url: `${page.url}/`, formats: [{ type: "json", schema: { type: "no-such-type" } }] });
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("page content above SEX_LLM_MAX_INPUT_CHARS is cut, with a warning", async () => {
    behave = () => JSON.stringify({ n: 1 });
    const r = await scrape(srv, { url: `${big.url}/`, formats: [{ type: "json", prompt: "anything" }] });
    expect(r.status).toBe(200);
    expect(r.body.data.warning).toBeTruthy();
    const sent = userOf(calls[0] as ChatRequest);
    expect(sent).toContain("Line 0 ");
    expect(sent).not.toContain("Line 119 ");
  });

  test("the LLM formats are 501 LLM_NOT_CONFIGURED without an LLM", async () => {
    for (const format of [JSON_FORMAT, { type: "summary" }, { type: "question", question: "x?" }]) {
      const r = await scrape(bare, { url: `${page.url}/`, formats: [format] });
      expect(r.status).toBe(501);
      expect(r.body.code).toBe("LLM_NOT_CONFIGURED");
    }
    const guard = await scrape(bare, { url: `${page.url}/`, formats: ["markdown"], checkPromptInjection: true });
    expect(guard.status).toBe(501);
    expect(guard.body.code).toBe("LLM_NOT_CONFIGURED");
  });
});

describe("checkPromptInjection", () => {
  test("a flagged page is 403 SCRAPE_PROMPT_INJECTION_DETECTED", async () => {
    behave = () => JSON.stringify({ isInjection: true, reason: "tells the reader to ignore its instructions" });
    const r = await scrape(srv, { url: `${page.url}/`, formats: ["markdown"], checkPromptInjection: true });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("SCRAPE_PROMPT_INJECTION_DETECTED");
    expect(r.body.error).toContain("tells the reader to ignore its instructions");
    expect(r.body.retryable).toBe(false);
    // The guard saw the page text.
    expect(kindOf(calls[0] as ChatRequest)).toBe("guard");
    expect(userOf(calls[0] as ChatRequest)).toContain("The Widget costs 42 dollars");
  });

  test("a clean page is returned normally", async () => {
    behave = () => JSON.stringify({ isInjection: false, reason: "plain product page" });
    const r = await scrape(srv, { url: `${page.url}/`, formats: ["markdown"], checkPromptInjection: true });
    expect(r.status).toBe(200);
    expect(r.body.data.markdown).toContain("42 dollars");
    expect(r.body.data.warning).toBeUndefined();
  });

  test("a guard call that fails lets the page through with a warning", async () => {
    behave = () => ({ status: 500, body: { error: { message: "down" } } });
    const r = await scrape(srv, { url: `${page.url}/`, formats: ["markdown"], checkPromptInjection: true });
    expect(r.status).toBe(200);
    expect(r.body.data.markdown).toContain("42 dollars");
    expect(r.body.data.warning).toContain("prompt injection check");
  });
});

describe("LLM failures", () => {
  test("a rejected request (401) fails the format, not the scrape, and names the settings", async () => {
    behave = () => ({ status: 401, body: { error: { message: "bad key" } } });
    const r = await scrape(srv, { url: `${page.url}/`, formats: ["markdown", JSON_FORMAT, { type: "summary" }] });
    expect(r.status).toBe(200);
    expect(r.body.data.markdown).toContain("42 dollars");
    expect(r.body.data.json).toBeNull();
    expect(r.body.data.summary).toBeUndefined();
    expect(r.body.data.warning).toContain("JSON extraction failed");
    expect(r.body.data.warning).toContain("401");
    expect(r.body.data.warning).toContain("SEX_LLM_API_KEY");
  });

  test("a 429 with retry-after is retried after the wait", async () => {
    behave = (_req, nth) =>
      nth === 1
        ? { status: 429, headers: { "retry-after": "1" }, body: { error: { message: "slow down" } } }
        : JSON.stringify({ price: 7 });
    const t = Date.now();
    const r = await scrape(srv, { url: `${page.url}/`, formats: [JSON_FORMAT] });
    expect(r.status).toBe(200);
    expect(r.body.data.json).toEqual({ price: 7 });
    expect(calls).toHaveLength(2);
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
  });

  test("a 429 that never ends is retried twice, then the format fails", async () => {
    behave = () => ({ status: 429, headers: { "retry-after": "0" }, body: { error: { message: "slow down" } } });
    const r = await scrape(srv, { url: `${page.url}/`, formats: ["markdown", JSON_FORMAT] });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(r.body.data.json).toBeNull();
    expect(r.body.data.warning).toContain("rate limit");
    expect(r.body.data.markdown).toContain("42 dollars");
  });

  test("a reply that is not JSON gets one correction turn", async () => {
    behave = (_req, nth) => (nth === 1 ? "Sure! here is { the data" : JSON.stringify({ price: 3 }));
    const r = await scrape(srv, { url: `${page.url}/`, formats: [JSON_FORMAT] });
    expect(r.status).toBe(200);
    expect(r.body.data.json).toEqual({ price: 3 });
    expect(calls).toHaveLength(2);
    // The second request carries the bad reply and the complaint.
    expect((calls[1] as ChatRequest).messages.length).toBeGreaterThan((calls[0] as ChatRequest).messages.length);
    expect(JSON.stringify(calls[1])).toContain("Sure! here is { the data");
  });

  test("JSON that breaks the schema gets a correction turn too, and a second failure ends the format", async () => {
    behave = (_req, nth) => (nth === 1 ? JSON.stringify({ price: "cheap" }) : JSON.stringify({ price: 5 }));
    const fixed = await scrape(srv, { url: `${page.url}/`, formats: [JSON_FORMAT] });
    expect(fixed.body.data.json).toEqual({ price: 5 });
    expect(calls).toHaveLength(2);

    calls = [];
    behave = () => JSON.stringify({ price: "still cheap" });
    const failed = await scrape(srv, { url: `${page.url}/`, formats: ["markdown", JSON_FORMAT] });
    expect(failed.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(failed.body.data.json).toBeNull();
    expect(failed.body.data.warning).toContain("JSON extraction failed");
    expect(failed.body.data.markdown).toContain("42 dollars");
  });

  test("a reply slower than timeout is 408 SCRAPE_TIMEOUT", async () => {
    behave = () => ({ delayMs: 6000, content: JSON.stringify({ price: 1 }) });
    const t = Date.now();
    const r = await scrape(srv, { url: `${page.url}/`, formats: [JSON_FORMAT], timeout: 1500 });
    expect(r.status).toBe(408);
    expect(r.body.code).toBe("SCRAPE_TIMEOUT");
    expect(r.body.retryable).toBe(true);
    expect(Date.now() - t).toBeLessThan(5500);
  });

  test("an upstream 500 fails only that format", async () => {
    behave = () => ({ status: 500, body: { error: { message: "boom" } } });
    const r = await scrape(srv, { url: `${page.url}/`, formats: ["markdown", { type: "summary" }] });
    expect(r.status).toBe(200);
    expect(r.body.data.markdown).toContain("42 dollars");
    expect(r.body.data.summary).toBeUndefined();
    expect(r.body.data.warning).toContain("500");
  });
});
