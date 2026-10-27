import type { ConvertEngine } from "here-docs";
import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";

type HereDocs = typeof import("here-docs");

export interface DocsWarning {
  code: string;
  message: string;
}

export interface DocsResult {
  markdown: string;
  /** Pages in the whole document, for paged inputs (PDF). */
  numPages?: number;
  /** Pages actually converted; less than numPages when maxPages stopped early. */
  pagesConverted?: number;
  warnings: DocsWarning[];
}

export interface DocsConvertOptions {
  /** Format hint for inputs without a signature (e.g. CSV); never read as a path. */
  filename?: string;
  /** Stop after this many pages. */
  maxPages?: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Warnings that mean nothing could be converted at all, not a partial result. */
const UNCONVERTIBLE = new Set(["unknown-type", "unsupported"]);
const UNREADABLE = new Set(["encrypted", "malformed", "missing-part", "resource-limit", "io"]);

/**
 * PDFs, office documents and images through here-docs: structured text where the file has it, local OCR
 * where it does not. The engine (native addons plus an OCR model, ~200 MB) is started on first use and
 * shared by every request in the process; conversions run off the event loop in the native engines.
 */
export class DocsConverter {
  readonly enabled: boolean;
  private started?: Promise<{ mod: HereDocs; engine: ConvertEngine }>;

  constructor(config: Config) {
    this.enabled = config.docs;
  }

  /** Start the engine now (serve / worker), so the first document does not pay for it and a broken install fails at startup. */
  async warmup(): Promise<void> {
    if (this.enabled) await this.start();
  }

  async convert(bytes: Uint8Array, opts: DocsConvertOptions): Promise<DocsResult> {
    const { mod, engine } = await this.start();
    const deadline = AbortSignal.timeout(opts.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
    const sections: string[] = [];
    const warnings: DocsWarning[] = [];
    let numPages: number | undefined;
    let pagesConverted = 0;
    try {
      for await (const part of mod.convertPages(bytes, { engine, filename: opts.filename, signal })) {
        if (part.markdown.trim()) sections.push(part.markdown);
        warnings.push(...part.warnings);
        if (part.page === null) continue;
        numPages = part.pageCount ?? numPages;
        pagesConverted++;
        if (opts.maxPages !== undefined && pagesConverted >= opts.maxPages) break;
      }
    } catch (err) {
      if (deadline.aborted) {
        throw new AppError(408, "SCRAPE_TIMEOUT", `Timed out after ${opts.timeoutMs}ms converting the document`);
      }
      if (opts.signal?.aborted) throw new AppError(408, "TIMEOUT", "Request cancelled while converting the document");
      throw new AppError(500, "DOCUMENT_CONVERT_FAILED", `Document conversion failed: ${(err as Error).message ?? err}`);
    }

    const markdown = sections.join("\n\n");
    if (!markdown.trim()) {
      const fatal = warnings.find((w) => UNCONVERTIBLE.has(w.code));
      if (fatal) throw new AppError(415, "UNSUPPORTED_FILE", `Unsupported file: ${fatal.message}`);
      const unreadable = warnings.find((w) => UNREADABLE.has(w.code));
      if (unreadable) throw new AppError(422, "DOCUMENT_PARSE_FAILED", `Failed to parse document: ${unreadable.message}`);
    }
    return { markdown, numPages, pagesConverted: numPages === undefined ? undefined : pagesConverted, warnings };
  }

  async close(): Promise<void> {
    const started = this.started;
    this.started = undefined;
    const ready = await started?.catch(() => undefined);
    await ready?.engine.close();
  }

  private start(): Promise<{ mod: HereDocs; engine: ConvertEngine }> {
    this.started ??= (async () => {
      const t0 = performance.now();
      let mod: HereDocs;
      try {
        mod = await import("here-docs");
      } catch (err) {
        throw new AppError(
          502,
          "DOCS_UNAVAILABLE",
          `SEX_DOCS is on but here-docs could not be loaded (${(err as Error).message}). ` +
            "It needs sex run by bun from a checkout with dependencies installed (`bun src/cli.ts`) or the Docker image; " +
            "the single-file binary cannot load its native engines.",
        );
      }
      try {
        const engine = await mod.createEngine();
        log.info("document converter ready", { ms: Math.round(performance.now() - t0) });
        return { mod, engine };
      } catch (err) {
        throw new AppError(502, "DOCS_UNAVAILABLE", `here-docs could not start: ${(err as Error).message}`);
      }
    })();
    // A failed start is retried by the next request instead of being cached forever.
    this.started.catch(() => {
      this.started = undefined;
    });
    return this.started;
  }
}
