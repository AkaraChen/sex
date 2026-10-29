import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { FIXTURES } from "./bin.ts";

export { startFixtureSite, startMockSearxng } from "@searxng-js/sex-testing";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv",
};

export interface Site {
  url: string;
  /** Paths requested so far, in order. */
  hits: string[];
  stop(): void;
}

/** Serves a directory (default: the app fixtures) on 127.0.0.1, recording every requested path. */
export function staticSite(dir = FIXTURES): Site {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      hits.push(pathname);
      const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
      let file = join(dir, rel);
      try {
        if (statSync(file).isDirectory()) {
          const index = join(file, "index.html");
          try {
            statSync(index);
            file = index;
          } catch {
            // No index.html: a directory listing, like python's http.server, so the page links to every file.
            const base = pathname.endsWith("/") ? pathname : `${pathname}/`;
            const items = readdirSync(file).map((f) => `<li><a href="${base}${encodeURIComponent(f)}">${f}</a></li>`);
            return new Response(
              `<!doctype html><html><head><title>Index of ${pathname}</title></head><body><h1>Index of ${pathname}</h1><ul>${items.join("")}</ul></body></html>`,
              {
                headers: { "content-type": "text/html; charset=utf-8" },
              },
            );
          }
        }
      } catch {
        return new Response("not found", { status: 404 });
      }
      try {
        if (!statSync(file).isFile()) throw new Error("not a file");
      } catch {
        return new Response("not found", { status: 404 });
      }
      return new Response(readFileSync(file), { headers: { "content-type": TYPES[extname(file)] ?? "application/octet-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

/** A site whose every response comes from `handler`; records requested paths. */
export function site(handler: (req: Request, url: URL) => Response | Promise<Response>): Site {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      hits.push(url.pathname + url.search);
      return handler(req, url);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

/** A minimal HTML page. */
export const html = (title: string, body: string, head = "") =>
  new Response(`<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** Some paragraphs, so main-content detection has enough words. */
export const prose = (topic: string, n = 4) =>
  Array.from(
    { length: n },
    (_, i) => `<p>Paragraph ${i + 1} about ${topic}. ${"This sentence adds words for the extractor. ".repeat(4)}</p>`,
  ).join("");
