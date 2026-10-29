import { AdBlockList, BrowserPool, planEgress } from "@searxng-js/sex-browser";
import { scrapeUrl } from "@searxng-js/sex-scrape";
import { cfg, isAppError, makeCtx, report } from "./common.mjs";

const list = AdBlockList.parse("ads.example\n~tracker.example\n@ok.ads.example\n");
const lightpanda = new BrowserPool({
  concurrency: 1,
  allowPrivateNetwork: true,
  blockMedia: false,
  lightpanda: true,
  lightpandaPath: "/nonexistent/lightpanda",
});
const off = new BrowserPool({ concurrency: 1, allowPrivateNetwork: true, blockMedia: false });
const { ctx, extractPool } = makeCtx({ browser: lightpanda });
let browserScrape;
try {
  // The binary is missing: waitFor needs a browser, so the scrape either fails with BROWSER_UNAVAILABLE or answers over plain HTTP with a warning.
  try {
    const { document } = await scrapeUrl(ctx, `${cfg.siteUrl}/docs/a`, { waitFor: 10, formats: ["markdown"], timeout: 15_000 });
    browserScrape = { ok: true, warning: document.warning };
  } catch (e) {
    browserScrape = { ok: false, isAppError: isAppError(e), code: e.code, status: e.status, message: e.message };
  }
  report({
    blocksAds: list.blocks("ads.example", "page.example"),
    blocksOther: list.blocks("fine.example", "page.example"),
    exception: list.blocks("ok.ads.example", "page.example"),
    enabled: { lightpanda: lightpanda.enabled, off: off.enabled },
    planType: typeof planEgress,
    browserScrape,
  });
} finally {
  await lightpanda.close();
  await off.close();
  await extractPool.close();
}
