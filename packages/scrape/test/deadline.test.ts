import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AppError } from "@searxng-js/sex-errors";
// Deadline is internal to the package (not exported), so this tests the source.
import { Deadline } from "../src/deadline.ts";

const code = (err: unknown) => (AppError.isInstance(err) ? { status: err.status, code: err.code } : err);

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
    assert.ok(d.remaining() > 50);
    assert.equal(d.signal.aborted, false);
    await sleep(150);
    assert.equal(d.remaining(), 0);
    assert.equal(d.signal.aborted, true);
    assert.equal(d.expired, true);
    assert.equal(d.cancelled, false);
    assert.deepEqual(code(d.translate(new Error("socket closed"), "while fetching x")), { status: 408, code: "SCRAPE_TIMEOUT" });
  });

  test("a cancelled caller is TIMEOUT, not SCRAPE_TIMEOUT, even if the time also ran out", async () => {
    const caller = new AbortController();
    const d = Deadline.start(50, { signal: caller.signal });
    caller.abort();
    await sleep(80);
    assert.equal(d.cancelled, true);
    assert.equal(d.expired, false);
    assert.deepEqual(code(d.translate(undefined)), { status: 408, code: "TIMEOUT" });
  });

  test("translate returns the error untouched while the deadline is running", () => {
    const err = new Error("connection refused");
    assert.equal(Deadline.start(10_000).translate(err), err);
  });

  test("translate replaces whatever a step threw once the deadline is over, naming the step", () => {
    const d = Deadline.start(10_000, { signal: AbortSignal.abort() });
    const err = d.translate(new AppError("ACTION_FAILED", "Target closed"), "while fetching https://x.test/") as AppError;
    assert.equal(err.code, "TIMEOUT");
    assert.equal(err.message, "Request cancelled while fetching https://x.test/");
    const timedOut = Deadline.start(1);
    return sleep(20).then(() => {
      assert.equal((timedOut.translate(undefined, "while loading x") as AppError).message, "Timed out after 1ms while loading x");
    });
  });

  test("the expired code can be chosen by the owner of the deadline", async () => {
    const d = Deadline.start(10, { expiredCode: "TIMEOUT" });
    await sleep(30);
    assert.deepEqual(code(d.translate(undefined)), { status: 408, code: "TIMEOUT" });
  });

  describe("of (the CallTime a package boundary carries)", () => {
    test("ends at deadlineAt, with an error that does not claim a duration", async () => {
      const d = Deadline.of({ deadlineAt: Date.now() + 40 });
      assert.ok(d.remaining() <= 40);
      await sleep(70);
      assert.equal(d.expired, true);
      const err = d.translate(undefined, "while fetching x") as AppError;
      assert.deepEqual(code(err), { status: 408, code: "SCRAPE_TIMEOUT" });
      assert.equal(err.message, "Timed out while fetching x");
    });

    test("a signal that aborts with a TimeoutError is the time running out, any other reason is a cancel", async () => {
      const timedOut = Deadline.of({ signal: AbortSignal.timeout(10) });
      await sleep(40);
      assert.equal(timedOut.expired, true);
      assert.equal(timedOut.cancelled, false);
      assert.deepEqual(code(timedOut.translate(undefined)), { status: 408, code: "SCRAPE_TIMEOUT" });

      const caller = new AbortController();
      const cancelled = Deadline.of({ signal: caller.signal });
      caller.abort();
      assert.equal(cancelled.cancelled, true);
      assert.deepEqual(code(cancelled.translate(undefined)), { status: 408, code: "TIMEOUT" });
    });

    test("a slice of it that runs out reports its own duration, not the whole's", async () => {
      const step = Deadline.of({ signal: AbortSignal.timeout(10_000), deadlineAt: Date.now() + 10_000 }).slice(10);
      await sleep(30);
      assert.equal((step.translate(undefined) as AppError).message, "Timed out after 10ms");
    });

    test("without either it is unbounded", () => {
      const d = Deadline.of({});
      assert.equal(d.remaining(), Number.POSITIVE_INFINITY);
      assert.equal(d.time().deadlineAt, undefined);
    });

    test("time() gives back what another package needs", () => {
      const d = Deadline.start(5_000);
      const t = d.time();
      assert.equal(t.signal, d.signal);
      assert.ok(t.deadlineAt !== undefined && Math.abs(t.deadlineAt - (Date.now() + 5_000)) < 100);
    });
  });

  test("an unbounded deadline has no end of its own but still follows the caller", () => {
    const caller = new AbortController();
    const d = Deadline.unbounded(caller.signal);
    assert.equal(d.remaining(), Number.POSITIVE_INFINITY);
    assert.equal(d.signal.aborted, false);
    caller.abort();
    assert.equal(d.signal.aborted, true);
    assert.equal(d.cancelled, true);
  });

  describe("slice", () => {
    test("a slice ends before its parent and reports its own code; the parent keeps running", async () => {
      const parent = Deadline.start(10_000);
      const step = parent.slice(30, { expiredCode: "TIMEOUT" });
      assert.ok(step.remaining() <= 30);
      await sleep(60);
      assert.equal(step.signal.aborted, true);
      assert.equal(parent.signal.aborted, false);
      assert.deepEqual(code(step.translate(undefined)), { status: 408, code: "TIMEOUT" });
    });

    test("a slice larger than what is left is the parent itself, so the whole running out is reported as such", async () => {
      const parent = Deadline.start(40);
      const step = parent.slice(5_000, { expiredCode: "TIMEOUT" });
      assert.equal(step, parent);
      await sleep(70);
      assert.deepEqual(code(step.translate(undefined)), { status: 408, code: "SCRAPE_TIMEOUT" });
    });

    test("a slice of a slice that runs out keeps the code of the deadline it was cut from unless told otherwise", async () => {
      const inner = Deadline.start(10_000, { expiredCode: "TIMEOUT" }).slice(5_000).slice(10);
      await sleep(30);
      assert.deepEqual(code(inner.translate(undefined)), { status: 408, code: "TIMEOUT" });
    });

    test("a slice aborts with the caller", () => {
      const caller = new AbortController();
      const step = Deadline.start(10_000, { signal: caller.signal }).slice(5_000);
      caller.abort();
      assert.equal(step.signal.aborted, true);
      assert.deepEqual(code(step.translate(undefined)), { status: 408, code: "TIMEOUT" });
    });

    test("an unbounded deadline hands out bounded slices", () => {
      const step = Deadline.unbounded().slice(1_000);
      assert.ok(step.remaining() <= 1_000);
    });
  });

  describe("sleep", () => {
    test("sleeps the given time", async () => {
      const t0 = performance.now();
      await Deadline.start(5_000).sleep(60);
      assert.ok(performance.now() - t0 >= 55);
    });

    test("is cut short when the deadline ends, with its error", async () => {
      const t0 = performance.now();
      const err = await rejection(Deadline.start(60).sleep(10_000, "while waiting"));
      assert.ok(performance.now() - t0 < 1_000);
      assert.deepEqual(code(err), { status: 408, code: "SCRAPE_TIMEOUT" });
      assert.ok((err as AppError).message.includes("while waiting"));
    });

    test("is cut short when the caller cancels", async () => {
      const caller = new AbortController();
      const sleeping = rejection(Deadline.start(10_000, { signal: caller.signal }).sleep(10_000));
      setTimeout(() => caller.abort(), 20);
      assert.deepEqual(code(await sleeping), { status: 408, code: "TIMEOUT" });
    });

    test("does not start when the deadline is already over", async () => {
      assert.deepEqual(code(await rejection(Deadline.start(5_000, { signal: AbortSignal.abort() }).sleep(1))), {
        status: 408,
        code: "TIMEOUT",
      });
    });
  });

  describe("bound", () => {
    test("passes the result through", async () => {
      assert.equal(await Deadline.start(5_000).bound(Promise.resolve(7)), 7);
    });

    test("passes an error through while the deadline runs", async () => {
      const err = new Error("boom");
      assert.equal(await rejection(Deadline.start(5_000).bound(Promise.reject(err))), err);
    });

    test("gives up on an operation that ignores the deadline, and swallows its late failure", async () => {
      const never = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 200));
      const t0 = performance.now();
      const err = await rejection(Deadline.start(50).bound(never, "while waiting for it"));
      assert.ok(performance.now() - t0 < 180);
      assert.deepEqual(code(err), { status: 408, code: "SCRAPE_TIMEOUT" });
      await sleep(250); // an unhandled rejection from `never` would fail the test run
    });

    test("an operation that fails because the deadline ended is reported as the deadline", async () => {
      const d = Deadline.start(40);
      const op = new Promise<never>((_, reject) => d.signal.addEventListener("abort", () => reject(new Error("Target closed"))));
      assert.deepEqual(code(await rejection(d.bound(op))), { status: 408, code: "SCRAPE_TIMEOUT" });
    });
  });

  test("throwIfAborted throws only after the end", async () => {
    const d = Deadline.start(30);
    assert.doesNotThrow(() => d.throwIfAborted());
    await sleep(60);
    assert.throws(() => d.throwIfAborted("before starting"), /Timed out after 30ms before starting/);
  });

  test("timedOut is the deadline's error even a moment before its own timer fires", () => {
    assert.deepEqual(code(Deadline.start(60_000).timedOut("while loading x")), { status: 408, code: "SCRAPE_TIMEOUT" });
  });
});
