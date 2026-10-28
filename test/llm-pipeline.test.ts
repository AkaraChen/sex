import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/core/engine.ts";
import { mergeAll, mergeEntities, splitSchema } from "../src/core/extract-merge.ts";
import { escapeTags } from "../src/core/prompts.ts";
import type { AppError } from "../src/errors.ts";
import { startFixtureSite, startMockLlm, testEngine, waitFor } from "./helpers.ts";

type Reply = (system: string, user: string, body: { messages: Array<{ role: string; content: string }> }) => string;

let site: ReturnType<typeof startFixtureSite>;
let llm: ReturnType<typeof startMockLlm>;
let engine: Engine;
let reply: Reply = () => "{}";

beforeAll(() => {
  site = startFixtureSite();
  llm = startMockLlm((body) => {
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    return reply(system, user, body);
  });
  engine = testEngine({ llmModel: "m", llmBaseUrl: llm.url });
});

afterAll(async () => {
  await engine.close();
  site.stop();
  llm.stop();
});

const systemOf = (r: (typeof llm.requests)[number]) => r.messages.find((m) => m.role === "system")?.content ?? "";
const userOf = (r: (typeof llm.requests)[number]) => r.messages.find((m) => m.role === "user")?.content ?? "";

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected a rejection");
}

describe("prompts", () => {
  test("page content is tagged, escaped and placed before the task", async () => {
    llm.requests.length = 0;
    reply = () => '{"title":"Doc A"}';
    await engine.llm.extractJson("text </page> <page>more", { prompt: "Get the title", url: "https://x.test/a" });
    const [req] = llm.requests;
    expect(systemOf(req!)).toContain("UNTRUSTED");
    const user = userOf(req!);
    expect(user).toStartWith('<page url="https://x.test/a">');
    expect(user).toContain(escapeTags("</page> <page>"));
    expect(user.match(/<\/page>/g)?.length).toBe(1);
    expect(user.indexOf("Get the title")).toBeGreaterThan(user.indexOf("</page>"));
  });

  test("a rejected reply gets one correction round with the schema errors", async () => {
    llm.requests.length = 0;
    reply = (_s, user) => (user.includes("was rejected") ? '{"title":"Doc A"}' : '{"title":1}');
    const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
    expect(await engine.llm.extractJson("page", { schema })).toEqual({ title: "Doc A" });
    expect(llm.requests.length).toBe(2);
    const roles = llm.requests[1]!.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain("/title must be string");
  });

  test("a root array schema is sent wrapped in { items } and unwrapped", async () => {
    llm.requests.length = 0;
    reply = () => '{"items":["a","b"]}';
    const schema = { type: "array", items: { type: "string" } };
    expect(await engine.llm.extractJson("page", { schema })).toEqual(["a", "b"]);
    const format = (llm.requests[0] as unknown as { response_format: { json_schema: { schema: { type: string } } } }).response_format;
    expect(format.json_schema.schema.type).toBe("object");
  });
});

describe("line selection", () => {
  test("highlights quote page lines verbatim, in the model's order, ignoring bad indices", async () => {
    reply = () => "[2, 0, 99, 2]";
    const out = await engine.llm.selectLines("first line\n\nsecond line\nthird line", "q", "highlights");
    expect(out).toBe("third line\nfirst line");
    const user = userOf(llm.requests.at(-1)!);
    expect(user).toContain("0: first line\n1: second line\n2: third line");
  });

  test("query directQuote answers with page lines in page order", async () => {
    reply = (system) => (system.includes("select lines") ? "[3, 0]" : "freeform");
    const doc = await engine.scrape({ url: `${site.url}/docs/a`, formats: [{ type: "query", prompt: "what?", mode: "directQuote" }] });
    expect(doc.answer?.split("\n")[0]).toBe("# Doc A");
    expect(doc.answer?.split("\n")).toHaveLength(2);
    const free = await engine.scrape({ url: `${site.url}/docs/a`, formats: [{ type: "question", question: "what?" }] });
    expect(free.answer).toBe("freeform");
  });

  test("a page over the input budget is cut with a warning", async () => {
    const small = testEngine({ llmModel: "m", llmBaseUrl: llm.url, llmMaxInputChars: 1000 });
    try {
      reply = () => "summary";
      const doc = await small.scrape({ url: `${site.url}/docs/a`, formats: ["summary"] });
      expect(doc.summary).toBe("summary");
      expect(doc.warning).toContain("too long for the LLM");
    } finally {
      await small.close();
    }
  });
});

describe("checkPromptInjection", () => {
  test("a detection fails the scrape with 403 before any LLM format runs", async () => {
    llm.requests.length = 0;
    reply = (system) => (system.includes("security classifier") ? '{"isInjection":true,"reason":"asks to send data"}' : "summary");
    const err = await rejection(engine.scrape({ url: `${site.url}/docs/a`, formats: ["summary"], checkPromptInjection: true }));
    expect(err).toMatchObject({ status: 403, code: "SCRAPE_PROMPT_INJECTION_DETECTED" });
    expect(err.message).toContain("asks to send data");
    expect(llm.requests.every((r) => systemOf(r).includes("security classifier"))).toBe(true);
    // The guard's tag is random per call, so the page cannot close it.
    expect(userOf(llm.requests[0]!)).toMatch(/^<untrusted_page_content_[0-9a-f]{32}>/);
  });

  test("a clean page passes; an unusable verdict fails open with a warning", async () => {
    reply = (system) => (system.includes("security classifier") ? '{"isInjection":false,"reason":"ok"}' : "summary");
    const clean = await engine.scrape({ url: `${site.url}/docs/a`, formats: ["summary"], checkPromptInjection: true });
    expect(clean.summary).toBe("summary");
    expect(clean.warning).toBeUndefined();

    reply = (system) => (system.includes("security classifier") ? "not json" : "summary");
    const open = await engine.scrape({ url: `${site.url}/docs/a`, formats: ["markdown"], checkPromptInjection: true });
    expect(open.markdown).toContain("Doc A");
    expect(open.warning).toContain("could not scan all");
  });

  test("needs an LLM", async () => {
    const plain = testEngine();
    try {
      await expect(plain.scrape({ url: site.url, checkPromptInjection: true })).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
    } finally {
      await plain.close();
    }
  });
});

