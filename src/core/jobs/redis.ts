import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { log } from "../../log.ts";
import type { Document } from "../../schemas.ts";
import type { CounterName, JobError, JobKind, JobPatch, JobRecord, JobState, JobStore, Task, TaskQueue } from "./types.ts";

const COUNTERS: CounterName[] = ["total", "completed", "pending", "scheduled", "slots"];
const JSON_FIELDS = ["options", "result", "sources"] as const;

// KEYS: job hash, active set. ARGV: new status, job id, then field/value pairs to set.
const FINISH_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= 'scraping' then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[1])
for i = 3, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
redis.call('SREM', KEYS[2], ARGV[2])
return 1`;

const REOPEN_SCRIPT = `
if redis.call('HGET', KEYS[1], 'status') ~= 'completed' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'scraping')
redis.call('SADD', KEYS[2], ARGV[1])
return 1`;

export function redisConnection(url: string): IORedis {
  // BullMQ workers need maxRetriesPerRequest: null for their blocking connection.
  const conn = new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: false });
  conn.on("error", (err) => log.error("redis error", { error: err.message }));
  return conn;
}

/** Job state in Redis: a hash per job plus lists/sets for documents, errors and crawl dedupe. Keys expire with the job. */
export class RedisJobStore implements JobStore {
  constructor(
    private readonly redis: IORedis,
    private readonly prefix: string,
    /** How long a job's keys live, in ms. */
    private readonly ttlMs: number,
  ) {}

  private key(id: string, suffix?: string) {
    return `${this.prefix}:job:${id}${suffix ? `:${suffix}` : ""}`;
  }

  private activeKey(kind: JobKind) {
    return `${this.prefix}:active:${kind}`;
  }

  private parse(id: string, h: Record<string, string>): JobRecord | undefined {
    if (!h.kind) return undefined;
    const rec: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(h)) {
      if ((COUNTERS as string[]).includes(k) || k === "createdAt" || k === "expiresAt") rec[k] = Number(v);
      else if ((JSON_FIELDS as readonly string[]).includes(k)) rec[k] = JSON.parse(v);
      else rec[k] = v;
    }
    return rec as unknown as JobRecord;
  }

  private encodePatch(patch: JobPatch): string[] {
    return Object.entries(patch).flatMap(([k, v]) =>
      v === undefined ? [] : [k, (JSON_FIELDS as readonly string[]).includes(k) ? JSON.stringify(v) : String(v)],
    );
  }

  async create(init: Pick<JobRecord, "kind" | "url" | "options">): Promise<JobRecord> {
    const now = Date.now();
    const rec: JobRecord = {
      ...init,
      id: randomUUID(),
      status: "scraping",
      createdAt: now,
      expiresAt: now + this.ttlMs,
      total: 0,
      completed: 0,
      pending: 0,
      scheduled: 0,
      slots: 0,
    };
    const key = this.key(rec.id);
    await this.redis
      .multi()
      .hset(key, {
        kind: rec.kind,
        status: rec.status,
        ...(rec.url ? { url: rec.url } : {}),
        options: JSON.stringify(rec.options),
        createdAt: rec.createdAt,
        expiresAt: rec.expiresAt,
        ...Object.fromEntries(COUNTERS.map((c) => [c, 0])),
      })
      .pexpireat(key, rec.expiresAt)
      .sadd(this.activeKey(rec.kind), rec.id)
      .exec();
    return rec;
  }

  async get(id: string) {
    return this.parse(id, await this.redis.hgetall(this.key(id)));
  }

  async patch(id: string, patch: JobPatch) {
    const fields = this.encodePatch(patch);
    if (fields.length) await this.redis.hset(this.key(id), ...fields);
  }

  async finish(id: string, status: Exclude<JobState, "scraping">, patch: JobPatch = {}) {
    const rec = await this.get(id);
    if (!rec) return false;
    const ok = await this.redis.eval(FINISH_SCRIPT, 2, this.key(id), this.activeKey(rec.kind), status, id, ...this.encodePatch(patch));
    return ok === 1;
  }

  async reopen(id: string) {
    const rec = await this.get(id);
    if (rec) await this.redis.eval(REOPEN_SCRIPT, 2, this.key(id), this.activeKey(rec.kind), id);
  }

  async incr(id: string, counter: CounterName, by = 1) {
    return this.redis.hincrby(this.key(id), counter, by);
  }

  /** Appends to a per-job list/set and gives it the job's expiry. */
  private async push(id: string, suffix: string, op: "rpush" | "sadd", values: string[]) {
    const rec = await this.redis.hget(this.key(id), "expiresAt");
    const key = this.key(id, suffix);
    const multi = this.redis.multi()[op](key, ...values);
    if (rec) multi.pexpireat(key, Number(rec));
    return multi.exec();
  }

  async pushDocument(id: string, doc: Document) {
    await this.push(id, "docs", "rpush", [JSON.stringify(doc)]);
  }

  async documents(id: string, skip: number, maxChars: number) {
    const key = this.key(id, "docs");
    const data: Document[] = [];
    let size = 0;
    let index = skip;
    const batch = 50;
    while (true) {
      const raw = await this.redis.lrange(key, index, index + batch - 1);
      if (!raw.length) return { data, nextSkip: null };
      for (const item of raw) {
        if (data.length > 0 && size + item.length > maxChars) return { data, nextSkip: index };
        data.push(JSON.parse(item));
        size += item.length;
        index++;
      }
      if (raw.length < batch) {
        const len = await this.redis.llen(key);
        return { data, nextSkip: index < len ? index : null };
      }
    }
  }

  async pushError(id: string, error: JobError) {
    await this.push(id, "errors", "rpush", [JSON.stringify(error)]);
  }

  async errors(id: string) {
    return (await this.redis.lrange(this.key(id, "errors"), 0, -1)).map((e) => JSON.parse(e) as JobError);
  }

  async pushRobotsBlocked(id: string, url: string) {
    await this.push(id, "robots", "rpush", [url]);
  }

  async robotsBlocked(id: string) {
    return this.redis.lrange(this.key(id, "robots"), 0, -1);
  }

  async markSeen(id: string, keys: string[]) {
    if (!keys.length) return [];
    const key = this.key(id, "seen");
    const expiresAt = await this.redis.hget(this.key(id), "expiresAt");
    const multi = this.redis.multi();
    for (const k of keys) multi.sadd(key, k);
    if (expiresAt) multi.pexpireat(key, Number(expiresAt));
    const res = (await multi.exec()) ?? [];
    return keys.map((_, i) => res[i]?.[1] === 1);
  }

  async active(kind: JobKind) {
    const ids = await this.redis.smembers(this.activeKey(kind));
    const out: JobRecord[] = [];
    for (const id of ids) {
      const rec = await this.get(id);
      if (rec?.status === "scraping") out.push(rec);
      else await this.redis.srem(this.activeKey(kind), id);
    }
    return out;
  }

  async close() {}
}

/** Tasks as BullMQ jobs; any process started with a worker consumes them. */
export class BullTaskQueue implements TaskQueue {
  private readonly queue: Queue;
  private worker?: Worker;

  constructor(
    private readonly connection: IORedis,
    private readonly prefix: string,
    private readonly concurrency: number,
  ) {
    this.queue = new Queue("tasks", { connection, prefix });
  }

  async add(tasks: Array<{ task: Task; delayMs?: number }>) {
    if (!tasks.length) return;
    await this.queue.addBulk(
      tasks.map(({ task, delayMs }) => ({
        name: task.type,
        data: task,
        opts: {
          ...(delayMs && delayMs > 0 ? { delay: Math.round(delayMs) } : {}),
          removeOnComplete: true,
          removeOnFail: { age: 24 * 3600 },
        },
      })),
    );
  }

  startWorker(handler: (task: Task) => Promise<void>) {
    if (this.worker) return;
    this.worker = new Worker("tasks", (job) => handler(job.data as Task), {
      connection: this.connection,
      prefix: this.prefix,
      concurrency: this.concurrency,
    });
    this.worker.on("failed", (job, err) => log.error("task failed", { type: job?.name, error: err.message }));
    log.info("queue worker started", { backend: "redis", concurrency: this.concurrency });
  }

  async close() {
    await this.worker?.close();
    await this.queue.close();
  }
}
