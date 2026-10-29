import { bin } from "../lib/bin.ts";
import type { ChatRequest } from "../lib/llm.ts";
import { type ApiResponse, api, type Env, type Server, serve, until } from "../lib/proc.ts";
import { tempDir } from "../lib/tmp.ts";

/** Starts `sex serve` with a private data directory and `--allow-private-network` (the fixtures are on loopback). */
export async function startSex(
  args: string[] = [],
  opts: { env?: Env; privateNetwork?: boolean; dataDir?: string | false; startupMs?: number } = {},
): Promise<Server> {
  const flags = [...args];
  if (opts.privateNetwork !== false) flags.push("--allow-private-network");
  if (opts.dataDir !== false) flags.push("--data-dir", opts.dataDir ?? tempDir());
  return serve(bin("sex"), flags, { env: opts.env, startupMs: opts.startupMs ?? 90_000 });
}

/** POST /v2/scrape. */
export const scrape = (srv: { url: string }, body: Record<string, unknown>): Promise<ApiResponse> => api(srv.url, "/v2/scrape", { body });

/** Flags that point sex at a mock LLM. */
export const llmFlags = (llm: { url: string }, extra: string[] = []): string[] => [
  "--llm-model",
  "test-model",
  "--llm-base-url",
  llm.url,
  "--llm-api-key",
  "test-key",
  ...extra,
];

/** The system prompt of a chat request (the first message). */
export const systemOf = (req: ChatRequest): string => req.messages.find((m) => m.role === "system")?.content ?? "";

/** The last user message of a chat request. */
export const userOf = (req: ChatRequest): string => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";

/** Which kind of call a request is, by its system prompt. */
export type CallKind = "guard" | "extract" | "summary" | "answer" | "lines" | "plan" | "schema" | "links" | "crawl" | "changes" | "other";

export function kindOf(req: ChatRequest): CallKind {
  const s = systemOf(req);
  if (s.includes("security classifier")) return "guard";
  if (s.includes("classify data extraction requests")) return "plan";
  if (s.includes("write the JSON Schema for a web data extraction")) return "schema";
  if (s.includes("You summarize web pages")) return "summary";
  if (s.includes("You answer questions about a web page")) return "answer";
  if (s.includes("You extract structured data")) return "extract";
  if (s.includes("You select lines from a web page")) return "lines";
  if (s.includes("You configure a web crawler")) return "crawl";
  if (s.includes("You pick the pages of a website")) return "links";
  if (s.includes("You compare two versions")) return "changes";
  return "other";
}

const FINAL = new Set(["completed", "failed", "cancelled"]);

/** Polls a job's status route until it is finished; returns the last status body. */
export async function waitJob(srv: { url: string }, path: string, timeoutMs = 90_000): Promise<any> {
  return until(
    async () => {
      const r = await api(srv.url, path);
      if (r.status !== 200) throw new Error(`${path} -> ${r.status} ${JSON.stringify(r.body)}`);
      return FINAL.has(r.body.status) ? r.body : undefined;
    },
    timeoutMs,
    150,
  );
}

/** Follows `next` from a status route and returns every document in order, plus the number of pages read. */
export async function readAllDocs(srv: { url: string }, path: string, limit?: number): Promise<{ docs: any[]; pages: number; last: any }> {
  let url: string | null = new URL(limit ? `${path}?limit=${limit}` : path, srv.url).href;
  const docs: any[] = [];
  let pages = 0;
  let last: any;
  while (url) {
    const r: ApiResponse = await api(srv.url, url.replace(srv.url, ""));
    if (r.status !== 200) throw new Error(`${url} -> ${r.status}`);
    pages++;
    docs.push(...r.body.data);
    last = r.body;
    url = r.body.next ?? null;
    if (pages > 1000) throw new Error("next never ends");
  }
  return { docs, pages, last };
}

export const sourceUrls = (docs: any[]): string[] => docs.map((d) => d.metadata.sourceURL as string);
