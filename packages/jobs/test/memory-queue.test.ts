import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MemoryTaskQueue, type Task } from "@searxng-js/sex-jobs";

const page = (jobId: string, n: number): Task => ({ type: "page", jobId, taskId: `${jobId}-${n}`, url: `https://e.test/${n}`, depth: 0 });
const idle = () => new Promise((r) => setTimeout(r, 30));

/** A handler that records the order tasks start in and finishes each when told. */
function recorder() {
  const started: string[] = [];
  const release: Array<() => void> = [];
  const handler = (task: Task) =>
    new Promise<undefined>((resolve) => {
      started.push(task.taskId ?? task.jobId);
      release.push(() => resolve(undefined));
    });
  return { started, release, handler };
}

describe("MemoryTaskQueue", () => {
  test("tasks without a lane go before the lanes' tasks", async () => {
    const q = new MemoryTaskQueue({ concurrency: 1 });
    const { started, release, handler } = recorder();
    await q.add([
      { task: page("a", 1), lane: { id: "a" } },
      { task: page("a", 2), lane: { id: "a" } },
    ]);
    await q.add([{ task: { type: "crawl-start", jobId: "c", taskId: "start" } }]);
    q.startWorker(handler);
    await idle();
    assert.deepEqual(started, ["start"]);
    release[0]?.();
    await idle();
    assert.deepEqual(started, ["start", "a-1"]);
    release[1]?.();
    release[2]?.();
    await q.close();
  });

  test("lanes are served in turn", async () => {
    const q = new MemoryTaskQueue({ concurrency: 1 });
    const order: string[] = [];
    q.startWorker(async (task) => {
      order.push(task.taskId ?? "");
      return undefined;
    });
    await q.add([1, 2, 3, 4].map((n) => ({ task: page("big", n), lane: { id: "big" } })));
    await q.add([{ task: page("small", 1), lane: { id: "small" } }]);
    await idle();
    assert.deepEqual(order.slice(0, 3), ["big-1", "small-1", "big-2"]);
    await q.close();
  });

  test("a lane's cap limits its running tasks, and removing it frees them", async () => {
    const q = new MemoryTaskQueue({ concurrency: 4 });
    const { started, release, handler } = recorder();
    await q.capLane("job", 1);
    await q.add([1, 2, 3].map((n) => ({ task: page("job", n), lane: { id: "job" } })));
    q.startWorker(handler);
    await idle();
    assert.equal(started.length, 1);
    assert.deepEqual(await q.counts(), { active: 1, waiting: 2 });
    await q.capLane("job", undefined);
    await idle();
    assert.equal(started.length, 3);
    for (const r of release) r();
    await q.close();
  });

  test("a cooldown holds the lane after a task finished, but not after a skipped one", async () => {
    const q = new MemoryTaskQueue({ concurrency: 2 });
    const times: number[] = [];
    q.startWorker(async (task) => {
      times.push(Date.now());
      return task.taskId === "slow-1" ? "skipped" : "done";
    });
    const lane = { id: "slow", cooldownMs: 120 };
    await q.capLane("slow", 1);
    await q.add([1, 2, 3].map((n) => ({ task: page("slow", n), lane })));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(times.length, 3);
    assert.ok((times[1] as number) - (times[0] as number) < 60, "no cooldown after a skipped task");
    assert.ok((times[2] as number) - (times[1] as number) >= 110, "cooldown after a done task");
    await q.close();
  });

  test("a delayed task waits and counts as waiting", async () => {
    const q = new MemoryTaskQueue();
    const seen: number[] = [];
    const t0 = Date.now();
    q.startWorker(async () => {
      seen.push(Date.now() - t0);
      return undefined;
    });
    await q.add([{ task: page("d", 1), lane: { id: "d" }, delayMs: 100 }]);
    assert.deepEqual(await q.counts(), { active: 0, waiting: 1 });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(seen.length, 1);
    assert.ok((seen[0] as number) >= 95);
    await q.close();
  });

  test("a handler that throws is logged and the queue carries on", async () => {
    const errors: string[] = [];
    const q = new MemoryTaskQueue({ logger: { debug() {}, info() {}, warn() {}, error: (m) => void errors.push(m) } });
    const done: string[] = [];
    q.startWorker(async (task) => {
      if (task.taskId === "j-1") throw new Error("boom");
      done.push(task.taskId ?? "");
      return undefined;
    });
    await q.add([1, 2].map((n) => ({ task: page("j", n), lane: { id: "j" } })));
    await idle();
    assert.deepEqual(done, ["j-2"]);
    assert.deepEqual(errors, ["task failed"]);
    await q.close();
  });

  test("tasks wait for the worker, and close waits for running tasks", async () => {
    const q = new MemoryTaskQueue();
    await q.add([{ task: page("w", 1), lane: { id: "w" } }]);
    assert.deepEqual(await q.counts(), { active: 0, waiting: 1 });
    let finished = false;
    q.startWorker(async () => {
      await new Promise((r) => setTimeout(r, 50));
      finished = true;
      return undefined;
    });
    await idle();
    await q.add([{ task: page("w", 2), lane: { id: "w" } }]);
    await q.close();
    assert.equal(finished, true);
    await q.add([{ task: page("w", 3), lane: { id: "w" } }]);
    assert.deepEqual(await q.counts(), { active: 0, waiting: 0 });
  });
});
