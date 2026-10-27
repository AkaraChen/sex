import { setTimeout as sleep } from "node:timers/promises";
import { type CollectResult, chat, generateText, HttpError, type JSONSchema7, type LanguageModel, XSAIError } from "xsai";
import type { Config } from "../config.ts";
import { AppError, llmRequired } from "../errors.ts";
import { log } from "../log.ts";
import { compileJsonSchema, describeSchemaErrors } from "./json-schema.ts";

/** Retries after a 429 (or a 503 that says when to come back); xsai itself never retries. */
const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BACKOFF_MS = 1000;

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

  private async complete(
    what: string,
    instructions: string,
    input: string,
    outputFormat?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const llm = this.require(what);
    this.model ??= chat({ baseURL: llm.baseUrl, apiKey: llm.apiKey, model: llm.model });
    const model = this.model;
    // One deadline covers every attempt, including time spent waiting out rate limits.
    const { llmTimeout } = this.config;
    const deadline = AbortSignal.timeout(llmTimeout);
    const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const deadlineAt = Date.now() + llmTimeout;
    let result: CollectResult;
    try {
      result = await withRateLimitRetries(
        () => generateText(model, { instructions, input, outputFormat: outputFormat as JSONSchema7 | undefined, signal: sig }),
        deadlineAt,
        sig,
      );
    } catch (err) {
      if (deadline.aborted) throw new AppError(408, "TIMEOUT", `LLM request timed out after ${llmTimeout}ms`);
      if (signal?.aborted) throw new AppError(408, "TIMEOUT", "LLM request cancelled");
      throw toLlmError(err, llm.baseUrl);
    }
    return resultText(result);
  }

  private clip(content: string): string {
    return content.length > this.maxInputChars ? `${content.slice(0, this.maxInputChars)}\n\n[truncated]` : content;
  }

  /**
   * Extracts a JSON value from page content, using json_schema output when the endpoint supports it.
   * With a schema, the parsed value is validated against it: xsai returns text, and providers (or the
   * fallback without response_format) do not guarantee conformance.
   */
  async extractJson(
    content: string,
    opts: { prompt?: string; schema?: Record<string, unknown>; systemPrompt?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const validate = opts.schema ? compileJsonSchema(opts.schema) : undefined;
    const system = [
      opts.systemPrompt ??
        "You extract structured data from web page content. Use only information present in the content. Use null for values that are not present.",
      "Respond with a single JSON value and nothing else.",
      opts.schema ? `The JSON must conform to this JSON Schema:\n${JSON.stringify(opts.schema)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const user = `${opts.prompt ? `Instructions: ${opts.prompt}\n\n` : ""}Content:\n${this.clip(content)}`;
    let raw: string;
    if (opts.schema) {
      try {
        raw = await this.complete("JSON extraction", system, user, opts.schema, signal);
      } catch (err) {
        // Some OpenAI-compatible servers reject json_schema; the schema is in the prompt anyway.
        if (!(err instanceof AppError) || (err.details as { status?: number })?.status !== 400) throw err;
        log.debug("json_schema response_format rejected, retrying without it");
        raw = await this.complete("JSON extraction", system, user, undefined, signal);
      }
    } else {
      raw = await this.complete("JSON extraction", system, user, undefined, signal);
    }
    const value = parseJsonLoose(raw);
    if (validate && !validate(value)) {
      const errors = describeSchemaErrors(validate.errors);
      throw new AppError(502, "LLM_INVALID_OUTPUT", `LLM output does not match the JSON Schema: ${errors.join("; ")}`, { errors });
    }
    return value;
  }

  async summarize(content: string, signal?: AbortSignal): Promise<string> {
    return this.complete(
      "The summary format",
      "Summarize the web page content concisely in a few sentences, in the page's language.",
      this.clip(content),
      undefined,
      signal,
    );
  }

  async answer(content: string, question: string, signal?: AbortSignal): Promise<string> {
    return this.complete(
      "The question format",
      "Answer the question using only the web page content. Say so if the content does not contain the answer.",
      `Question: ${question}\n\nContent:\n${this.clip(content)}`,
      undefined,
      signal,
    );
  }

  async highlights(content: string, query: string, signal?: AbortSignal): Promise<string> {
    return this.complete(
      "The highlights format",
      "Quote the passages of the web page content most relevant to the query verbatim, one per line, most relevant first. Output only quotes.",
      `Query: ${query}\n\nContent:\n${this.clip(content)}`,
      undefined,
      signal,
    );
  }

  /** Free-form JSON completion used for helpers such as crawl prompt -> options. */
  async json(what: string, system: string, user: string, signal?: AbortSignal): Promise<unknown> {
    const raw = await this.complete(what, `${system}\n\nRespond with a single JSON object and nothing else.`, user, undefined, signal);
    return parseJsonLoose(raw);
  }
}

/** Runs `request`, waiting out 429s (and 503s with retry-after) as long as the wait fits before `deadlineAt`. */
async function withRateLimitRetries<T>(request: () => Promise<T>, deadlineAt: number, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (err) {
      if (!HttpError.isInstance(err) || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
      const retryAfter = retryAfterMs(err.headers);
      if (err.status !== 429 && !(err.status === 503 && retryAfter !== undefined)) throw err;
      const wait = retryAfter ?? RATE_LIMIT_BACKOFF_MS * 2 ** attempt;
      if (Date.now() + wait >= deadlineAt) throw err;
      const id = requestId(err.headers);
      log.warn(`LLM returned ${err.status}${id ? ` (request id ${id})` : ""}, retrying in ${wait}ms`);
      await sleep(wait, undefined, { signal });
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
      return new AppError(429, "LLM_RATE_LIMITED", `LLM rate limit exceeded${suffix}: ${err.body.slice(0, 500)}`, {
        status: err.status,
        requestId: id,
        retryAfterMs: retryAfter,
      });
    }
    return new AppError(502, "LLM_ERROR", `LLM request failed (${err.status})${suffix}: ${err.body.slice(0, 500)}`, {
      status: err.status,
      requestId: id,
    });
  }
  if (XSAIError.isInstance(err)) {
    if (err.code === "network-error") {
      const cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
      return new AppError(502, "LLM_UNAVAILABLE", `Cannot reach LLM at ${baseUrl}: ${cause}`, { code: err.code });
    }
    return new AppError(502, "LLM_ERROR", `LLM request failed (${err.code}): ${err.message}`, { code: err.code });
  }
  return new AppError(502, "LLM_ERROR", `LLM request failed: ${err instanceof Error ? err.message : String(err)}`);
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
    throw new AppError(502, "LLM_REFUSED", `LLM refused the request${refusal ? `: ${refusal.slice(0, 500)}` : ""}`, details);
  }
  if (status === "incomplete") {
    const why =
      reason === "length"
        ? "the output hit the token limit"
        : reason === "content-filter"
          ? "the provider's content filter stopped it"
          : `the provider stopped early (${reason ?? "no reason given"})`;
    throw new AppError(502, "LLM_ERROR", `LLM output is incomplete: ${why}`, details);
  }
  if (status === "cancelled") throw new AppError(502, "LLM_ERROR", "LLM provider cancelled the request", details);
  if (!text) throw new AppError(502, "LLM_ERROR", "LLM returned no content", details);
  return text;
}

function parseJsonLoose(raw: string): unknown {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new AppError(502, "LLM_ERROR", `LLM returned invalid JSON: ${trimmed.slice(0, 200)}`);
  }
}
