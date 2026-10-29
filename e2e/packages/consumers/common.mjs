// Shared by the consumer programs: what an outside project writes to build a scrape context (the READMEs' example).
import { ExtractPool } from "@searxng-js/sex-page";
import pLimit from "p-limit";

export const cfg = JSON.parse(process.env.CFG ?? "{}");

/** Prints the result as the last stdout line; the test parses it. */
export function report(value) {
  console.log(`RESULT ${JSON.stringify(value)}`);
}

export function makeCtx(extra = {}) {
  const extractPool = new ExtractPool({ size: 1, taskTimeoutMs: 30_000 });
  const ctx = {
    settings: { allowPrivateNetwork: true, userAgent: "e2e-consumer/1.0", timeout: 20_000, maxBodyBytes: 5 * 1024 * 1024 },
    scrapeLimit: pLimit(4),
    searchDomainLimit: pLimit(2),
    extractPool,
    searxng: { url: async () => cfg.searxngUrl },
    ...extra,
  };
  return { ctx, extractPool };
}

/** The marker `AppError` carries (packages/errors); `AppError` itself is not exported by any package. */
export const isAppError = (e) => typeof e === "object" && e !== null && e[Symbol.for("searxng-js.sex.error")] !== undefined;
