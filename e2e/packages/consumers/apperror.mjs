// sex-scrape's README: "Errors are AppErrors ...: check them with AppError.isInstance(e)". Where does a consumer import it from?
import { cfg, report } from "./common.mjs";

const names = ["egress", "page", "scrape", "searxng", "search", "map", "jobs", "store", "llm", "browser", "docs"];
const exporters = [];
for (const n of names) {
  const m = await import(`@searxng-js/sex-${n}`);
  if (typeof m.AppError?.isInstance === "function") exporters.push(n);
}
let works = false;
if (exporters.length) {
  const { AppError } = await import(`@searxng-js/sex-${exporters[0]}`);
  const { safeFetch } = await import("@searxng-js/sex-egress");
  try {
    await safeFetch(`${cfg.siteUrl}/`, { signal: AbortSignal.timeout(5000), allowPrivateNetwork: false, proxy: undefined, userAgent: "x" });
  } catch (e) {
    works = AppError.isInstance(e);
  }
}
report({ exporters, works });
