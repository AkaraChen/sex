import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ExtractPool } from "@searxng-js/sex-page";
import type { ScrapeCapabilities, ScrapeContext, ScrapeExtras, ScrapeSettings } from "@searxng-js/sex-scrape";
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

/** A scrape context: private networks allowed, extraction on the calling thread, only the capabilities given. */
export function scrapeContext(
  caps: ScrapeCapabilities = {},
  settings: Partial<ScrapeSettings> = {},
  extras: ScrapeExtras = {},
): ScrapeContext & { close(): Promise<void> } {
  const extractPool = new ExtractPool({ size: 0, taskTimeoutMs: 10_000 });
  return {
    settings: { allowPrivateNetwork: true, userAgent: "sex-test", timeout: 10_000, maxBodyBytes: 10 * 1024 * 1024, ...settings },
    scrapeLimit: pLimit(4),
    extractPool,
    ...caps,
    ...extras,
    close: () => extractPool.close(),
  };
}

export type { IncomingMessage, ServerResponse };
