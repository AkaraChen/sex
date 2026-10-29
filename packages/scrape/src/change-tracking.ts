import { toAppError } from "@searxng-js/sex-errors";
import type { Logger } from "@searxng-js/sex-page";
import { type ChangeTracker, GUARD_MAX_CHARS, type ScrapeLlm } from "./capabilities.ts";
import type { Deadline } from "./deadline.ts";
import type { ChangeTrackingResult } from "./schemas.ts";

/** The `changeTracking` format of a request, normalized. */
export interface ChangeTrackingRequest {
  modes: Array<"git-diff" | "json">;
  tag: string | null;
  prompt?: string;
  schema?: Record<string, unknown>;
}

export interface TrackInput {
  tracker: ChangeTracker;
  /** Present and enabled whenever `request.modes` has "json" (`assertScrapeCapabilities`). */
  llm?: ScrapeLlm;
  request: ChangeTrackingRequest;
  /** The requested URL, which is what the scrape is stored under. */
  url: string;
  /** The page's markdown. */
  markdown: string;
  /** What the LLM may be sent of it: the markdown, cut where the prompt injection guard stopped scanning. */
  scanned: string;
  /** Run the injection guard on the previous version too (the request asked for it); it was stored before and may not have been scanned. */
  guard: boolean;
  status: number;
  /** Bounds the diff and the LLM calls. */
  deadline: Deadline;
  warnings: string[];
  logger: Logger;
}

/** The text with iframe embeds removed and every run of whitespace turned into one space (and trimmed). */
const normalize = (markdown: string) =>
  markdown
    .replace(/\[iframe\]\(.+?\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Whether two versions are the same text once whitespace differences and iframe embeds (Firecrawl removes those too) are
 * ignored. Unlike Firecrawl, which only compares the characters' counts, the text has to be equal as written: moving a
 * paragraph or changing one letter is a change.
 */
export function sameContent(previous: string, current: string): boolean {
  return normalize(previous) === normalize(current);
}

/** `{ field: { previous, current } }` for every top-level field whose value differs (Firecrawl's `compareExtractedData`). */
export function compareExtracted(previous: unknown, current: unknown): Record<string, { previous: unknown; current: unknown }> {
  const a = (previous ?? {}) as Record<string, unknown>;
  const b = (current ?? {}) as Record<string, unknown>;
  const out: Record<string, { previous: unknown; current: unknown }> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out[key] = { previous: a[key], current: b[key] };
  }
  return out;
}

/**
 * Compares a scrape with the last one stored under the same `(url, tag)` and stores this one in its place, Firecrawl's
 * `changeStatus` rules: `new` without a previous scrape, `removed` for a 404, else `same` or `changed`. Only a 2xx page is
 * stored, so a 404 or an error page does not become the reference for the next scrape. A store that cannot be read or
 * written costs a warning, not the scrape. Returns undefined when nothing could be compared.
 */
export async function trackChanges(input: TrackInput): Promise<ChangeTrackingResult | undefined> {
  const { tracker, request, url, markdown, deadline, warnings, logger: log } = input;
  let previous: Awaited<ReturnType<ChangeTracker["get"]>>;
  try {
    previous = await tracker.get(url, request.tag);
  } catch (err) {
    log.warn("change tracking read failed", { url, error: toAppError(err).message });
    warnings.push("Comparing failed, please try again later.");
    return undefined;
  }

  const removed = input.status === 404;
  const changed = !!previous && !removed && !sameContent(previous.markdown, markdown);
  const result: ChangeTrackingResult = {
    previousScrapeAt: previous ? new Date(previous.scrapedAt).toISOString() : null,
    changeStatus: removed ? "removed" : !previous ? "new" : changed ? "changed" : "same",
    visibility: "visible",
  };

  if (previous && changed) {
    if (request.modes.includes("git-diff")) {
      const diff = tracker.diff(previous.markdown, markdown, deadline.time());
      if (diff) result.diff = diff;
      else warnings.push("The git-diff was skipped: the page was too large to diff in time.");
    }
    if (request.modes.includes("json")) await describeChanges(input, previous.markdown, result);
  }

  if (input.status >= 200 && input.status < 300) {
    try {
      await tracker.put(url, request.tag, markdown, Date.now());
    } catch (err) {
      log.warn("change tracking write failed", { url, error: toAppError(err).message });
      warnings.push("This scrape could not be stored, so the next one will be compared with an older version.");
    }
  }
  return result;
}

/** The `json` mode. A failed LLM call costs the mode, not the scrape; time running out and configuration errors do not. */
async function describeChanges(input: TrackInput, previous: string, result: ChangeTrackingResult): Promise<void> {
  const { request, deadline, warnings, logger: log } = input;
  const llm = input.llm as ScrapeLlm;
  const url = input.url;
  const time = deadline.time();
  try {
    // The stored version was cut or scanned when it was scraped, if at all; with the guard on it is scanned now like the current one.
    let before = previous;
    if (input.guard) {
      before = previous.slice(0, GUARD_MAX_CHARS);
      try {
        await llm.checkInjection(before, time);
      } catch (err) {
        if (toAppError(err).code !== "SCRAPE_PROMPT_INJECTION_DETECTED") throw err;
        warnings.push("The structured diff was skipped: the previous version of the page was flagged by the prompt injection check.");
        return;
      }
    }
    const after = input.scanned;
    if (request.schema) {
      const [a, b] = [llm.fit(before), llm.fit(after)];
      if (a.truncated || b.truncated)
        warnings.push(`A version of the page was too long for the LLM; only its first ${llm.maxInputChars} characters were used.`);
      const opts = { prompt: request.prompt, schema: request.schema, url };
      const [was, is] = await Promise.all([llm.extractJson(a.text, opts, time), llm.extractJson(b.text, opts, time)]);
      result.json = compareExtracted(was, is);
    } else {
      const half = llm.maxInputChars / 2;
      if (before.length > half || after.length > half) {
        warnings.push(`A version of the page was too long for the LLM; only its first ${Math.floor(half)} characters were used.`);
      }
      result.json = await llm.describeChanges(before, after, { prompt: request.prompt, url }, time);
    }
  } catch (err) {
    if (deadline.signal.aborted) throw deadline.translate(err);
    const e = toAppError(err);
    if (e.status === 501 || e.code === "SCRAPE_PROMPT_INJECTION_DETECTED") throw err;
    log.warn("change tracking json failed", { url, code: e.code, error: e.message });
    warnings.push(`Structured diff generation failed: ${e.message}`);
  }
}
