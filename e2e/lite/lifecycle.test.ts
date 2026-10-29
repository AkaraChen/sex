import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { bin } from "../lib/bin.ts";
import { api, killAll, run, serve, until } from "../lib/proc.ts";
import { removeTempDirs } from "../lib/tmp.ts";

/** The managed SearXNG: no SEX_SEARXNG_URL, so sex-lite starts the bundled binary as a child process. Fully local. */

const lite = bin("sex-lite");
afterAll(async () => {
  await killAll();
  removeTempDirs();
});

/** All descendants of `pid` (Linux: /proc). */
function descendants(pid: number): number[] {
  const out: number[] = [];
  const parents = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      parents.set(ppid, [...(parents.get(ppid) ?? []), Number(name)]);
    } catch {
      // The process went away while we were looking.
    }
  }
  const queue = [pid];
  while (queue.length)
    for (const c of parents.get(queue.pop()!) ?? []) {
      out.push(c);
      queue.push(c);
    }
  return out;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    // A zombie still answers kill(0); it is gone for our purposes.
    return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return false;
  }
};

const managed = process.platform === "linux" ? describe : describe.skip;

managed("managed SearXNG child process", () => {
  test("serve starts it, answers a search through it, and SIGTERM exits 0 with no child left", async () => {
    const s = await serve(lite, [], { env: { SEX_SEARXNG_URL: undefined, SEX_LOG_LEVEL: "info" }, startupMs: 120_000 });
    const children = await until(() => {
      const d = descendants(s.proc.pid);
      return d.length > 0 ? d : undefined;
    }, 120_000);
    expect(children.length).toBeGreaterThan(0);
    const health = await api(s.url, "/health");
    expect(health.status).toBe(200);
    const m = /^managed \(http:\/\/127\.0\.0\.1:\d+, pid (\d+)\)$/.exec(health.body.searxng);
    expect(m, health.body.searxng).not.toBeNull();
    expect(children).toContain(Number(m![1]));
    // No internet is needed for this: the engines may all fail, but the request must be answered, not hang or crash.
    const r = await api(s.url, "/v2/search", { body: { query: "e2e managed searxng", limit: 1, timeout: 60_000 } });
    expect([200, 502]).toContain(r.status);
    expect(await s.stop("SIGTERM")).toBe(0);
    await until(() => (children.every((p) => !alive(p)) ? true : undefined), 20_000);
  }, 300_000);

  test("SIGKILL of the parent takes the child with it (it exits when its stdin pipe closes)", async () => {
    const s = await serve(lite, [], { env: { SEX_SEARXNG_URL: undefined }, startupMs: 120_000 });
    const children = await until(() => {
      const d = descendants(s.proc.pid);
      return d.length > 0 ? d : undefined;
    }, 120_000);
    s.proc.kill("SIGKILL");
    await s.proc.exited;
    await until(() => (children.every((p) => !alive(p)) ? true : undefined), 30_000);
  }, 300_000);

  test("a one-shot search starts SearXNG, finishes, and leaves no process behind", async () => {
    const before = new Set(readdirSync("/proc").filter((n) => /^\d+$/.test(n)));
    const r = await run(lite, ["search", "e2e one shot", "-n", "1", "--timeout", "60000"], {
      env: { SEX_SEARXNG_URL: undefined },
      timeoutMs: 180_000,
    });
    // Offline CI runners may get no results; what matters is a clean exit path, not a crash.
    expect([0, 1]).toContain(r.code);
    if (r.code === 1) expect(r.stderr).toMatch(/error: [A-Z_]+:/);
    await Bun.sleep(1000);
    const leftover = readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n) && !before.has(n))
      .filter((n) => {
        try {
          return readFileSync(`/proc/${n}/cmdline`, "utf8").includes("searxng");
        } catch {
          return false;
        }
      });
    expect(leftover).toEqual([]);
  }, 300_000);
});
