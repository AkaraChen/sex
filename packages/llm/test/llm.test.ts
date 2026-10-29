import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { Llm } from "@searxng-js/sex-llm";
import { type ChatBody, chatCompletionStream, type Handler, matches, startLlm, within } from "./support.ts";

const servers: Array<{ stop: () => Promise<void> }> = [];
async function serve(handler: Handler) {
  const s = await startLlm(handler);
  servers.push(s);
  return s;
}
after(async () => {
  for (const s of servers) await s.stop();
});

/** The error a promise rejects with. */
async function rejection(p: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await p;
  } catch (err) {
    return err as Error & Record<string, unknown>;
  }
  throw new Error("expected a rejection");
}

async function rejectsWith(p: Promise<unknown>, expected: Record<string, unknown>) {
  const err = await rejection(p);
  assert.ok(
    matches(err, expected),
    `${JSON.stringify({ status: err.status, code: err.code, details: err.details })} does not match ${JSON.stringify(expected)}`,
  );
  return err;
}

const llmFor = (url: string, timeoutMs = 10_000) => new Llm({ endpoint: { baseUrl: url, model: "m" }, maxInputChars: 200_000, timeoutMs });

const NO_LIMIT = {};

describe("result status", () => {
  test("output truncated at the token limit", async () => {
    const s = await serve(() => chatCompletionStream('{"title": "Doc', { finishReason: "length" }));
    const err = await rejectsWith(llmFor(s.url).extractJson("page", { schema: { type: "object" } }, NO_LIMIT), {
      status: 422,
      code: "LLM_INCOMPLETE_OUTPUT",
      details: { status: "incomplete", reason: "length" },
    });
    assert.match(err.message, /token limit/);
  });

  test("output stopped by the content filter", async () => {
    const s = await serve(() => chatCompletionStream("partial", { finishReason: "content_filter" }));
    await rejectsWith(llmFor(s.url).summarize("page", NO_LIMIT), {
      code: "LLM_INCOMPLETE_OUTPUT",
      details: { status: "incomplete", reason: "content-filter" },
    });
  });

  test("refusal keeps the refusal text", async () => {
    const s = await serve(() => chatCompletionStream("", { refusal: "I can't help with that." }));
    const err = await rejectsWith(llmFor(s.url).answer("page", "q", NO_LIMIT), { status: 422, code: "LLM_REFUSED" });
    assert.match(err.message, /I can't help with that\./);
  });
});

describe("errors", () => {
  for (const status of [400, 401, 403, 404]) {
    test(`a ${status} from the endpoint is a configuration error, not a 502`, async () => {
      const s = await serve(() => new Response("bad key", { status, headers: { "x-request-id": "req_1" } }));
      const err = await rejectsWith(llmFor(s.url).summarize("page", NO_LIMIT), {
        status: 500,
        code: "LLM_REQUEST_REJECTED",
        retryable: false,
        details: { status, requestId: "req_1" },
      });
      assert.match(err.message, /req_1/);
      assert.match(err.message, /SEX_LLM_API_KEY/);
    });
  }

  test("an upstream 5xx stays LLM_ERROR (502)", async () => {
    const s = await serve(() => new Response("boom", { status: 500, headers: { "x-request-id": "req_3" } }));
    await rejectsWith(llmFor(s.url).summarize("page", NO_LIMIT), {
      status: 502,
      code: "LLM_ERROR",
      retryable: true,
      details: { status: 500, requestId: "req_3" },
    });
  });

  test("an unreachable endpoint is LLM_UNAVAILABLE", async () => {
    const s = await serve(() => new Response());
    await s.stop();
    await rejectsWith(llmFor(s.url).summarize("page", NO_LIMIT), { code: "LLM_UNAVAILABLE", details: { code: "network-error" } });
  });

  test("without an endpoint every call is a 501", async () => {
    const llm = new Llm({ maxInputChars: 1000, timeoutMs: 1000 });
    assert.equal(llm.enabled, false);
    await rejectsWith(llm.summarize("page", NO_LIMIT), { status: 501 });
  });
});

describe("rate limits", () => {
  test("waits out retry-after, then succeeds", async () => {
    const s = await serve((_b, n) =>
      n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : chatCompletionStream("ok"),
    );
    assert.equal(await llmFor(s.url).summarize("page", NO_LIMIT), "ok");
    assert.equal(s.bodies.length, 2);
  });

  test("the retry warning goes to the logger when there is one", async () => {
    const s = await serve((_b, n) =>
      n === 1 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : chatCompletionStream("ok"),
    );
    const warnings: string[] = [];
    const llm = new Llm({
      endpoint: { baseUrl: s.url, model: "m" },
      maxInputChars: 200_000,
      timeoutMs: 10_000,
      logger: { debug() {}, info() {}, error() {}, warn: (m) => warnings.push(m) },
    });
    await llm.summarize("page", NO_LIMIT);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /LLM returned 429/);
  });

  test("honours retry-after-ms and 503 with retry-after", async () => {
    const s = await serve((_b, n) =>
      n === 1
        ? new Response("busy", { status: 503, headers: { "retry-after-ms": "50" } })
        : n === 2
          ? new Response("busy", { status: 429, headers: { "retry-after": new Date(Date.now()).toUTCString() } })
          : chatCompletionStream("ok"),
    );
    assert.equal(await llmFor(s.url).summarize("page", NO_LIMIT), "ok");
    assert.equal(s.bodies.length, 3);
  });

  test("gives up after the retry budget with LLM_RATE_LIMITED", async () => {
    const s = await serve(() => new Response("slow down", { status: 429, headers: { "retry-after": "0", "request-id": "req_2" } }));
    await rejectsWith(llmFor(s.url).summarize("page", NO_LIMIT), {
      status: 429,
      code: "LLM_RATE_LIMITED",
      details: { status: 429, requestId: "req_2", retryAfterMs: 0 },
    });
    assert.equal(s.bodies.length, 3);
  });

  test("does not wait past the call's own timeout", async () => {
    const s = await serve(() => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    const started = Date.now();
    await rejectsWith(llmFor(s.url, 2000).summarize("page", NO_LIMIT), { code: "LLM_RATE_LIMITED", details: { retryAfterMs: 30_000 } });
    assert.ok(Date.now() - started < 1000);
    assert.equal(s.bodies.length, 1);
  });

  test("a wait is cut short by the caller's signal", async () => {
    const s = await serve(() => new Response("slow down", { status: 429, headers: { "retry-after": "5" } }));
    const started = Date.now();
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 100);
    await rejectsWith(llmFor(s.url).summarize("page", { signal: caller.signal }), { status: 408, code: "TIMEOUT" });
    assert.ok(Date.now() - started < 2000);
  });

  test("a call never outlasts the time it is given, and that is SCRAPE_TIMEOUT, not the call's own TIMEOUT", async () => {
    const s = await serve(() => new Promise<Response>(() => {}));
    const started = Date.now();
    await rejectsWith(llmFor(s.url, 60_000).summarize("page", within(300)), { status: 408, code: "SCRAPE_TIMEOUT" });
    assert.ok(Date.now() - started < 2000);
  });

  test("a call that hits its own timeout before the caller's time is the plain TIMEOUT", async () => {
    const s = await serve(() => new Promise<Response>(() => {}));
    const err = await rejectsWith(llmFor(s.url, 1000).summarize("page", within(30_000)), { status: 408, code: "TIMEOUT" });
    assert.match(err.message, /1000ms/);
  });

  test("a rate-limit wait that does not fit in the given time is not started", async () => {
    const s = await serve(() => new Response("slow down", { status: 429, headers: { "retry-after": "5" } }));
    await rejectsWith(llmFor(s.url, 60_000).summarize("page", within(1000)), { status: 429, code: "LLM_RATE_LIMITED" });
    assert.equal(s.bodies.length, 1);
  });

  test("other statuses are not retried", async () => {
    const s = await serve(() => new Response("down", { status: 503 }));
    await rejectsWith(llmFor(s.url).summarize("page", NO_LIMIT), { status: 502, code: "LLM_ERROR", details: { status: 503 } });
    assert.equal(s.bodies.length, 1);
  });
});

