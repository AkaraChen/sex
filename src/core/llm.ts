import { randomUUID } from "node:crypto";
import { type CollectResult, chat, generateText, HttpError, type JSONSchema7, type LanguageModel, type Message, XSAIError } from "xsai";
import type { Config } from "../config.ts";
import { AppError, llmRequired } from "../errors.ts";
import { log } from "../log.ts";
import type { Deadline } from "./deadline.ts";
import { compileJsonSchema, describeSchemaErrors } from "./json-schema.ts";
import * as P from "./prompts.ts";

/** Retries after a 429 (or a 503 that says when to come back); xsai itself never retries. */
const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 1000;

/** The prompt injection guard scans overlapping chunks, so an injection cannot hide on a boundary. */
const GUARD_CHUNK_CHARS = 32_000;
const GUARD_CHUNK_OVERLAP = 2_000;
/** Guard chunks classified at once; a detection stops later batches from being sent. */
const GUARD_BATCH = 5;

type Schema = Record<string, unknown>;

/** Returns what is wrong with a parsed reply, or nothing when it is acceptable. */
type Check = (value: unknown) => string[] | undefined;

export interface ExtractJsonOptions {
  prompt?: string;
  schema?: Schema;
  systemPrompt?: string;
  /** URLs the user asked about, named in the system prompt. */
  urls?: string[];
  /** The page URL, given to the model as the url attribute of <page>. */
  url?: string;
}

export interface ExtractPlan {
  isMultiEntity: boolean;
  multiEntityKeys: string[];
}

const PLAN_SCHEMA: Schema = {
  type: "object",
  properties: {
    isMultiEntity: { type: "boolean" },
    multiEntityKeys: { type: "array", items: { type: "string" } },
    reasoning: { type: "string" },
  },
  required: ["isMultiEntity", "multiEntityKeys", "reasoning"],
  additionalProperties: false,
};

const GUARD_SCHEMA: Schema = {
  type: "object",
  properties: { isInjection: { type: "boolean" }, reason: { type: "string" } },
  required: ["isInjection", "reason"],
  additionalProperties: false,
};

/** Client for any OpenAI-compatible /chat/completions endpoint, built on xsai. */
export class Llm {
  private model?: LanguageModel;

  constructor(private readonly config: Config) {}

  get enabled(): boolean {
    return !!this.config.llm;
  }

  get maxInputChars(): number {
    return this.config.llmMaxInputChars;
  }

  require(what: string): NonNullable<Config["llm"]> {
    if (!this.config.llm) throw llmRequired(what);
    return this.config.llm;
  }

  /** Cuts content to the input budget. Callers that can report it turn `truncated` into a warning. */
  fit(content: string): { text: string; truncated: boolean } {
    if (content.length <= this.maxInputChars) return { text: content, truncated: false };
    return { text: content.slice(0, this.maxInputChars), truncated: true };
  }

  /** One LLM call; its budget is `SEX_LLM_TIMEOUT` out of what `deadline` has left, and covers every attempt, rate-limit waits included. */
  private async complete(
    what: string,
    instructions: string,
    input: string | Message[],
    outputFormat: Schema | undefined,
    deadline: Deadline,
  ): Promise<string> {
    const llm = this.require(what);
    this.model ??= chat({ baseURL: llm.baseUrl, apiKey: llm.apiKey, model: llm.model });
    const model = this.model;
    const call = deadline.slice(this.config.llmTimeout, { expiredCode: "TIMEOUT" });
    let result: CollectResult;
    try {
      result = await withRateLimitRetries(
        () => generateText(model, { instructions, input, outputFormat: outputFormat as JSONSchema7 | undefined, signal: call.signal }),
        call,
      );
    } catch (err) {
      call.throwIfAborted("while waiting for the LLM");
      throw toLlmError(err, llm.baseUrl);
    }
    return resultText(result);
  }

