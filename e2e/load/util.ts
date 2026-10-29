import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { type ApiResponse, api } from "../lib/proc.ts";

/** Multiplies every size (`SEX_E2E_LOAD_SCALE`, default 1; 0.2 for a quick local run). */
export const SCALE = Number(process.env.SEX_E2E_LOAD_SCALE || "1");
export const scaled = (n: number, min = 10) => Math.max(min, Math.round(n * SCALE));

/** The settings every load test starts `serve` with, recorded in the results. */
export const LOAD_ENV = { SEX_CONCURRENCY: "64", SEX_EXTRACT_WORKERS: "3" } as const;

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

export function sortedCopy(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

const kb = (s: string, key: string) => Number(new RegExp(`${key}:\\s+(\\d+) kB`).exec(s)?.[1] ?? 0);

/** Resident memory of a process in MiB (Linux; 0 where /proc does not exist). */
export function rssMiB(pid: number): number {
  try {
    return kb(readFileSync(`/proc/${pid}/status`, "utf8"), "VmRSS") / 1024;
  } catch {
    return 0;
  }
}

/** Every descendant of `pid`, from /proc. */
export function descendants(pid: number): number[] {
  const parent = new Map<number, number[]>();
  try {
    for (const e of readdirSync("/proc")) {
      if (!/^\d+$/.test(e)) continue;
      try {
        const stat = readFileSync(`/proc/${e}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
        parent.set(ppid, [...(parent.get(ppid) ?? []), Number(e)]);
      } catch {
        // the process ended
      }
    }
  } catch {
    return [];
  }
  const out: number[] = [];
  const todo = [pid];
  while (todo.length)
    for (const c of parent.get(todo.pop() as number) ?? []) {
      out.push(c);
      todo.push(c);
    }
  return out;
}

/** Samples the RSS of a process and of its children; `mark()` starts a new peak window. */
export class RssSampler {
  private timer: Timer;
  private peakMain = 0;
  private peakKids = 0;
  constructor(
    private pid: number,
    everyMs = 200,
  ) {
    this.sample();
    this.timer = setInterval(() => this.sample(), everyMs);
  }
  private sample() {
    this.peakMain = Math.max(this.peakMain, rssMiB(this.pid));
    const kids = descendants(this.pid).reduce((a, p) => a + rssMiB(p), 0);
    this.peakKids = Math.max(this.peakKids, kids);
  }
  /** The peaks since the last `mark()`; starts a new window at the current value. */
  mark(): { main: number; children: number } {
    this.sample();
    const r = { main: this.peakMain, children: this.peakKids };
    this.peakMain = rssMiB(this.pid);
    this.peakKids = 0;
    return r;
  }
  current(): number {
    return rssMiB(this.pid);
  }
  stop() {
    clearInterval(this.timer);
  }
}

/** Samples `/health` latency in the background. */
export function sampleHealth(base: string, everyMs = 100) {
  const times: number[] = [];
  let failures = 0;
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const t = performance.now();
      try {
        const r = await fetch(new URL("/health", base));
        await r.text();
        if (r.status !== 200) failures++;
        else times.push(performance.now() - t);
      } catch {
        failures++;
      }
      await Bun.sleep(everyMs);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      const s = sortedCopy(times);
      return { n: s.length, failures, p50: percentile(s, 50), p95: percentile(s, 95), max: s[s.length - 1] ?? Number.NaN };
    },
  };
}

export const f1 = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "n/a");
export const f0 = (n: number) => (Number.isFinite(n) ? n.toFixed(0) : "n/a");

/** One row of the results table. */
const rows: Array<[string, string, string]> = [];
export function record(test: string, metric: string, value: string | number) {
  rows.push([test, metric, String(value)]);
  console.log(`[load] ${test}: ${metric} = ${value}`);
}

/** Prints the rows recorded so far as a Markdown table, and appends it to the job summary when GitHub gives one. */
export function printResults(title: string) {
  if (rows.length === 0) return;
  const md = [
    `### ${title} (scale ${SCALE})`,
    "",
    "| test | metric | value |",
    "|---|---|---|",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
  ].join("\n");
  console.log(`\n${md}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  rows.length = 0;
}

export interface JobDoc {
  markdown?: string;
  metadata: { sourceURL: string; statusCode?: number; [k: string]: unknown };
}

/** Walks `next` from the first status page; returns every document in order and the number of pages read. */
export async function readAll(base: string, path: string, limit = 250): Promise<{ docs: JobDoc[]; pages: number; last: any }> {
  const docs: JobDoc[] = [];
  let next: string | null | undefined = `${path}${path.includes("?") ? "&" : "?"}limit=${limit}`;
  let pages = 0;
  let last: any;
  while (next) {
    const r: ApiResponse = await api(base, next);
    if (r.status !== 200) throw new Error(`GET ${next} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    docs.push(...r.body.data);
    last = r.body;
    pages++;
    next = r.body.next;
    if (pages > docs.length + 1000) throw new Error("next never ends");
  }
  return { docs, pages, last };
}

/** Polls a job until it is no longer `scraping`; returns the wall time (ms) from `t0` and the final status body. */
export async function waitJob(base: string, path: string, t0: number, timeoutMs: number): Promise<{ ms: number; body: any }> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(base, `${path}?limit=1`);
    if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    if (r.body.status !== "scraping") return { ms: performance.now() - t0, body: r.body };
    if (Date.now() > end) throw new Error(`${path} still scraping after ${timeoutMs} ms: ${r.body.completed}/${r.body.total}`);
    await Bun.sleep(200);
  }
}
