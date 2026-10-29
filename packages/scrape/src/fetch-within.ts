import { type FetchedResponse, type FetchOptions, safeFetch } from "@searxng-js/sex-egress";
import type { Deadline } from "./deadline.ts";

/**
 * `safeFetch` bounded by a `Deadline`: the package only knows an `AbortSignal`, so what it throws after the abort is
 * replaced by the deadline's own error (`SCRAPE_TIMEOUT` when the time ran out, `TIMEOUT` when the caller cancelled).
 * Pass `deadline.slice(ms)` for a step budget of its own.
 */
export async function fetchWithin(rawUrl: string, deadline: Deadline, opts: Omit<FetchOptions, "signal">): Promise<FetchedResponse> {
  try {
    return await safeFetch(rawUrl, { ...opts, signal: deadline.signal });
  } catch (err) {
    throw deadline.translate(err, `while fetching ${rawUrl}`);
  }
}
