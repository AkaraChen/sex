import { expect, test } from "bun:test";
import { defaultDataDir, resolveConfig } from "../src/config.ts";
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
  expect(resolveConfig({ dataDir: "/x" }, undefined, { SEX_DATA_DIR: "/y" }).dataDir).toBe("/x");
});

test("SEX_DATA_DIR falls back to the per-command default; none keeps jobs in memory", () => {
  expect(resolveConfig({}, { allowPrivateNetwork: false, dataDir: "/d" }, {}).dataDir).toBe("/d");
  expect(resolveConfig({}, undefined, { SEX_DATA_DIR: "/e" }).dataDir).toBe("/e");
  expect(resolveConfig({}, undefined, {}).dataDir).toBeUndefined();
  expect(defaultDataDir({ XDG_DATA_HOME: "/xdg" })).toBe("/xdg/sex");
});

test("the removed Redis settings are rejected instead of silently ignored", () => {
  for (const name of ["SEX_REDIS_URL", "SEX_REDIS_PREFIX"]) {
    const err = configError(() => resolveConfig({}, undefined, { [name]: "redis://localhost:6379" }));
    expect(err.code).toBe("CONFIG_INVALID");
    expect(err.message).toContain(name);
  }
});

const configError = (fn: () => unknown): { code: string; message: string } => {
  try {
    fn();
  } catch (err) {
    return err as { code: string; message: string };
  }
  throw new Error("expected resolveConfig to throw");
};

test("empty env values count as unset, so the OpenAI default applies", () => {
  const llm = resolveConfig({}, undefined, { SEX_LLM_MODEL: "m", SEX_LLM_BASE_URL: "", SEX_LLM_API_KEY: "" }).llm;
  expect(llm?.baseUrl).toBe("https://api.openai.com/v1");
  expect(llm?.apiKey).toBeUndefined();
});

test("a SEX_JOB_TTL_MS that is not an integer is rejected with its name", () => {
  const err = configError(() => resolveConfig({}, undefined, { SEX_JOB_TTL_MS: "24h" }));
  expect(err.code).toBe("CONFIG_INVALID");
  expect(err.message).toContain("SEX_JOB_TTL_MS");
  expect(err.message).toContain('"24h"');
});

test("SEX_MAX_BODY_BYTES: empty is the default, garbage is rejected", () => {
  expect(resolveConfig({}, undefined, { SEX_MAX_BODY_BYTES: "" }).maxBodyBytes).toBe(26214400);
  expect(configError(() => resolveConfig({}, undefined, { SEX_MAX_BODY_BYTES: "abc" })).code).toBe("CONFIG_INVALID");
});

test("integer bounds and boolean words are enforced", () => {
  expect(configError(() => resolveConfig({}, undefined, { SEX_CONCURRENCY: "0" })).code).toBe("CONFIG_INVALID");
  expect(configError(() => resolveConfig({ concurrency: 0 }, undefined, {})).code).toBe("CONFIG_INVALID");
  expect(configError(() => resolveConfig({}, undefined, { SEX_LIGHTPANDA: "maybe" })).code).toBe("CONFIG_INVALID");
  expect(resolveConfig({}, undefined, { SEX_LIGHTPANDA: "YES" }).lightpanda).toBe(true);
  expect(resolveConfig({}, undefined, { SEX_LIGHTPANDA: "Off" }).lightpanda).toBe(false);
});

test("SEX_DOCS is off by default; the flag wins over the env", () => {
  expect(resolveConfig({}, undefined, {}).docs).toBe(false);
  expect(resolveConfig({}, undefined, { SEX_DOCS: "1" }).docs).toBe(true);
  expect(resolveConfig({ docs: false }, undefined, { SEX_DOCS: "1" }).docs).toBe(false);
  const err = configError(() => resolveConfig({}, undefined, { SEX_DOCS: "maybe" }));
  expect(err.message).toContain("SEX_DOCS");
});

test("SEARXNG URL must be an http(s) URL", () => {
  const err = configError(() => resolveConfig({}, undefined, { SEX_SEARXNG_URL: "not a url" }));
  expect(err.code).toBe("CONFIG_INVALID");
  expect(err.message).toContain("SEX_SEARXNG_URL");
});

test("defaults with an empty environment match the documented values", () => {
  const c = resolveConfig({}, undefined, {});
  expect(c.concurrency).toBe(8);
  expect(c.timeout).toBe(30000);
  expect(c.jobTtlMs).toBe(86400000);
  expect(c.maxBodyBytes).toBe(26214400);
  expect(c.extractWildcardPages).toBe(25);
  expect(c.llmMaxInputChars).toBe(200000);
});

test("error messages never include the API key", () => {
  const err = configError(() => resolveConfig({}, undefined, { SEX_LLM_MODEL: "m", SEX_LLM_API_KEY: "sk-secret", SEX_TIMEOUT: "x" }));
  expect(err.message).toContain("SEX_TIMEOUT");
  expect(err.message).not.toContain("sk-secret");
});