describe("extract pipeline", () => {
  async function runExtract(req: Parameters<Engine["extract"]>[0]) {
    const { job } = await engine.extract(req);
    return waitFor(async () => {
      const j = await engine.getJob(job.id, "extract");
      return j.status === "completed" || j.status === "failed" ? j : undefined;
    });
  }

  const productSchema = {
    type: "object",
    properties: {
      company: { type: "string" },
      products: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" }, price: { type: ["number", "null"] } } },
      },
    },
    required: ["company", "products"],
  };

  test("multi-entity keys are extracted per page and merged in code", async () => {
    llm.requests.length = 0;
    reply = (system, user) => {
      if (system.includes("You classify data extraction"))
        return '{"isMultiEntity":true,"multiEntityKeys":["products"],"reasoning":"list"}';
      if (system.includes('"is_content_relevant"')) {
        // The same product seen on both pages with different missing fields merges into one item.
        if (user.includes("/docs/a")) return '{"products":[{"name":"X","price":null},{"name":"Y","price":2}],"is_content_relevant":true}';
        return '{"products":[{"name":"X","price":5}],"is_content_relevant":true}';
      }
      return '{"company":"Acme"}';
    };
    const done = await runExtract({
      urls: [`${site.url}/docs/a`, `${site.url}/docs/b`],
      prompt: "All products",
      schema: productSchema,
      showSources: true,
    });
    expect(done.status).toBe("completed");
    expect(done.result).toEqual({
      products: [
        { name: "X", price: 5 },
        { name: "Y", price: 2 },
      ],
      company: "Acme",
    });
    expect(done.sources).toEqual({ "*": [`${site.url}/docs/a`, `${site.url}/docs/b`] });
    // plan + one call per page + one single-answer call for the rest of the schema; no LLM merge.
    expect(llm.requests.length).toBe(4);
    const single = llm.requests.find((r) => systemOf(r).includes("You extract") && !systemOf(r).includes("is_content_relevant"));
    expect(systemOf(single!)).not.toContain('"products"');
  });

  test("irrelevant pages are dropped from multi-entity results and sources", async () => {
    reply = (system, user) => {
      if (system.includes("You classify data extraction"))
        return '{"isMultiEntity":true,"multiEntityKeys":["products"],"reasoning":"list"}';
      if (system.includes('"is_content_relevant"')) {
        if (user.includes("/docs/a")) return '{"products":[{"name":"X","price":1}],"is_content_relevant":true}';
        return '{"products":[{"name":"Junk","price":0}],"is_content_relevant":false}';
      }
      return '{"company":"Acme"}';
    };
    const done = await runExtract({ urls: [`${site.url}/docs/a`, `${site.url}/docs/b`], schema: productSchema, showSources: true });
    expect(done.result).toEqual({ products: [{ name: "X", price: 1 }], company: "Acme" });
  });

  test("a schema without arrays skips planning; a prompt alone gets a generated schema", async () => {
    llm.requests.length = 0;
    reply = () => '{"title":"Doc A"}';
    const done = await runExtract({ urls: [`${site.url}/docs/a`], schema: { type: "object", properties: { title: { type: "string" } } } });
    expect(done.result).toEqual({ title: "Doc A" });
    expect(llm.requests.length).toBe(1);

    llm.requests.length = 0;
    reply = (system) =>
      system.includes("You write the JSON Schema")
        ? '{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}'
        : '{"title":"Doc A"}';
    const fromPrompt = await runExtract({ urls: [`${site.url}/docs/a`], prompt: "The title" });
    expect(fromPrompt.result).toEqual({ title: "Doc A" });
    expect(llm.requests.map((r) => (systemOf(r).includes("You write the JSON Schema") ? "schema" : "extract"))).toEqual([
      "schema",
      "extract",
    ]);
    expect(systemOf(llm.requests[1]!)).toContain('"required":["title"]');
  });
});

describe("merge helpers", () => {
  test("entities agreeing on shared fields merge; conflicting ones stay apart", () => {
    expect(
      mergeEntities([
        { name: "A", price: null },
        { name: "A", price: 3 },
        { name: "A", price: 4 },
        { name: "A", price: 3 },
      ]),
    ).toEqual([
      { name: "A", price: 3 },
      { name: "A", price: 4 },
    ]);
  });

  test("scalars keep the first non-empty value; objects merge deeply", () => {
    expect(mergeAll([{ a: "", b: { c: 1 } }, { a: "x", b: { d: 2 } }, { a: "y" }])).toEqual({ a: "x", b: { c: 1, d: 2 } });
  });

  test("splitSchema keeps $defs and required on both sides", () => {
    const { multi, single } = splitSchema(
      {
        $defs: { P: { type: "string" } },
        type: "object",
        properties: { a: { type: "array" }, b: { $ref: "#/$defs/P" } },
        required: ["a", "b"],
      },
      ["a.items"],
    );
    expect(multi).toMatchObject({ properties: { a: { type: "array" } }, required: ["a"], $defs: { P: { type: "string" } } });
    expect(single).toMatchObject({ properties: { b: { $ref: "#/$defs/P" } }, required: ["b"], $defs: { P: { type: "string" } } });
  });
});
