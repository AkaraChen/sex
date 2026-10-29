import { Llm } from "@searxng-js/sex-llm";
import { scrapeUrl } from "@searxng-js/sex-scrape";
import { cfg, isAppError, makeCtx, report } from "./common.mjs";

const llm = new Llm({ endpoint: { baseUrl: cfg.llmUrl, apiKey: "k", model: "mock-model" }, maxInputChars: 100_000, timeoutMs: 20_000 });
const { ctx, extractPool } = makeCtx({ llm });
const disabled = new Llm({ maxInputChars: 1000, timeoutMs: 1000 });
try {
  const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
  const { document } = await scrapeUrl(ctx, `${cfg.siteUrl}/docs/a`, { formats: ["markdown", { type: "json", schema }] });
  let unconfigured;
  try {
    await scrapeUrl(makeCtx({ llm: disabled }).ctx, `${cfg.siteUrl}/docs/a`, { formats: [{ type: "json", schema }] });
  } catch (e) {
    unconfigured = { isAppError: isAppError(e), code: e.code, status: e.status };
  }
  report({ enabled: llm.enabled, disabledEnabled: disabled.enabled, json: document.json, unconfigured });
} finally {
  await extractPool.close();
}
