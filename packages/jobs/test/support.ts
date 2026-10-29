import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createJobBackend,
  type JobBackend,
  type JobsContext,
  MemoryDocumentLog,
  MemoryTaskQueue,
  SqliteJobStore,
  startWorker,
} from "@searxng-js/sex-jobs";
import { ExtractPool } from "@searxng-js/sex-page";
import pLimit from "p-limit";

/** A local HTTP server; `close()` also drops open connections. */
export async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export const html = (res: ServerResponse, body: string, status = 200) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(body);
};

const paragraphs = Array.from(
  { length: 4 },
  (_, i) => `<p>Paragraph ${i + 1} about the site. ${"Lorem ipsum dolor sit amet. ".repeat(8)}</p>`,
).join("");

/** A page with enough text to be extracted as the main content, linking to `links`. */
export const page = (title: string, links: string[] = []) =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><article><h1>${title}</h1>${paragraphs}${links
    .map((l) => `<a href="${l}">${l}</a>`)
    .join(" ")}</article></main></body></html>`;

/** A jobs context on a memory queue and an in-memory store: private networks allowed, no browser, LLM or SearXNG. */
export function jobsContext(extra: { webhookSecret?: string } = {}): JobsContext & { close(): Promise<void> } {
  const extractPool = new ExtractPool({ size: 0, taskTimeoutMs: 10_000 });
  const queue = new MemoryTaskQueue({ concurrency: 4 });
  const jobs: JobBackend = createJobBackend({ store: new SqliteJobStore(":memory:", 60_000, new MemoryDocumentLog()), queue });
  const ctx: JobsContext = {
    settings: { allowPrivateNetwork: true, userAgent: "sex-test", timeout: 10_000, maxBodyBytes: 10 * 1024 * 1024 },
    scrapeLimit: pLimit(4),
    searchDomainLimit: pLimit(4),
    extractPool,
    searxng: { url: async () => "http://127.0.0.1:1" },
    jobs,
    jobSettings: { concurrency: 4, extractWildcardPages: 10, webhookSecret: extra.webhookSecret },
    search: async () => ({ data: {} }),
  };
  startWorker(ctx);
  return Object.assign(ctx, {
    async close() {
      await jobs.close();
      await extractPool.close();
    },
  });
}

/** Polls until `check` returns something other than undefined. */
export async function until<T>(check: () => Promise<T | undefined> | T | undefined, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
