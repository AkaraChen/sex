import { type CoreConfigOverrides, resolveCoreConfig } from "../src/config.ts";
import { BaseEngine } from "../src/engine.ts";

export * from "@searxng-js/sex-testing";

/** A core engine for tests (no browser, LLM or jobs). Without a searxngUrl, searches fail fast instead of starting a real SearXNG. */
export function testCoreEngine(overrides: CoreConfigOverrides = {}) {
  return new BaseEngine(testCoreConfig(overrides));
}

/** The config of testCoreEngine: private networks allowed, short timeouts, the process environment ignored. */
export function testCoreConfig(overrides: CoreConfigOverrides = {}) {
  return resolveCoreConfig(
    { allowPrivateNetwork: true, concurrency: 4, timeout: 10_000, searxngUrl: "http://127.0.0.1:1", ...overrides },
    { allowPrivateNetwork: true },
    {},
  );
}