describe("structured output validation", () => {
  const schema = {
    type: "object",
    properties: { title: { type: "string" }, price: { type: "number" } },
    required: ["title"],
  };

  test("valid output passes", async () => {
    const s = await serve(() => chatCompletionStream('{"title":"A","price":3}'));
    assert.deepEqual(await llmFor(s.url).extractJson("page", { schema }, NO_LIMIT), { title: "A", price: 3 });
  });

  test("output that breaks the schema is LLM_INVALID_OUTPUT", async () => {
    const s = await serve(() => chatCompletionStream('{"price":"cheap"}'));
    const err = await rejectsWith(llmFor(s.url).extractJson("page", { schema }, NO_LIMIT), { status: 422, code: "LLM_INVALID_OUTPUT" });
    const errors = (err.details as { errors: string[] }).errors;
    assert.ok(errors.includes("/ must have required property 'title'"));
    assert.ok(errors.includes("/price must be number"));
  });

  test("validates against the original schema, including keywords xsai strips from strict output", async () => {
    // xsai drops `not` / `allOf` / `if` when it builds the strict json_schema, so only our check enforces them.
    const s = await serve(() => chatCompletionStream('{"title":"A"}'));
    const strict = { type: "object", properties: { title: { type: "string", not: { const: "A" } } } };
    await rejectsWith(llmFor(s.url).extractJson("page", { schema: strict }, NO_LIMIT), { code: "LLM_INVALID_OUTPUT" });
  });

  test("the fallback without response_format is validated too", async () => {
    const s = await serve((_b, n) =>
      n === 1 ? new Response("json_schema not supported", { status: 400 }) : chatCompletionStream('```json\n{"title":1}\n```'),
    );
    await rejectsWith(llmFor(s.url).extractJson("page", { schema }, NO_LIMIT), { code: "LLM_INVALID_OUTPUT" });
    // The rejected json_schema request, the fallback, then one correction round, still without response_format.
    assert.deepEqual(
      s.bodies.map((b: ChatBody) => b.response_format?.type ?? "none"),
      ["json_schema", "none", "none"],
    );
  });

  test("draft-07 and 2019-09 schemas are accepted", async () => {
    const s = await serve(() => chatCompletionStream('{"title":"A"}'));
    const llm = llmFor(s.url);
    for (const $schema of ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2019-09/schema"]) {
      assert.deepEqual(await llm.extractJson("page", { schema: { $schema, ...schema } }, NO_LIMIT), { title: "A" });
    }
  });

  test("an invalid schema is a 400 before any request", async () => {
    const s = await serve(() => chatCompletionStream("{}"));
    const llm = llmFor(s.url);
    for (const bad of [{ type: "nonsense" }, { $schema: "http://json-schema.org/draft-04/schema#", type: "object" }]) {
      assert.throws(
        () => llm.checkSchema(bad),
        (err: Error & { status?: number }) => err.status === 400,
      );
      await rejectsWith(llm.extractJson("page", { schema: bad }, NO_LIMIT), { status: 400, code: "BAD_REQUEST" });
    }
    assert.equal(s.bodies.length, 0);
  });
});

describe("the small model", () => {
  test("auxiliary calls use it, extraction and the guard stay on the main model", async () => {
    const s = await serve((body) => {
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      return chatCompletionStream(
        system.includes("security classifier")
          ? '{"isInjection":false,"reason":"fine"}'
          : system.includes("You write the JSON Schema")
            ? '{"type":"object"}'
            : '{"title":"A"}',
      );
    });
    const llm = new Llm({ endpoint: { baseUrl: s.url, model: "big", smallModel: "tiny" }, maxInputChars: 200_000, timeoutMs: 10_000 });
    await llm.generateSchema("the title", NO_LIMIT);
    await llm.extractJson("page", { prompt: "title" }, NO_LIMIT);
    await llm.checkInjection("some page", NO_LIMIT);
    assert.deepEqual(
      s.bodies.map((b) => b.model),
      ["tiny", "big", "big"],
    );
  });
});
