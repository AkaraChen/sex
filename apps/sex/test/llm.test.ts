import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AppError } from "@searxng-js/sex-errors";
import { Deadline } from "@sex/core/deadline.ts";
import { resolveConfig } from "../src/config.ts";
import type { Engine } from "../src/engine/engine.ts";
import { Llm } from "../src/engine/llm.ts";
import { chatCompletionStream, startFixtureSite, testEngine } from "./helpers.ts";

const NO_LIMIT = Deadline.unbounded();

type Handler = (req: Request, attempt: number) => Response | Promise<Response>;

/** A /chat/completions endpoint driven by `handler`; counts requests and records their bodies. */
function startLlm(handler: Handler) {
  const bodies: Array<{ response_format?: { type: string } }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      bodies.push((await req.clone().json()) as (typeof bodies)[number]);
      return handler(req, bodies.length);
    },
  });
  const url = `http://127.0.0.1:${server.port}/v1`;
  return { url, bodies, stop: () => server.stop(true) };
}

/** The AppError a promise rejects with. */
async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    return err as AppError;
  }
  throw new Error("expected a rejection");
}

function llmFor(url: string, llmTimeout = 10_000) {
  return new Llm(resolveConfig({ llmModel: "m", llmBaseUrl: url, llmTimeout }, { allowPrivateNetwork: true }, {}));
}

const servers: Array<{ stop: () => void }> = [];
function serve(handler: Handler) {
  const s = startLlm(handler);
  servers.push(s);
  return s;
}

let site: ReturnType<typeof startFixtureSite>;
beforeAll(() => {
  site = startFixtureSite();
});
afterAll(() => {
  site.stop();
  for (const s of servers) s.stop();
});

describe("result status (#5)", () => {
  test("output truncated at the token limit", async () => {
    const s = serve(() => chatCompletionStream('{"title": "Doc', { finishReason: "length" }));
    const err = await rejection(llmFor(s.url).extractJson("page", { schema: { type: "object" } }, NO_LIMIT));
    expect(err).toMatchObject({ status: 422, code: "LLM_INCOMPLETE_OUTPUT", details: { status: "incomplete", reason: "length" } });
    expect(err.message).toContain("token limit");
  });

  test("output stopped by the content filter", async () => {
    const s = serve(() => chatCompletionStream("partial", { finishReason: "content_filter" }));
    await expect(llmFor(s.url).summarize("page", NO_LIMIT)).rejects.toMatchObject({
      code: "LLM_INCOMPLETE_OUTPUT",
      details: { status: "incomplete", reason: "content-filter" },
    });
  });

  test("refusal keeps the refusal text", async () => {
    const s = serve(() => chatCompletionStream("", { refusal: "I can't help with that." }));
    const err = await rejection(llmFor(s.url).answer("page", "q", NO_LIMIT));
    expect(err).toMatchObject({ status: 422, code: "LLM_REFUSED" });
    expect(err.message).toContain("I can't help with that.");
  });
});

describe("errors (#6)", () => {
  test.each([400, 401, 403, 404])("a %i from the endpoint is a configuration error, not a 502", async (status) => {
    const s = serve(() => new Response("bad key", { status, headers: { "x-request-id": "req_1" } }));
    const err = await rejection(llmFor(s.url).summarize("page", NO_LIMIT));
    expect(err).toMatchObject({ status: 500, code: "LLM_REQUEST_REJECTED", retryable: false, details: { status, requestId: "req_1" } });
    expect(err.message).toContain("req_1");
    expect(err.message).toContain("SEX_LLM_API_KEY");
  });

  test("an upstream 5xx stays LLM_ERROR (502)", async () => {
    const s = serve(() => new Response("boom", { status: 500, headers: { "x-request-id": "req_3" } }));
    const err = await rejection(llmFor(s.url).summarize("page", NO_LIMIT));
    expect(err).toMatchObject({ status: 502, code: "LLM_ERROR", retryable: true, details: { status: 500, requestId: "req_3" } });
  });

  test("an unreachable endpoint is LLM_UNAVAILABLE", async () => {
    const s = serve(() => new Response());
    s.stop();
    await expect(llmFor(s.url).summarize("page", NO_LIMIT)).rejects.toMatchObject({
      code: "LLM_UNAVAILABLE",
      details: { code: "network-error" },
    });
  });
});

