import { subscribe } from "node:diagnostics_channel";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteScrapeCache } from "@searxng-js/sex-store";
import { cfg, report } from "./common.mjs";

const seen = [];
subscribe("searxng-js:sex:store", (m) => seen.push(m));
// A cache file that is not a database is replaced, and says so on the channel.
const file = join(cfg.dir, "broken.sqlite");
writeFileSync(file, "this is not a database, but it is long enough to look like a file someone wrote by mistake".repeat(20));
const cache = new SqliteScrapeCache(file, { defaultMaxAge: 0, ttlMs: 60_000, maxBytes: 1_000_000 });
await cache.get({ url: "https://example.com/", variant: "v" }, { maxAge: 1000 });
cache.close();
report({ messages: seen });
