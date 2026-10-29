// Batch bookkeeping: a failed enqueue never strands a job in "scraping", and a redelivered page task counts once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Engine } from "../src/engine/engine.ts";
import type { Task } from "../src/engine/jobs/index.ts";
import { runTask } from "../src/engine/tasks.ts";
import { testEngine, waitFor } from "./helpers.ts";

const body = Array.from({ length: 4 }, (_, i) => `<p>Paragraph ${i + 1}. ${"Lorem ipsum dolor sit amet. ".repeat(8)}</p>`).join("");

{
  describe("batch rollback and idempotence", () => {
    let site: ReturnType<typeof Bun.serve>;
    let engine: Engine;
    const url = () => `http://127.0.0.1:${site.port}/page`;

    beforeAll(() => {
      site = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () =>
          new Response(
            `<!doctype html><html lang="en"><head><title>P</title></head><body><main><article><h1>P</h1>${body}</article></main></body></html>`,
            {
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          ),
      });
      engine = testEngine();
    });

    afterAll(async () => {
      site.stop(true);
      await engine.close();
    });

    const finished = (id: string) =>
      waitFor(async () => {
        const j = await engine.getJob(id, "batch_scrape");
        return j.status === "scraping" ? undefined : j;
      });

    /** Makes the next queue.add fail. */
    function failNextEnqueue() {
      const queue = engine.jobs.queue;
      const original = queue.add.bind(queue);
      queue.add = async () => {
        queue.add = original;
        throw new Error("enqueue failed");
      };
    }

    test("a failed append enqueue returns the reopened job to completed", async () => {
      const { job } = await engine.batchScrape({ urls: [url()] });
      expect((await finished(job.id)).status).toBe("completed");

      failNextEnqueue();
      await expect(engine.batchScrape({ urls: [url()], appendToId: job.id })).rejects.toThrow("enqueue failed");

      const after = await engine.getJob(job.id, "batch_scrape");
      expect(after.status).toBe("completed");
      expect(after.pending).toBe(0);
      expect(after.total).toBe(1);
    });

    test("a failed enqueue of a new batch fails the job instead of leaving it scraping", async () => {
      const store = engine.jobs.store;
      const before = new Set((await store.active("batch_scrape")).map((j) => j.id));
      failNextEnqueue();
      await expect(engine.batchScrape({ urls: [url()] })).rejects.toThrow("enqueue failed");
      const stranded = (await store.active("batch_scrape")).filter((j) => !before.has(j.id));
      expect(stranded).toEqual([]);
    });

    test("a page task delivered twice while the job is still running is counted in completed once", async () => {
      const { store } = engine.jobs;
      const job = await store.create({ kind: "batch_scrape", options: {} });
      await store.incr(job.id, "pending", 2); // a second page is still outstanding, so the job stays scraping
      const task: Task = { type: "page", jobId: job.id, taskId: "same-task", url: url(), depth: 0 };
      await runTask(engine, task);
      await runTask(engine, task);

      const after = await engine.getJob(job.id, "batch_scrape");
      expect(after.completed).toBe(1);
      expect(after.pending).toBe(1);
      expect(after.status).toBe("scraping");
    });
  });
}
