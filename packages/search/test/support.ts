import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ExtractPool } from "@searxng-js/sex-page";
import type { SearchContext } from "@searxng-js/sex-search";
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

export const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

/** A search context over a SearXNG at `searxngUrl`: private networks allowed, extraction on the calling thread, no capabilities. */
export function searchContext(
  searxngUrl: string,
  settings: Partial<SearchContext["settings"]> = {},
): SearchContext & { close(): Promise<void> } {
  const extractPool = new ExtractPool({ size: 0, taskTimeoutMs: 10_000 });
  return {
    settings: { allowPrivateNetwork: true, userAgent: "sex-test", timeout: 10_000, maxBodyBytes: 10 * 1024 * 1024, ...settings },
    scrapeLimit: pLimit(4),
    searchDomainLimit: pLimit(4),
    extractPool,
    searxng: { url: async () => searxngUrl },
    close: () => extractPool.close(),
  };
}
