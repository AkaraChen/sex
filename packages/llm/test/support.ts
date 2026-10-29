import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A /chat/completions streaming answer (what xsai asks for); every call is billed 15 tokens. */
export function chatCompletionStream(content: string, opts: { finishReason?: string; refusal?: string } = {}): Response {
  const delta = opts.refusal ? { role: "assistant", refusal: opts.refusal } : { role: "assistant", content };
  const chunks = [
    { choices: [{ index: 0, delta }] },
    { choices: [{ index: 0, delta: {}, finish_reason: opts.finishReason ?? "stop" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  const sse = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(sse, { headers: { "content-type": "text/event-stream" } });
}

export interface ChatBody {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type: string };
}

export type Handler = (body: ChatBody, attempt: number) => Response | Promise<Response>;

/** An OpenAI-compatible endpoint driven by `handler`; records the request bodies. `stop()` also drops open connections. */
export async function startLlm(handler: Handler) {
  const bodies: ChatBody[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as ChatBody);
      const answer = await handler(bodies.at(-1) as ChatBody, bodies.length);
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    bodies,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The time a caller gives a call: a signal that ends it and the epoch ms at which it ends. */
export const within = (ms: number) => ({ signal: AbortSignal.timeout(ms), deadlineAt: Date.now() + ms });

/** Whether every field of `expected` is in `actual`, recursively (objects) and by equality (everything else). */
export function matches(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object") return false;
    return Object.entries(expected).every(([k, v]) => matches((actual as Record<string, unknown>)[k], v));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}
