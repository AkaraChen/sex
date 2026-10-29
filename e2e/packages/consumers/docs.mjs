import { DocsConverter } from "@searxng-js/sex-docs";
import { scrapeUrl } from "@searxng-js/sex-scrape";
import { cfg, isAppError, makeCtx, report } from "./common.mjs";

const off = new DocsConverter({ enabled: false, concurrency: 1 });
const { ctx, extractPool } = makeCtx({ docs: off });
let docxOff;
let warmup;
try {
  try {
    await scrapeUrl(ctx, `${cfg.siteUrl}/report.docx`, { formats: ["markdown"] });
  } catch (e) {
    docxOff = { isAppError: isAppError(e), code: e.code, status: e.status };
  }
  const on = new DocsConverter({ enabled: true, concurrency: 1 });
  try {
    await on.warmup();
    warmup = { ok: true };
  } catch (e) {
    warmup = { ok: false, isAppError: isAppError(e), code: e.code, message: String(e.message).slice(0, 300) };
  }
  await on.close();
  report({ offEnabled: off.enabled, docxOff, warmup });
} finally {
  await extractPool.close();
}