  /**
   * Asks for JSON and checks the reply. A reply that is not JSON or fails `check` gets one more turn
   * with the problems spelled out (the model keeps what was right and fixes the rest). json_schema
   * output is used when `outputFormat` is set and the endpoint accepts it.
   */
  private async completeJson(
    what: string,
    system: string,
    user: string,
    opts: { outputFormat?: Schema; check?: Check; deadline: Deadline },
  ): Promise<unknown> {
    const messages: Message[] = [{ role: "user", content: user }];
    let outputFormat = opts.outputFormat;
    for (let attempt = 0; ; attempt++) {
      let raw: string;
      try {
        raw = await this.complete(what, system, messages, outputFormat, opts.deadline);
      } catch (err) {
        // Some OpenAI-compatible servers reject json_schema; the prompt asks for JSON anyway.
        if (!outputFormat || !(err instanceof AppError) || (err.details as { status?: number })?.status !== 400) throw err;
        log.debug("json_schema response_format rejected, retrying without it");
        outputFormat = undefined;
        raw = await this.complete(what, system, messages, undefined, opts.deadline);
      }
      const parsed = parseJsonLoose(raw);
      const problems = parsed.ok ? opts.check?.(parsed.value) : [`not valid JSON (${parsed.error})`];
      if (!problems?.length) return (parsed as { value: unknown }).value;
      if (attempt >= 1) {
        if (!parsed.ok) throw new AppError("LLM_INVALID_OUTPUT", `LLM returned invalid JSON: ${raw.trim().slice(0, 200)}`);
        throw new AppError("LLM_INVALID_OUTPUT", `LLM output does not match the JSON Schema: ${problems.join("; ")}`, {
          errors: problems,
        });
      }
      log.debug("LLM reply rejected, asking for a correction", { what, problems });
      messages.push({ role: "assistant", content: raw }, { role: "user", content: P.extractRetry(problems) });
    }
  }

  /**
   * Extracts a JSON value from page content. With a schema, the value is validated against the
   * original schema (xsai's strict json_schema drops keywords like `allOf` / `not`), and a root array
   * schema is sent wrapped in `{ items }` because structured output needs an object at the root.
   */
  async extractJson(content: string, opts: ExtractJsonOptions, deadline: Deadline): Promise<unknown> {
    const validate = opts.schema ? compileJsonSchema(opts.schema) : undefined;
    const wrapped = opts.schema && isArraySchema(opts.schema);
    const sent = wrapped
      ? { type: "object", properties: { items: opts.schema }, required: ["items"], additionalProperties: false }
      : opts.schema;
    const unwrap = (v: unknown) => (wrapped && v && typeof v === "object" && !Array.isArray(v) ? (v as { items?: unknown }).items : v);
    const value = await this.completeJson(
      "JSON extraction",
      P.extractSystem({ systemPrompt: opts.systemPrompt, schema: sent, urls: opts.urls }),
      P.extractUser(this.fit(content).text, opts.prompt, opts.url),
      {
        outputFormat: sent,
        deadline,
        check: validate && ((v) => (validate(unwrap(v)) ? undefined : describeSchemaErrors(validate.errors))),
      },
    );
    return unwrap(value);
  }

  async summarize(content: string, deadline: Deadline, url?: string): Promise<string> {
    return this.complete("The summary format", P.SUMMARY_SYSTEM, P.summaryUser(this.fit(content).text, url), undefined, deadline);
  }

  /** Free-form answer to a question about the page. */
  async answer(content: string, question: string, deadline: Deadline, url?: string): Promise<string> {
    return this.complete("The question format", P.ANSWER_SYSTEM, P.answerUser(this.fit(content).text, question, url), undefined, deadline);
  }

