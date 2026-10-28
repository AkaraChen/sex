import { describe, expect, test } from "bun:test";
import { Deadline } from "../src/core/deadline.ts";
import { AppError } from "../src/errors.ts";

const code = (err: unknown) => (err instanceof AppError ? { status: err.status, code: err.code } : err);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected rejection");
}

describe("Deadline", () => {
  test("remaining counts down and the signal aborts at the end; running out is SCRAPE_TIMEOUT", async () => {
    const d = Deadline.start(100);
    expect(d.remaining()).toBeGreaterThan(50);
    expect(d.signal.aborted).toBe(false);
    await Bun.sleep(150);
    expect(d.remaining()).toBe(0);
    expect(d.signal.aborted).toBe(true);
    expect(d.expired).toBe(true);
    expect(d.cancelled).toBe(false);
    expect(code(d.translate(new Error("socket closed"), "while fetching x"))).toEqual({ status: 408, code: "SCRAPE_TIMEOUT" });
  });

  test("a cancelled caller is TIMEOUT, not SCRAPE_TIMEOUT, even if the time also ran out", async () => {
    const caller = new AbortController();
    const d = Deadline.start(50, { signal: caller.signal });
    caller.abort();
    await Bun.sleep(80);
    expect(d.cancelled).toBe(true);
    expect(d.expired).toBe(false);
    expect(code(d.translate(undefined))).toEqual({ status: 408, code: "TIMEOUT" });
  });

  test("translate returns the error untouched while the deadline is running", () => {
    const err = new Error("connection refused");
    expect(Deadline.start(10_000).translate(err)).toBe(err);
  });

  test("translate replaces whatever a step threw once the deadline is over, naming the step", () => {
    const d = Deadline.start(10_000, { signal: AbortSignal.abort() });
    const err = d.translate(new AppError("ACTION_FAILED", "Target closed"), "while fetching https://x.test/") as AppError;
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toBe("Request cancelled while fetching https://x.test/");
    const timedOut = Deadline.start(1);
    return Bun.sleep(20).then(() => {
      expect((timedOut.translate(undefined, "while loading x") as AppError).message).toBe("Timed out after 1ms while loading x");
    });
  });

  test("the expired code can be chosen by the owner of the deadline", async () => {
    const d = Deadline.start(10, { expiredCode: "TIMEOUT" });
    await Bun.sleep(30);
    expect(code(d.translate(undefined))).toEqual({ status: 408, code: "TIMEOUT" });
  });

  test("an unbounded deadline has no end of its own but still follows the caller", () => {
    const caller = new AbortController();
    const d = Deadline.unbounded(caller.signal);
    expect(d.remaining()).toBe(Number.POSITIVE_INFINITY);
    expect(d.signal.aborted).toBe(false);
    caller.abort();
    expect(d.signal.aborted).toBe(true);
    expect(d.cancelled).toBe(true);
  });

  describe("slice", () => {
    test("a slice ends before its parent and reports its own code; the parent keeps running", async () => {
      const parent = Deadline.start(10_000);
      const step = parent.slice(30, { expiredCode: "TIMEOUT" });
      expect(step.remaining()).toBeLessThanOrEqual(30);
      await Bun.sleep(60);
      expect(step.signal.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false);
      expect(code(step.translate(undefined))).toEqual({ status: 408, code: "TIMEOUT" });
    });

    test("a slice larger than what is left is the parent itself, so the whole running out is reported as such", async () => {
      const parent = Deadline.start(40);
      const step = parent.slice(5_000, { expiredCode: "TIMEOUT" });
      expect(step).toBe(parent);
      await Bun.sleep(70);
      expect(code(step.translate(undefined))).toEqual({ status: 408, code: "SCRAPE_TIMEOUT" });
    });

    test("a slice of a slice that runs out keeps the code of the deadline it was cut from unless told otherwise", async () => {
      const inner = Deadline.start(10_000, { expiredCode: "TIMEOUT" }).slice(5_000).slice(10);
      await Bun.sleep(30);
      expect(code(inner.translate(undefined))).toEqual({ status: 408, code: "TIMEOUT" });
    });

    test("a slice aborts with the caller", () => {
      const caller = new AbortController();
      const step = Deadline.start(10_000, { signal: caller.signal }).slice(5_000);
      caller.abort();
      expect(step.signal.aborted).toBe(true);
      expect(code(step.translate(undefined))).toEqual({ status: 408, code: "TIMEOUT" });
    });

    test("an unbounded deadline hands out bounded slices", () => {
      const step = Deadline.unbounded().slice(1_000);
      expect(step.remaining()).toBeLessThanOrEqual(1_000);
    });
  });

  describe("sleep", () => {
    test("sleeps the given time", async () => {
      const t0 = performance.now();
      await Deadline.start(5_000).sleep(60);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(55);
    });

    test("is cut short when the deadline ends, with its error", async () => {
      const t0 = performance.now();
      const err = await rejection(Deadline.start(60).sleep(10_000, "while waiting"));
      expect(performance.now() - t0).toBeLessThan(1_000);
      expect(code(err)).toEqual({ status: 408, code: "SCRAPE_TIMEOUT" });
      expect((err as AppError).message).toContain("while waiting");
    });

    test("is cut short when the caller cancels", async () => {
      const caller = new AbortController();
      const sleeping = rejection(Deadline.start(10_000, { signal: caller.signal }).sleep(10_000));
      setTimeout(() => caller.abort(), 20);
      expect(code(await sleeping)).toEqual({ status: 408, code: "TIMEOUT" });
    });

    test("does not start when the deadline is already over", async () => {
      expect(code(await rejection(Deadline.start(5_000, { signal: AbortSignal.abort() }).sleep(1)))).toEqual({
        status: 408,
        code: "TIMEOUT",
      });
    });
  });

  describe("bound", () => {
    test("passes the result through", async () => {
      expect(await Deadline.start(5_000).bound(Promise.resolve(7))).toBe(7);
    });

    test("passes an error through while the deadline runs", async () => {
      const err = new Error("boom");
      expect(await rejection(Deadline.start(5_000).bound(Promise.reject(err)))).toBe(err);
    });

    test("gives up on an operation that ignores the deadline, and swallows its late failure", async () => {
      const never = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 200));
      const t0 = performance.now();
      const err = await rejection(Deadline.start(50).bound(never, "while waiting for it"));
      expect(performance.now() - t0).toBeLessThan(180);
      expect(code(err)).toEqual({ status: 408, code: "SCRAPE_TIMEOUT" });
      await Bun.sleep(250); // an unhandled rejection from `never` would fail the test run
    });

    test("an operation that fails because the deadline ended is reported as the deadline", async () => {
      const d = Deadline.start(40);
      const op = new Promise<never>((_, reject) => d.signal.addEventListener("abort", () => reject(new Error("Target closed"))));
      expect(code(await rejection(d.bound(op)))).toEqual({ status: 408, code: "SCRAPE_TIMEOUT" });
    });
  });

  test("throwIfAborted throws only after the end", async () => {
    const d = Deadline.start(30);
    expect(() => d.throwIfAborted()).not.toThrow();
    await Bun.sleep(60);
    expect(() => d.throwIfAborted("before starting")).toThrow(/Timed out after 30ms before starting/);
  });

  test("timedOut is the deadline's error even a moment before its own timer fires", () => {
    expect(code(Deadline.start(60_000).timedOut("while loading x"))).toEqual({ status: 408, code: "SCRAPE_TIMEOUT" });
  });
});