describe("rate limits (#7)", () => {
  test("waits out retry-after, then succeeds", async () => {
    const s = serve((_req, n) =>
      n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : chatCompletionStream("ok"),
    );
    expect(await llmFor(s.url).summarize("page", NO_LIMIT)).toBe("ok");
    expect(s.bodies.length).toBe(2);
  });

  test("honours retry-after-ms and 503 with retry-after", async () => {
    const s = serve((_req, n) =>
      n === 1
        ? new Response("busy", { status: 503, headers: { "retry-after-ms": "50" } })
        : n === 2
          ? new Response("busy", { status: 429, headers: { "retry-after": new Date(Date.now()).toUTCString() } })
          : chatCompletionStream("ok"),
    );
    expect(await llmFor(s.url).summarize("page", NO_LIMIT)).toBe("ok");
    expect(s.bodies.length).toBe(3);
  });

  test("gives up after the retry budget with LLM_RATE_LIMITED", async () => {
    const s = serve(() => new Response("slow down", { status: 429, headers: { "retry-after": "0", "request-id": "req_2" } }));
    await expect(llmFor(s.url).summarize("page", NO_LIMIT)).rejects.toMatchObject({
      status: 429,
      code: "LLM_RATE_LIMITED",
      details: { status: 429, requestId: "req_2", retryAfterMs: 0 },
    });
    expect(s.bodies.length).toBe(3);
  });

  test("does not wait past the deadline", async () => {
    const s = serve(() => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    const started = Date.now();
    await expect(llmFor(s.url, 2000).summarize("page", NO_LIMIT)).rejects.toMatchObject({
      code: "LLM_RATE_LIMITED",
      details: { retryAfterMs: 30_000 },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(s.bodies.length).toBe(1);
  });

  test("a wait is cut short by the caller's signal", async () => {
    const s = serve(() => new Response("slow down", { status: 429, headers: { "retry-after": "5" } }));
    const started = Date.now();
    await expect(llmFor(s.url).summarize("page", Deadline.unbounded(AbortSignal.timeout(100)))).rejects.toMatchObject({
      status: 408,
      code: "TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a call never outlasts the deadline it is cut from, and that is SCRAPE_TIMEOUT, not the call's own TIMEOUT", async () => {
    const s = serve(() => new Promise<Response>(() => {}));
    const started = Date.now();
    const err = await rejection(llmFor(s.url, 60_000).summarize("page", Deadline.start(300)));
    expect(err).toMatchObject({ status: 408, code: "SCRAPE_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a call that hits SEX_LLM_TIMEOUT before the deadline is the plain TIMEOUT", async () => {
    const s = serve(() => new Promise<Response>(() => {}));
    const err = await rejection(llmFor(s.url, 1000).summarize("page", Deadline.start(30_000)));
    expect(err).toMatchObject({ status: 408, code: "TIMEOUT" });
    expect(err.message).toContain("1000ms");
  });

  test("a rate-limit wait that does not fit in the deadline is not started", async () => {
    const s = serve(() => new Response("slow down", { status: 429, headers: { "retry-after": "5" } }));
    const err = await rejection(llmFor(s.url, 60_000).summarize("page", Deadline.start(1000)));
    expect(err).toMatchObject({ status: 429, code: "LLM_RATE_LIMITED" });
    expect(s.bodies.length).toBe(1);
  });

  test("other statuses are not retried", async () => {
    const s = serve(() => new Response("down", { status: 503 }));
    await expect(llmFor(s.url).summarize("page", NO_LIMIT)).rejects.toMatchObject({
      status: 502,
      code: "LLM_ERROR",
      details: { status: 503 },
    });
    expect(s.bodies.length).toBe(1);
  });
});

describe("structured output validation (#8)", () => {
  const schema = {
    type: "object",
    properties: { title: { type: "string" }, price: { type: "number" } },
    required: ["title"],
  };

  test("valid output passes", async () => {
    const s = serve(() => chatCompletionStream('{"title":"A","price":3}'));
    expect(await llmFor(s.url).extractJson("page", { schema }, NO_LIMIT)).toEqual({ title: "A", price: 3 });
  });

  test("output that breaks the schema is LLM_INVALID_OUTPUT", async () => {
    const s = serve(() => chatCompletionStream('{"price":"cheap"}'));
    const err = await rejection(llmFor(s.url).extractJson("page", { schema }, NO_LIMIT));
    expect(err).toMatchObject({ status: 422, code: "LLM_INVALID_OUTPUT" });
    expect((err.details as { errors: string[] }).errors).toEqual(
      expect.arrayContaining(["/ must have required property 'title'", "/price must be number"]),
    );
  });

  test("validates against the original schema, including keywords xsai strips from strict output", async () => {
    // xsai drops `not` / `allOf` / `if` when it builds the strict json_schema, so only our check enforces them.
    const s = serve(() => chatCompletionStream('{"title":"A"}'));
    const strict = { type: "object", properties: { title: { type: "string", not: { const: "A" } } } };
    await expect(llmFor(s.url).extractJson("page", { schema: strict }, NO_LIMIT)).rejects.toMatchObject({ code: "LLM_INVALID_OUTPUT" });
  });

  test("the fallback without response_format is validated too", async () => {
    const s = serve((_req, n) =>
      n === 1 ? new Response("json_schema not supported", { status: 400 }) : chatCompletionStream('```json\n{"title":1}\n```'),
    );
    await expect(llmFor(s.url).extractJson("page", { schema }, NO_LIMIT)).rejects.toMatchObject({ code: "LLM_INVALID_OUTPUT" });
    // The rejected json_schema request, the fallback, then one correction round, still without response_format.
    expect(s.bodies.length).toBe(3);
    expect(s.bodies.map((b) => b.response_format?.type ?? "none")).toEqual(["json_schema", "none", "none"]);
  });

  test("draft-07 and 2019-09 schemas are accepted", async () => {
    const s = serve(() => chatCompletionStream('{"title":"A"}'));
    const llm = llmFor(s.url);
    for (const $schema of ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2019-09/schema"]) {
      expect(await llm.extractJson("page", { schema: { $schema, ...schema } }, NO_LIMIT)).toEqual({ title: "A" });
    }
  });

  describe("invalid schemas fail with 400 before any work", () => {
    let s: ReturnType<typeof startLlm>;
    let engine: Engine;
    beforeAll(() => {
      s = serve(() => chatCompletionStream("{}"));
      engine = testEngine({ llmModel: "m", llmBaseUrl: s.url });
    });
    afterAll(() => engine.close());

    test.each([
      ["a bad type", { type: "nonsense" }],
      ["an unsupported dialect", { $schema: "http://json-schema.org/draft-04/schema#", type: "object" }],
    ])("%s", async (_name, bad) => {
      await expect(engine.scrape({ url: site.url, formats: [{ type: "json", schema: bad }] })).rejects.toMatchObject({
        status: 400,
        code: "BAD_REQUEST",
      });
      await expect(engine.extract({ urls: [site.url], schema: bad })).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
      expect(s.bodies.length).toBe(0);
    });
  });
});