  /**
   * Quotes the page lines relevant to `query`. The model only picks line numbers and the lines are
   * copied from the page, so every quote is verbatim. Highlights come most relevant first; direct
   * quote answers keep page order.
   */
  async selectLines(content: string, query: string, purpose: "highlights" | "answer", deadline: Deadline, url?: string): Promise<string> {
    const lines = content
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim());
    // Keep whole lines within the budget (numbering adds a few characters per line).
    const numbered: string[] = [];
    let size = 0;
    for (const [i, line] of lines.entries()) {
      const entry = `${i}: ${line}`;
      if (numbered.length && size + entry.length + 1 > this.maxInputChars) break;
      numbered.push(entry);
      size += entry.length + 1;
    }
    const what = purpose === "highlights" ? "The highlights format" : "The question format";
    const value = await this.completeJson(what, P.selectLinesSystem(purpose), P.selectLinesUser(numbered.join("\n"), query, url), {
      deadline,
      check: (v) => (lineIndices(v) ? undefined : ["expected a JSON array of line numbers"]),
    });
    let picked = [...new Set(lineIndices(value) ?? [])].filter((i) => i >= 0 && i < numbered.length);
    if (purpose === "answer") picked = picked.sort((a, b) => a - b);
    return picked.map((i) => lines[i]).join("\n");
  }

  /**
   * Firecrawl's prompt injection guard. Throws 403 SCRAPE_PROMPT_INJECTION_DETECTED on a detection.
   * Fails open: a chunk the classifier could not judge is skipped, and the result says whether
   * every chunk was scanned.
   */
  async checkInjection(markdown: string, deadline: Deadline): Promise<{ scannedFully: boolean }> {
    if (!markdown.trim()) return { scannedFully: true };
    const chunks: string[] = [];
    for (let i = 0; i < markdown.length; i += GUARD_CHUNK_CHARS - GUARD_CHUNK_OVERLAP) {
      chunks.push(markdown.slice(i, i + GUARD_CHUNK_CHARS));
      if (i + GUARD_CHUNK_CHARS >= markdown.length) break;
    }
    let scannedFully = true;
    for (let i = 0; i < chunks.length; i += GUARD_BATCH) {
      const verdicts = await Promise.all(chunks.slice(i, i + GUARD_BATCH).map((c) => this.classifyChunk(c, deadline)));
      const hit = verdicts.find((v) => v?.isInjection);
      if (hit) {
        throw new AppError(
          "SCRAPE_PROMPT_INJECTION_DETECTED",
          `The scraped page content appears to contain a prompt injection attempt, so the scrape was aborted for safety. Guard verdict: ${hit.reason.slice(0, 300)}`,
        );
      }
      if (verdicts.includes(undefined)) scannedFully = false;
    }
    return { scannedFully };
  }

  private async classifyChunk(content: string, deadline: Deadline): Promise<{ isInjection: boolean; reason: string } | undefined> {
    const tag = `untrusted_page_content_${randomUUID().replaceAll("-", "")}`;
    try {
      const v = await this.completeJson("Prompt injection checks", P.injectionGuardSystem(tag), P.injectionGuardUser(tag, content), {
        outputFormat: GUARD_SCHEMA,
        deadline,
        check: (v) => (isGuardVerdict(v) ? undefined : ['expected {"isInjection": boolean, "reason": string}']),
      });
      return v as { isInjection: boolean; reason: string };
    } catch (err) {
      if (deadline.signal.aborted) throw deadline.translate(err, "while checking for prompt injection");
      log.warn("prompt injection guard failed; continuing without a verdict for this chunk", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** Decides whether an extract is one answer or many entities spread over pages. */
  async planExtract(schema: Schema, prompt: string | undefined, urls: string[], deadline: Deadline): Promise<ExtractPlan> {
    const v = (await this.completeJson("Extract", P.ANALYZE_EXTRACT_SYSTEM, P.analyzeExtractUser(schema, prompt, urls), {
      outputFormat: PLAN_SCHEMA,
      deadline,
      check: (v) => {
        const p = v as Partial<ExtractPlan>;
        if (typeof p?.isMultiEntity !== "boolean" || !Array.isArray(p.multiEntityKeys)) return ["expected the plan object"];
        if (p.isMultiEntity && !p.multiEntityKeys.length) return ["isMultiEntity is true but multiEntityKeys is empty"];
        return undefined;
      },
    })) as ExtractPlan;
    return { isMultiEntity: v.isMultiEntity, multiEntityKeys: v.multiEntityKeys.filter((k) => typeof k === "string") };
  }

  /** Writes a JSON Schema for a prompt-only extract, so results from many pages share one shape. */
  async generateSchema(prompt: string, deadline: Deadline): Promise<Schema> {
    return (await this.completeJson("Extract", P.GENERATE_SCHEMA_SYSTEM, P.generateSchemaUser(prompt), {
      deadline,
      check: (v) => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return ["expected a JSON Schema object"];
        try {
          compileJsonSchema(v as Schema);
          return undefined;
        } catch (err) {
          return [err instanceof Error ? err.message : String(err)];
        }
      },
    })) as Schema;
  }

  /** Turns a natural-language crawl instruction into (unvalidated) crawl options. */
  async crawlOptions(url: string, prompt: string, deadline: Deadline): Promise<Record<string, unknown>> {
    return (await this.completeJson("Crawl prompts", P.CRAWL_OPTIONS_SYSTEM, P.crawlOptionsUser(url, prompt), {
      deadline,
      check: (v) => (v && typeof v === "object" && !Array.isArray(v) ? undefined : ["expected a JSON object"]),
    })) as Record<string, unknown>;
  }
}

function isArraySchema(schema: Schema): boolean {
  const t = schema.type;
  return t === "array" || (Array.isArray(t) && t.includes("array") && !t.includes("object"));
}

function isGuardVerdict(v: unknown): v is { isInjection: boolean; reason: string } {
  const g = v as { isInjection?: unknown; reason?: unknown };
  return !!g && typeof g.isInjection === "boolean" && typeof g.reason === "string";
}

/** Line numbers from a selection reply: a bare array, or an object wrapping one. */
function lineIndices(v: unknown): number[] | undefined {
  const arr = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v).find(Array.isArray) : undefined;
  if (!arr) return undefined;
  const nums = arr.map((x) => (typeof x === "string" && /^\d+$/.test(x) ? Number(x) : x));
  return nums.every((n) => Number.isInteger(n)) ? (nums as number[]) : undefined;
}

