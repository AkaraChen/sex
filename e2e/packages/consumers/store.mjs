import { join } from "node:path";
import { scrapeUrl } from "@searxng-js/sex-scrape";
import { markdownDiff, SqliteChangeTracker, SqliteScrapeCache } from "@searxng-js/sex-store";
import { cfg, makeCtx, report } from "./common.mjs";

const cache = new SqliteScrapeCache(join(cfg.dir, "cache.sqlite"), { defaultMaxAge: 0, ttlMs: 60_000, maxBytes: 10_000_000 });
const tracker = new SqliteChangeTracker(join(cfg.dir, "change-tracking.sqlite"));

// The stores on their own.
const key = { url: "https://example.com/a", variant: "v" };
const missBefore = await cache.get(key, { maxAge: 60_000 });
await cache.put(key, { url: key.url, status: 200, contentType: "text/html", body: new TextEncoder().encode("<p>cached</p>") });
const hit = await cache.get(key, { maxAge: 60_000 });
await tracker.put("https://example.com/a", null, "line one\nline two\n", Date.now());
const tracked = await tracker.get("https://example.com/a", null);
const diff = markdownDiff("a\nb\n", "a\nc\n", 1000);

// Through scrapeUrl: the second scrape within maxAge does not reach the site.
const { ctx, extractPool } = makeCtx({ cache, changeTracker: tracker });
let first;
let second;
try {
  first = (await scrapeUrl(ctx, `${cfg.siteUrl}/docs/a`, { formats: ["markdown"], maxAge: 60_000 })).document;
  second = (await scrapeUrl(ctx, `${cfg.siteUrl}/docs/a`, { formats: ["markdown"], maxAge: 60_000 })).document;
} finally {
  await extractPool.close();
}
cache.close();
tracker.close();
report({
  missBefore: missBefore === undefined,
  hitBody: hit && new TextDecoder().decode(hit.body),
  hitStatus: hit?.status,
  tracked: tracked?.markdown,
  diffText: diff?.text,
  diffFiles: diff?.json?.files?.length,
  firstState: first.metadata?.cacheState,
  secondState: second.metadata?.cacheState,
  sameMarkdown: first.markdown === second.markdown && first.markdown.length > 0,
});
