import { AppError, isErrorCode } from "../errors.ts";
import { log } from "../log.ts";
import type { Deadline } from "./deadline.ts";
import { extractFromHtmlInline, type PageExtractOptions, type PageExtractResult } from "./page.ts";
import { type PdfText, pdfToMarkdown } from "./pdf.ts";

// In a compiled binary, extra entrypoints are embedded relative to the common root (src/), so the worker sits under core/.
const WORKER_URL = import.meta.url.includes("$bunfs")
  ? new URL("./core/extract-worker.ts", import.meta.url).href
  : new URL("./extract-worker.ts", import.meta.url).href;

type JobMsg = { kind: "html"; html: string; opts: PageExtractOptions } | { kind: "pdf"; pdf: Uint8Array; maxPages?: number };

type WorkerReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; code?: string; message: string };

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

const closedError = () => new AppError("EXTRACT_FAILED", "Extraction pool is closed");

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

  /** Extraction stops waiting when `deadline` ends (a job already handed to a worker is abandoned and its worker replaced). */
  html(html: string, opts: PageExtractOptions, deadline: Deadline): Promise<PageExtractResult> {
    if (this.size === 0) return deadline.bound(extractFromHtmlInline(html, opts), "while extracting the page content");
    return this.run({ kind: "html", html, opts }, deadline) as Promise<PageExtractResult>;
  }

  pdf(bytes: Uint8Array, maxPages: number | undefined, deadline: Deadline): Promise<PdfText> {
    if (this.size === 0) return deadline.bound(pdfToMarkdown(bytes, maxPages), "while extracting the PDF text");
    return this.run({ kind: "pdf", pdf: bytes, maxPages }, deadline) as Promise<PdfText>;
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

  private run(msg: JobMsg, deadline: Deadline): Promise<unknown> {
    if (this.closed) return Promise.reject(closedError());
    const what = msg.kind === "pdf" ? "while extracting the PDF text" : "while extracting the page content";
    return new Promise((resolve, reject) => {
      if (deadline.signal.aborted) return reject(deadline.translate(undefined, what));
      const onAbort = () => this.abort(job, deadline.translate(undefined, what) as AppError);
      // Whichever way the job ends, it stops listening.
      const settle =
        <T>(fn: (value: T) => void) =>
        (value: T) => {
          deadline.signal.removeEventListener("abort", onAbort);
          fn(value);
        };
      const job: Job = { id: this.nextId++, msg, resolve: settle(resolve), reject: settle(reject) };
      deadline.signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      this.dispatch();
    });
  }

  /** The deadline ended: drop the job from the queue, or stop the worker that is running it (the work is CPU-bound, so only terminating it stops it). */
  private abort(job: Job, err: AppError): void {
    const queued = this.queue.indexOf(job);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      job.reject(err);
      return;
    }
    const slot = this.slots.find((s) => s.job === job);
    if (slot) this.drop(slot, err);
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
          this.queue.shift()?.reject(new AppError("EXTRACT_FAILED", `Could not start extraction worker: ${msg}`));
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
      this.drop(slot, new AppError("EXTRACT_FAILED", `Extraction worker failed: ${e.message || "unknown error"}`));
    return slot;
  }

  private assign(slot: Slot, job: Job): void {
    slot.job = job;
    job.timer = setTimeout(() => {
      this.drop(slot, new AppError("EXTRACT_TIMEOUT", `Content extraction took longer than ${this.taskTimeoutMs}ms`));
    }, this.taskTimeoutMs);
    slot.worker.postMessage({ id: job.id, ...job.msg });
  }

  private onReply(slot: Slot, reply: WorkerReply): void {
    const job = slot.job;
    if (!job || job.id !== reply.id) return;
    clearTimeout(job.timer);
    slot.job = undefined;
    if (reply.ok) job.resolve(reply.result);
    else job.reject(new AppError(isErrorCode(reply.code) ? reply.code : "EXTRACT_FAILED", reply.message));
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
