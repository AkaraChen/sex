import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createJobBackend as composeJobBackend, createDocumentLog, type JobBackend, SqliteJobStore } from "@searxng-js/sex-jobs";
import { log } from "@searxng-js/sex-server/log";
import type { Config } from "../../config.ts";
import { BunqueueTaskQueue } from "./queue.ts";

/**
 * Job state and tasks in SQLite files under `config.dataDir` (they survive a restart), or in memory without one.
 * Scraped documents go to the DocumentLog that `createDocumentLog` picks: `config.documentsUrl`, else JSONL files
 * under `<dataDir>/documents`, else memory. The queue is bunqueue's, which only this app uses.
 */
export function createJobBackend(config: Config): JobBackend {
  if (config.dataDir) mkdirSync(config.dataDir, { recursive: true });
  const path = (file: string) => (config.dataDir ? join(config.dataDir, file) : ":memory:");
  const store = new SqliteJobStore(path("jobs.sqlite"), config.jobTtlMs, createDocumentLog(config), log);
  const queue = new BunqueueTaskQueue(path("queue.sqlite"), config.concurrency);
  return composeJobBackend({ store, queue });
}
