// What a project that did not install the optional peers sees: every package imports, and the feature that needs a peer says which.
import { cfg, isAppError, report } from "./common.mjs";

const names = ["egress", "page", "scrape", "searxng", "search", "map", "jobs", "store", "llm", "browser", "docs"];
const imports = {};
for (const n of names) {
  try {
    const m = await import(`@searxng-js/sex-${n}`);
    imports[n] = Object.keys(m).length;
  } catch (e) {
    imports[n] = `FAILED: ${e.message}`;
  }
}

async function attempt(fn) {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    return { ok: false, isAppError: isAppError(e), code: e.code, status: e.status, message: String(e.message) };
  }
}

const { safeFetch } = await import("@searxng-js/sex-egress");
const { markdownToHtml } = await import("@searxng-js/sex-page");
const { generatedSettings } = await import("@searxng-js/sex-searxng");
const { createDocumentLog } = await import("@searxng-js/sex-jobs");
const { scrapeUrl } = await import("@searxng-js/sex-scrape");
const { makeCtx } = await import("./common.mjs");
const { ctx, extractPool } = makeCtx();
const out = {
  imports,
  undici: await attempt(() =>
    safeFetch(`${cfg.siteUrl}/`, { signal: AbortSignal.timeout(5000), allowPrivateNetwork: true, proxy: undefined, userAgent: "x" }),
  ),
  undiciViaScrape: await attempt(() => scrapeUrl(ctx, `${cfg.siteUrl}/docs/a`, { formats: ["markdown"] })),
  marked: await attempt(() => markdownToHtml("# x")),
  yaml: await attempt(() => generatedSettings({ proxyUrl: "http://user:pass@127.0.0.1:3128" })),
  s3:
    typeof Bun !== "undefined"
      ? { skipped: true }
      : await attempt(() => createDocumentLog({ documentsUrl: "s3://bucket/prefix" }).append("job", "{}")),
};
await extractPool.close();
report(out);
