import { search } from "@searxng-js/sex-search";
import { makeCtx, report } from "./common.mjs";

const { ctx, extractPool } = makeCtx();
try {
  const { data } = await search(ctx, { query: "defuddle", limit: 5 });
  const scraped = await search(ctx, { query: "defuddle", limit: 1, scrapeOptions: { formats: ["markdown"] } });
  report({ urls: data.web?.map((r) => r.url), titles: data.web?.map((r) => r.title), scrapedMarkdown: scraped.data.web?.[0]?.markdown });
} finally {
  await extractPool.close();
}
