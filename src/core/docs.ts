import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ConvertEngine } from "here-docs";
import type { Config } from "../config.ts";
import { AppError } from "../errors.ts";
import { log } from "../log.ts";

type HereDocs = typeof import("here-docs");

/**
 * here-docs and its native engines embedded in the compiled binary by `scripts/build.ts`: node_modules-relative path ->
 * embedded file. Native libraries can only be loaded from real files, so they are extracted once per build (`digest`).
 */
let embedded: { digest: string; files: Record<string, string> } | undefined;

export function registerEmbeddedDocs(digest: string, files: Record<string, string>): void {
  embedded = { digest, files };
}

/** Writes the embedded node_modules tree to $XDG_CACHE_HOME/sex/docs-<digest> (once) and returns that directory. */
async function extractEmbedded(bundle: { digest: string; files: Record<string, string> }): Promise<string> {
  const root = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sex", `docs-${bundle.digest}`);
  if (existsSync(join(root, ".complete"))) return root;
  const t0 = performance.now();
  // Extract beside the target and rename, so an interrupted extraction is never mistaken for a complete one.
  const tmp = `${root}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const [rel, src] of Object.entries(bundle.files)) {
    const dest = join(tmp, "node_modules", rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, await Bun.file(src).bytes());
  }
  writeFileSync(join(tmp, ".complete"), "");
  try {
    renameSync(tmp, root);
  } catch (err) {
    // Another sex process finished the same extraction first.
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(join(root, ".complete"))) throw err;
  }
  log.info("here-docs extracted", { dir: root, files: Object.keys(bundle.files).length, ms: Math.round(performance.now() - t0) });
  return root;
}

async function loadHereDocs(): Promise<HereDocs> {
  if (!embedded) return import("here-docs");
  return import(Bun.resolveSync("here-docs", `${await extractEmbedded(embedded)}/`));
}

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
        mod = await loadHereDocs();
      } catch (err) {
        throw new AppError(502, "DOCS_UNAVAILABLE", `SEX_DOCS is on but here-docs could not be loaded: ${(err as Error).message}`);
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
