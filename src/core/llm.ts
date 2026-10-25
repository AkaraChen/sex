import type { Config } from "../config.ts";
import { AppError, llmRequired } from "../errors.ts";
import { log } from "../log.ts";

interface Message {
  role: "system" | "user";
  content: string;
}

type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict: false } };

/** Minimal client for any OpenAI-compatible /chat/completions endpoint. */
export class Llm {
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

  private async complete(what: string, messages: Message[], responseFormat?: ResponseFormat, signal?: AbortSignal): Promise<string> {
    const llm = this.require(what);
    const { llmTimeout } = this.config;
    const deadline = AbortSignal.timeout(llmTimeout);
    const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const timedOut = (): AppError | undefined => {
      if (deadline.aborted) return new AppError(408, "TIMEOUT", `LLM request timed out after ${llmTimeout}ms`);
      if (signal?.aborted) return new AppError(408, "TIMEOUT", "LLM request cancelled");
      return undefined;
    };
    let res: Response;
    try {
      res = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: llm.model, messages, ...(responseFormat ? { response_format: responseFormat } : {}) }),
        signal: sig,
      });
    } catch (err) {
      const t = timedOut();
      if (t) throw t;
      const reason = err instanceof Error ? err.message : String(err);
      throw new AppError(502, "LLM_UNAVAILABLE", `Cannot reach LLM at ${llm.baseUrl}: ${reason}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AppError(502, "LLM_ERROR", `LLM request failed (${res.status}): ${text.slice(0, 500)}`, { status: res.status });
    }
    let body: { choices?: Array<{ message?: { content?: string } }> };
    try {
      body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    } catch {
      const t = timedOut();
      if (t) throw t;
      throw new AppError(502, "LLM_ERROR", "LLM returned a non-JSON response");
    }
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new AppError(502, "LLM_ERROR", "LLM returned no content");
    return content;
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
    const messages: Message[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    let raw: string;
    if (opts.schema) {
      try {
        raw = await this.complete(
          "JSON extraction",
          messages,
          { type: "json_schema", json_schema: { name: "extract", schema: opts.schema, strict: false } },
          signal,
        );
      } catch (err) {
        // Some OpenAI-compatible servers reject json_schema; the schema is in the prompt anyway.
        if (!(err instanceof AppError) || (err.details as { status?: number })?.status !== 400) throw err;
        log.debug("json_schema response_format rejected, retrying with json_object");
        raw = await this.complete("JSON extraction", messages, { type: "json_object" }, signal);
      }
    } else {
      raw = await this.complete("JSON extraction", messages, { type: "json_object" }, signal);
    }
    return parseJsonLoose(raw);
  }

  async summarize(content: string, signal?: AbortSignal): Promise<string> {
    return this.complete(
      "The summary format",
      [
        { role: "system", content: "Summarize the web page content concisely in a few sentences, in the page's language." },
        { role: "user", content: this.clip(content) },
      ],
      undefined,
      signal,
    );
  }

  async answer(content: string, question: string, signal?: AbortSignal): Promise<string> {
    return this.complete(
      "The question format",
      [
        {
          role: "system",
          content: "Answer the question using only the web page content. Say so if the content does not contain the answer.",
        },
        { role: "user", content: `Question: ${question}\n\nContent:\n${this.clip(content)}` },
      ],
      undefined,
      signal,
    );
  }

  async highlights(content: string, query: string, signal?: AbortSignal): Promise<string> {
    return this.complete(
      "The highlights format",
      [
        {
          role: "system",
          content:
            "Quote the passages of the web page content most relevant to the query verbatim, one per line, most relevant first. Output only quotes.",
        },
        { role: "user", content: `Query: ${query}\n\nContent:\n${this.clip(content)}` },
      ],
      undefined,
      signal,
    );
  }

  /** Free-form JSON completion used for helpers such as crawl prompt -> options. */
  async json(what: string, system: string, user: string, signal?: AbortSignal): Promise<unknown> {
    const raw = await this.complete(
      what,
      [
        { role: "system", content: `${system}\n\nRespond with a single JSON object and nothing else.` },
        { role: "user", content: user },
      ],
      { type: "json_object" },
      signal,
    );
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
