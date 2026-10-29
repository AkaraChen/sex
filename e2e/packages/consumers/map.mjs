import { mapSite } from "@searxng-js/sex-map";
import { cfg, makeCtx, report } from "./common.mjs";

const { ctx, extractPool } = makeCtx();
try {
  const { links } = await mapSite(ctx, { url: `${cfg.siteUrl}/`, limit: 50, sitemap: "include" });
  report({ urls: links.map((l) => l.url) });
} finally {
  await extractPool.close();
}
