import { chat, generateText, HttpError, type JSONSchema7, type LanguageModel, XSAIError } from "xsai";
import type { Config } from "../config.ts";
import { AppError, llmRequired } from "../errors.ts";
import { log } from "../log.ts";

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
    const { llmTimeout } = this.config;
    const deadline = AbortSignal.timeout(llmTimeout);
    let text: string;
    try {
      ({ text } = await generateText(this.model, {
        instructions,
        input,
        outputFormat: outputFormat as JSONSchema7 | undefined,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      }));
    } catch (err) {
      if (deadline.aborted) throw new AppError(408, "TIMEOUT", `LLM request timed out after ${llmTimeout}ms`);
      if (signal?.aborted) throw new AppError(408, "TIMEOUT", "LLM request cancelled");
      if (err instanceof HttpError) {
        throw new AppError(502, "LLM_ERROR", `LLM request failed (${err.status}): ${err.body.slice(0, 500)}`, { status: err.status });
      }
      if (err instanceof XSAIError && err.code === "network-error") {
        const cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
        throw new AppError(502, "LLM_UNAVAILABLE", `Cannot reach LLM at ${llm.baseUrl}: ${cause}`);
      }
      throw new AppError(502, "LLM_ERROR", `LLM request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!text) throw new AppError(502, "LLM_ERROR", "LLM returned no content");
    return text;
  }

  private clip(content: string): string {
    return content.length > this.maxInputChars ? `${content.slice(0, this.maxInputChars)}\n\n[truncated]` : content;
  }

  /** Extracts a JSON value from page content, using json_schema output when the endpoint supports it. */
  async extractJson(
    content: string,
    opts: { prompt?: string; schema?: Record<string, unknown>; systemPrompt?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
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
    return parseJsonLoose(raw);
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
