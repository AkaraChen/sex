import type { CoreConfig } from "@searxng-js/sex-server/config";
import { BaseEngine } from "@searxng-js/sex-server/engine";

/** What the 501 errors for browser and LLM options say: sex-lite has neither. */
const missingHints = {
  browser: "sex-lite has no browser; use sex with --lightpanda or --cdp-url for this.",
  llm: "sex-lite has no LLM; use sex with --llm-model for this.",
  changeTracking: "sex-lite keeps no earlier scrapes to compare with; sex supports it (run `sex serve`, which keeps them in its data dir).",
};

/** sex-lite's engine: the core search and fetch, nothing else. */
export const liteEngine = (config: CoreConfig) => new BaseEngine(config, { missingHints });
