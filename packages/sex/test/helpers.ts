import { type ConfigOverrides, resolveConfig } from "../src/config.ts";
import { Engine } from "../src/engine/engine.ts";

export { CERT, KEY, startFixtureSite, startMockSearxng, textPdf, waitFor } from "@sex/core/test/helpers.ts";

/** Tokens the mock LLM reports for each call. */
export const MOCK_LLM_TOKENS = 15;

export function chatCompletionStream(content: string, opts: { finishReason?: string; refusal?: string } = {}): Response {
  const delta = opts.refusal ? { role: "assistant", refusal: opts.refusal } : { role: "assistant", content };
  const chunks = [
    { choices: [{ index: 0, delta }] },
    { choices: [{ index: 0, delta: {}, finish_reason: opts.finishReason ?? "stop" }] },
    // Every call is billed MOCK_LLM_TOKENS.
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: MOCK_LLM_TOKENS } },
  ];
  const sse = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}

/** OpenAI-compatible /chat/completions mock that records requests and answers from `reply`. */
type ChatRequest = { messages: Array<{ role: string; content: string }>; response_format?: { type: string } };

export function startMockLlm(reply: (body: ChatRequest) => string) {
  const requests: ChatRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as ChatRequest;
      requests.push(body);
      return chatCompletionStream(reply(body));
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

/** An engine for tests. Without a searxngUrl, searches fail fast instead of starting a real SearXNG. */
export function testEngine(overrides: ConfigOverrides = {}) {
  return new Engine(
    resolveConfig(
      { allowPrivateNetwork: true, concurrency: 4, timeout: 10_000, searxngUrl: "http://127.0.0.1:1", ...overrides },
      { allowPrivateNetwork: true },
      {},
    ),
  );
}
