import { AppError, type ErrorCode } from "./errors.ts";

export interface DeadlineOptions {
  /** Cancellation from the caller (client disconnected, job cancelled). It ends the deadline early and is reported as `TIMEOUT`. */
  signal?: AbortSignal;
  /** The error code when the time runs out. Defaults to `SCRAPE_TIMEOUT`. */
  expiredCode?: ErrorCode;
}

/**
 * The time one operation (a scrape, a search, a map) has left, plus the caller's cancellation, as one object that every
 * step of the operation receives. Steps no longer take a `timeout` and a `signal` and build their own `AbortSignal.timeout`:
 *
 * - `signal` is what to hand to fetch, puppeteer, here-docs and the LLM client; it aborts when the time is up or the caller cancels.
 * - `remaining()` is for APIs that want a number (`page.goto({ timeout })`) and for deciding whether another try fits.
 * - `slice(ms)` gives a step a budget of its own that can never outlast the whole.
 * - `translate(err)` turns whatever a step threw after the abort ("Target closed", an `AbortError`, ...) into the one right
 *   error: `SCRAPE_TIMEOUT` when the deadline ran out, `TIMEOUT` when the caller cancelled.
 *
 * Create one per operation, at the top; pass it down. Everything below `Deadline.start` only slices and translates.
 */
export class Deadline {
  readonly signal: AbortSignal;
  /** Epoch ms at which this deadline ends; Infinity when it has no time limit of its own. */
  private readonly endsAt: number;
  /** What fires when this deadline's own time runs out (not set on unbounded deadlines and on slices that share their parent's end). */
  private readonly timer: AbortSignal | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly caller: AbortSignal | undefined;
  private readonly parent: Deadline | undefined;
  private readonly expiredCode: ErrorCode;

  private constructor(
    endsAt: number,
    timer: AbortSignal | undefined,
    timeoutMs: number | undefined,
    caller: AbortSignal | undefined,
    parent: Deadline | undefined,
    expiredCode: ErrorCode,
  ) {
    this.endsAt = endsAt;
    this.timer = timer;
    this.timeoutMs = timeoutMs;
    this.caller = caller;
    this.parent = parent;
    this.expiredCode = expiredCode;
    this.signal = AbortSignal.any([...(caller ? [caller] : []), ...(timer ? [timer] : []), ...(parent ? [parent.signal] : [])]);
  }

  /** A deadline that ends `timeoutMs` from now. */
  static start(timeoutMs: number, opts: DeadlineOptions = {}): Deadline {
    return new Deadline(
      Date.now() + timeoutMs,
      AbortSignal.timeout(timeoutMs),
      timeoutMs,
      opts.signal,
      undefined,
      opts.expiredCode ?? "SCRAPE_TIMEOUT",
    );
  }

  /** No time limit, only the caller's cancellation (jobs, which end when they are cancelled). Slices still bound the steps below it. */
  static unbounded(signal?: AbortSignal): Deadline {
    return new Deadline(Number.POSITIVE_INFINITY, undefined, undefined, signal, undefined, "SCRAPE_TIMEOUT");
  }

  /** Milliseconds left; 0 once over, Infinity for an unbounded deadline. */
  remaining(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  /** The time ran out (as opposed to the caller cancelling). */
  get expired(): boolean {
    return !this.cancelled && this.expiredBy() !== undefined;
  }

  /** The caller cancelled. */
  get cancelled(): boolean {
    return !!this.caller?.aborted;
  }

  /**
   * A budget of `ms` for one step, ending no later than this deadline; the step's `signal` also aborts when this one does.
   * A step that is given more than what is left just shares this deadline, so running out of the whole is always reported
   * as the whole running out. `expiredCode` is the error code when only the slice ran out (the whole still has time).
   */
  slice(ms: number, opts: { expiredCode?: ErrorCode } = {}): Deadline {
    if (ms >= this.remaining()) return this;
    return new Deadline(Date.now() + ms, AbortSignal.timeout(ms), ms, this.caller, this, opts.expiredCode ?? this.expiredCode);
  }

  /**
   * The error for a step that gave up on its own clock (puppeteer's `TimeoutError`) a moment before this deadline's timer
   * fired, which is the same event: the time ran out.
   */
  timedOut(what?: string): AppError {
    return this.expiryError(what);
  }

  /** Throws the right error if the deadline is already over. */
  throwIfAborted(what?: string): void {
    if (this.signal.aborted) throw this.abortError(what);
  }

  /**
   * What a step should throw. Once the deadline is over, anything a step threw is a symptom of the abort (a closed browser
   * context, a rejected fetch) and is replaced by the deadline's own error; before that, `err` is returned as is.
   * `what` completes "Timed out after 30000ms ..." / "Request cancelled ...", e.g. "while fetching https://example.com/".
   */
  translate(err: unknown, what?: string): unknown {
    return this.signal.aborted ? this.abortError(what) : err;
  }

  /** Waits `ms`, or until the deadline is over (then throws like `throwIfAborted`). */
  async sleep(ms: number, what?: string): Promise<void> {
    this.throwIfAborted(what);
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        done();
        reject(this.abortError(what));
      };
      const timer = setTimeout(() => {
        done();
        resolve();
      }, ms);
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Settles with `promise`, or with the deadline's error as soon as it is over, even when the operation behind `promise`
   * cannot be interrupted (the abandoned promise is left to finish; its rejection is swallowed).
   */
  bound<T>(promise: Promise<T>, what?: string): Promise<T> {
    promise.catch(() => {});
    return new Promise<T>((resolve, reject) => {
      const done = () => this.signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        done();
        reject(this.abortError(what));
      };
      if (this.signal.aborted) return onAbort();
      this.signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (v) => {
          done();
          resolve(v);
        },
        (e) => {
          done();
          reject(this.translate(e, what));
        },
      );
    });
  }

  /** The deadline (this one or an ancestor) whose own time ran out. */
  private expiredBy(): Deadline | undefined {
    if (this.timer?.aborted) return this;
    return this.parent?.expiredBy();
  }

  private abortError(what?: string): AppError {
    if (this.cancelled) return new AppError("TIMEOUT", `Request cancelled${what ? ` ${what}` : ""}`);
    return this.expiryError(what);
  }

  private expiryError(what?: string): AppError {
    const owner = this.expiredBy() ?? this;
    const after = owner.timeoutMs === undefined ? "" : ` after ${owner.timeoutMs}ms`;
    return new AppError(owner.expiredCode, `Timed out${after}${what ? ` ${what}` : ""}`);
  }
}
