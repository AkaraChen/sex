import { expect, test } from "bun:test";
import { resolveConfig } from "../src/config.ts";
import { testEngine } from "./helpers.ts";

test("resolveConfig reads from an explicit env object", () => {
  expect(resolveConfig({}, undefined, { SEX_LLM_MODEL: "m" }).llm?.model).toBe("m");
});

test("test engines ignore the process environment", async () => {
  const saved = { model: process.env.SEX_LLM_MODEL, lightpanda: process.env.SEX_LIGHTPANDA };
  process.env.SEX_LLM_MODEL = "leak";
  process.env.SEX_LIGHTPANDA = "1";
  const engine = testEngine();
  try {
    expect(engine.config.llm).toBeUndefined();
    expect(engine.config.lightpanda).toBe(false);
  } finally {
    await engine.close();
    if (saved.model === undefined) delete process.env.SEX_LLM_MODEL;
    else process.env.SEX_LLM_MODEL = saved.model;
    if (saved.lightpanda === undefined) delete process.env.SEX_LIGHTPANDA;
    else process.env.SEX_LIGHTPANDA = saved.lightpanda;
  }
});

test("overrides win over the env object", () => {
  expect(resolveConfig({ redisPrefix: "x" }, undefined, { SEX_REDIS_PREFIX: "y" }).redisPrefix).toBe("x");
});
