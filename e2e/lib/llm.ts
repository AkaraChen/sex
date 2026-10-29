/** An OpenAI-compatible `/v1/chat/completions` mock (streaming and not). `reply` decides each answer. */
export interface ChatRequest {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: string }>;
  response_format?: { type: string; json_schema?: { schema?: unknown } };
}

export type Reply = string | { status: number; body?: unknown; headers?: Record<string, string> } | { delayMs: number; content: string };

export function startMockLlm(reply: (req: ChatRequest, n: number) => Reply | Promise<Reply>) {
  const requests: ChatRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as ChatRequest;
      requests.push(body);
      let r = await reply(body, requests.length);
      if (typeof r === "object" && "delayMs" in r) {
        await Bun.sleep(r.delayMs);
        r = r.content;
      }
      if (typeof r === "object")
        return Response.json(r.body ?? { error: { message: "mock error" } }, { status: r.status, headers: r.headers });
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (!body.stream) {
        return Response.json({
          id: "x",
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: r }, finish_reason: "stop" }],
          usage,
        });
      }
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", content: r } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage },
      ];
      const sse = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}
