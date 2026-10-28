import type { CoreConfig } from "@sex/core/config.ts";
import { BaseEngine } from "@sex/core/engine.ts";

/** What the 501 errors for browser and LLM options say: sex-lite has neither. */
const missingHints = {
  browser: "sex-lite has no browser; use sex with --lightpanda or --cdp-url for this.",
  llm: "sex-lite has no LLM; use sex with --llm-model for this.",
};

/** sex-lite's engine: the core search and fetch, nothing else. */
export const liteEngine = (config: CoreConfig) => new BaseEngine(config, { missingHints });
