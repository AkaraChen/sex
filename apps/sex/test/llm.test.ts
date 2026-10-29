import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/engine/engine.ts";
import { startFixtureSite, startMockLlm, testEngine } from "./helpers.ts";

// The client itself (result status, errors, rate limits, validation) is tested in packages/llm; this is the engine refusing a
// bad JSON Schema before it does any work.
describe("invalid schemas fail with 400 before any work", () => {
  let site: ReturnType<typeof startFixtureSite>;
  let llm: ReturnType<typeof startMockLlm>;
  let engine: Engine;
  beforeAll(() => {
    site = startFixtureSite();
    llm = startMockLlm(() => "{}");
    engine = testEngine({ llmModel: "m", llmBaseUrl: llm.url });
  });
  afterAll(async () => {
    await engine.close();
    llm.stop();
    site.stop();
  });

  test.each([
    ["a bad type", { type: "nonsense" }],
    ["an unsupported dialect", { $schema: "http://json-schema.org/draft-04/schema#", type: "object" }],
  ])("%s", async (_name, bad) => {
    await expect(engine.scrape({ url: site.url, formats: [{ type: "json", schema: bad }] })).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
    });
    await expect(engine.extract({ urls: [site.url], schema: bad })).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(llm.requests.length).toBe(0);
  });
});
