import { scrapeUrl } from "@searxng-js/sex-scrape";
import { cfg, makeCtx, report } from "./common.mjs";

const { ctx, extractPool } = makeCtx();
try {
  const { document } = await scrapeUrl(ctx, `${cfg.siteUrl}/docs/a`, { formats: ["markdown", "links"] });
  report({ markdown: document.markdown, links: document.links, title: document.metadata?.title, status: document.metadata?.statusCode });
} finally {
  await extractPool.close();
}