/** Runs `request`, waiting out 429s (and 503s with retry-after) as long as the wait fits in what `deadline` has left. */
async function withRateLimitRetries<T>(request: () => Promise<T>, deadline: Deadline): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (err) {
      if (!HttpError.isInstance(err) || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
      const retryAfter = retryAfterMs(err.headers);
      if (err.status !== 429 && !(err.status === 503 && retryAfter !== undefined)) throw err;
      const wait = retryAfter ?? RATE_LIMIT_BACKOFF_MS * 2 ** attempt;
      if (wait >= deadline.remaining()) throw err;
      const id = requestId(err.headers);
      log.warn(`LLM returned ${err.status}${id ? ` (request id ${id})` : ""}, retrying in ${wait}ms`);
      await deadline.sleep(wait, "while waiting out the LLM rate limit");
    }
  }
}

/** Reads `retry-after-ms` (OpenAI) or `retry-after` (seconds or an HTTP date). */
function retryAfterMs(headers: Headers): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function requestId(headers: Headers): string | undefined {
  return headers.get("x-request-id") ?? headers.get("request-id") ?? undefined;
}

function toLlmError(err: unknown, baseUrl: string): AppError {
  if (HttpError.isInstance(err)) {
    const id = requestId(err.headers);
    const suffix = id ? ` (request id ${id})` : "";
    if (err.status === 429) {
      const retryAfter = retryAfterMs(err.headers);
      return new AppError("LLM_RATE_LIMITED", `LLM rate limit exceeded${suffix}: ${err.body.slice(0, 500)}`, {
        status: err.status,
        requestId: id,
        retryAfterMs: retryAfter,
      });
    }
    return new AppError("LLM_ERROR", `LLM request failed (${err.status})${suffix}: ${err.body.slice(0, 500)}`, {
      status: err.status,
      requestId: id,
    });
  }
  if (XSAIError.isInstance(err)) {
    if (err.code === "network-error") {
      const cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
      return new AppError("LLM_UNAVAILABLE", `Cannot reach LLM at ${baseUrl}: ${cause}`, { code: err.code });
    }
    return new AppError("LLM_ERROR", `LLM request failed (${err.code}): ${err.message}`, { code: err.code });
  }
  return new AppError("LLM_ERROR", `LLM request failed: ${err instanceof Error ? err.message : String(err)}`);
}

/** Returns the reply text, or explains why the step did not produce a usable one. */
function resultText({ status, reason, message, text }: CollectResult): string {
  const details = { status, reason };
  const refusal =
    typeof message.content === "string"
      ? ""
      : message.content
          .filter((p) => p.type === "refusal")
          .map((p) => p.refusal)
          .join("");
  if (refusal || reason === "refusal") {
    throw new AppError("LLM_REFUSED", `LLM refused the request${refusal ? `: ${refusal.slice(0, 500)}` : ""}`, details);
  }
  if (status === "incomplete") {
    // Output cut off at the token limit cannot be repaired: the missing part was never generated.
    const why =
      reason === "length"
        ? "the output hit the token limit (ask for fewer items, or a smaller schema)"
        : reason === "content-filter"
          ? "the provider's content filter stopped it"
          : `the provider stopped early (${reason ?? "no reason given"})`;
    throw new AppError("LLM_INCOMPLETE_OUTPUT", `LLM output is incomplete: ${why}`, details);
  }
  if (status === "cancelled") throw new AppError("LLM_ERROR", "LLM provider cancelled the request", details);
  if (!text) throw new AppError("LLM_INCOMPLETE_OUTPUT", "LLM returned no content", details);
  return text;
}

/** Parses a JSON reply, tolerating markdown code fences and prose around a single object or array. */
function parseJsonLoose(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start > 0 || (start === 0 && end < trimmed.length - 1)) {
      try {
        return { ok: true, value: JSON.parse(trimmed.slice(start, end + 1)) };
      } catch {
        // Report the original error below.
      }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
