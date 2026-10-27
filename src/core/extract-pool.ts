import { AppError } from "../errors.ts";
import { log } from "../log.ts";
import { extractFromHtmlInline, type PageExtractOptions, type PageExtractResult } from "./page.ts";
import { type PdfText, pdfToMarkdown } from "./pdf.ts";

// In a compiled binary, extra entrypoints are embedded relative to the common root (src/), so the worker sits under core/.
const WORKER_URL = import.meta.url.includes("$bunfs")
  ? new URL("./core/extract-worker.ts", import.meta.url).href
  : new URL("./extract-worker.ts", import.meta.url).href;

type JobMsg = { kind: "html"; html: string; opts: PageExtractOptions } | { kind: "pdf"; pdf: Uint8Array; maxPages?: number };

type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; status?: number; code?: string; message: string };

interface Job {
  id: number;
  msg: JobMsg;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Slot {
  worker: Worker;
  job?: Job;
}

const closedError = () => new AppError(500, "EXTRACT_FAILED", "Extraction pool is closed");

/**
 * Runs HTML and PDF extraction in worker threads so a large page cannot block the event loop.
 * Size 0 runs everything inline on the calling thread.
 */
export class ExtractPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private nextId = 1;
  private closed = false;

  constructor(
    readonly size: number,
    readonly taskTimeoutMs: number,
  ) {}

  html(html: string, opts: PageExtractOptions): Promise<PageExtractResult> {
    if (this.size === 0) return extractFromHtmlInline(html, opts);
    return this.run({ kind: "html", html, opts }) as Promise<PageExtractResult>;
  }

  pdf(bytes: Uint8Array, maxPages?: number): Promise<PdfText> {
    if (this.size === 0) return pdfToMarkdown(bytes, maxPages);
    return this.run({ kind: "pdf", pdf: bytes, maxPages }) as Promise<PdfText>;
  }

  async close(): Promise<void> {
    this.closed = true;
    const err = closedError();
    for (const job of this.queue.splice(0)) job.reject(err);
    for (const slot of this.slots.splice(0)) {
      slot.worker.terminate();
      if (slot.job) {
        clearTimeout(slot.job.timer);
        slot.job.reject(err);
        slot.job = undefined;
      }
    }
  }

  private run(msg: JobMsg): Promise<unknown> {
    if (this.closed) return Promise.reject(closedError());
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, msg, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      let slot = this.slots.find((s) => s.job === undefined);
      if (!slot) {
        if (this.slots.length >= this.size) return;
        try {
          slot = this.spawn();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.queue.shift()?.reject(new AppError(500, "EXTRACT_FAILED", `Could not start extraction worker: ${msg}`));
          continue;
        }
      }
      const job = this.queue.shift();
      if (job) this.assign(slot, job);
    }
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_URL);
    const slot: Slot = { worker };
    this.slots.push(slot);
    worker.onmessage = (e: MessageEvent<WorkerReply>) => this.onReply(slot, e.data);
    worker.onerror = (e: ErrorEvent) =>
      this.drop(slot, new AppError(500, "EXTRACT_FAILED", `Extraction worker failed: ${e.message || "unknown error"}`));
    return slot;
  }

  private assign(slot: Slot, job: Job): void {
    slot.job = job;
    job.timer = setTimeout(() => {
      this.drop(slot, new AppError(422, "EXTRACT_TIMEOUT", `Content extraction took longer than ${this.taskTimeoutMs}ms`));
    }, this.taskTimeoutMs);
    slot.worker.postMessage({ id: job.id, ...job.msg });
  }

  private onReply(slot: Slot, reply: WorkerReply): void {
    const job = slot.job;
    if (!job || job.id !== reply.id) return;
    clearTimeout(job.timer);
    slot.job = undefined;
    if (reply.ok) job.resolve(reply.result);
    else job.reject(new AppError(reply.status ?? 500, reply.code ?? "EXTRACT_FAILED", reply.message));
    this.dispatch();
  }

  /** Remove a worker that timed out or crashed, fail its job, and let the queue start a replacement. */
  private drop(slot: Slot, err: AppError): void {
    if (!this.slots.includes(slot)) return;
    this.slots = this.slots.filter((s) => s !== slot);
    slot.worker.terminate();
    log.warn("extraction worker replaced", { code: err.code, reason: err.message });
    const job = slot.job;
    slot.job = undefined;
    if (job) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    this.dispatch();
  }
}
