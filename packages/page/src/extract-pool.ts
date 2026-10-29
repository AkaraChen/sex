import { Worker } from "node:worker_threads";
import { AppError, isErrorCode } from "@searxng-js/sex-errors";
import { log } from "./log.ts";
import { extractFromHtmlInline, type PageExtractOptions, type PageExtractResult } from "./page.ts";
import { type PdfText, pdfToMarkdown } from "./pdf.ts";

/**
 * Where the worker module is. Next to this file in `dist/` (built as a second entry) and in `src/`; in a compiled Bun binary
 * extra entrypoints are embedded relative to the build's --root (the repo root), so it sits under packages/page/src/ (the
 * build scripts of sex and sex-lite both pass that root).
 */
function defaultWorkerUrl(): URL {
  const here = import.meta.url;
  if (here.includes("$bunfs")) return new URL("./packages/page/src/extract-worker.ts", here);
  return new URL(here.endsWith(".ts") ? "./extract-worker.ts" : "./extract-worker.js", here);
}

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

export interface ExtractPoolOptions {
  /** Worker threads; 0 runs everything on the calling thread. */
  size: number;
  /** A job that a worker has had this long is abandoned (`EXTRACT_TIMEOUT`) and its worker replaced. */
  taskTimeoutMs: number;
  /** The worker module; by default `extract-worker.js` next to this file (`.ts` when running from source). */
  workerUrl?: URL | string;
}

/** The error for an aborted `signal`: time ran out (`TimeoutError`) or the caller cancelled. */
function abortError(signal: AbortSignal, what: string): AppError {
  const reason = signal.reason as { name?: string } | undefined;
  if (reason?.name === "TimeoutError") return new AppError("SCRAPE_TIMEOUT", `Timed out ${what}`);
  return new AppError("TIMEOUT", `Request cancelled ${what}`);
}

/** Settles with `promise`, or with the abort error as soon as `signal` aborts, even though the work behind `promise` cannot be interrupted. */
function bound<T>(promise: Promise<T>, signal: AbortSignal | undefined, what: string): Promise<T> {
  promise.catch(() => {});
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const done = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      done();
      reject(abortError(signal, what));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        done();
        resolve(v);
      },
      (e) => {
        done();
        reject(signal.aborted ? abortError(signal, what) : e);
      },
    );
  });
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

  readonly size: number;
  readonly taskTimeoutMs: number;
  private readonly workerUrl: URL | string;

  constructor(options: ExtractPoolOptions) {
    this.size = options.size;
    this.taskTimeoutMs = options.taskTimeoutMs;
    this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
  }

  /**
   * Extraction stops waiting when `signal` aborts (a job already handed to a worker is abandoned and its worker replaced).
   * An abort is `SCRAPE_TIMEOUT` when the signal's reason is a `TimeoutError`, `TIMEOUT` (cancelled) otherwise.
   */
  html(html: string, opts: PageExtractOptions, signal?: AbortSignal): Promise<PageExtractResult> {
    if (this.size === 0) return bound(extractFromHtmlInline(html, opts), signal, "while extracting the page content");
    return this.run({ kind: "html", html, opts }, signal) as Promise<PageExtractResult>;
  }

  pdf(bytes: Uint8Array, maxPages?: number, signal?: AbortSignal): Promise<PdfText> {
    if (this.size === 0) return bound(pdfToMarkdown(bytes, maxPages), signal, "while extracting the PDF text");
    return this.run({ kind: "pdf", pdf: bytes, maxPages }, signal) as Promise<PdfText>;
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

  private run(msg: JobMsg, signal: AbortSignal | undefined): Promise<unknown> {
    if (this.closed) return Promise.reject(closedError());
    const what = msg.kind === "pdf" ? "while extracting the PDF text" : "while extracting the page content";
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal, what));
      const onAbort = () => this.abort(job, abortError(signal as AbortSignal, what));
      // Whichever way the job ends, it stops listening.
      const settle =
        <T>(fn: (value: T) => void) =>
        (value: T) => {
          signal?.removeEventListener("abort", onAbort);
          fn(value);
        };
      const job: Job = { id: this.nextId++, msg, resolve: settle(resolve), reject: settle(reject) };
      signal?.addEventListener("abort", onAbort, { once: true });
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
    const worker = new Worker(this.workerUrl);
    const slot: Slot = { worker };
    this.slots.push(slot);
    worker.on("message", (reply: WorkerReply) => this.onReply(slot, reply));
    worker.on("error", (e: Error) =>
      this.drop(slot, new AppError("EXTRACT_FAILED", `Extraction worker failed: ${e.message || "unknown error"}`)),
    );
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
