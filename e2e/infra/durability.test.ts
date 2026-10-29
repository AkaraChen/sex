// Crash durability of `sex serve --data-dir`: SIGKILL in the middle of a crawl / batch scrape, start again on the same
// data dir, and the job finishes with every page exactly once. Status reads work across the restart. With --lightpanda the
// browser child must not outlive a SIGKILLed parent (Linux, `setpriv --pdeathsig`).
import { afterAll, describe, expect, test } from "bun:test";
import { bin } from "../lib/bin.ts";
import { api, killAll, serve, until } from "../lib/proc.ts";
import { html, prose, site } from "../lib/sites.ts";
import { removeTempDirs, tempDir } from "../lib/tmp.ts";
import { alive, childrenOf, jobDone, readJob } from "./support.ts";

const SEX = () => bin("sex");
const PAGES = 240;
/** Every page waits a little, so a few hundred of them take seconds and the kill lands in the middle. */
const LATENCY_MS = 150;

const hits = new Map<string, number>();
const fixture = site(async (_req, url) => {
  hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
  await Bun.sleep(LATENCY_MS);
  if (url.pathname === "/")
    return html(
      "root",
      `${prose("root")}<ul>${Array.from({ length: PAGES }, (_, i) => `<li><a href="/p/${i}">page ${i}</a></li>`).join("")}</ul>`,
    );
  const m = /^\/p\/(\d+)$/.exec(url.pathname);
  if (m) return html(`page ${m[1]}`, `<main><article><h1>page ${m[1]}</h1>${prose(`number ${m[1]}`)}</article></main>`);
  return new Response("not found", { status: 404 });
});

afterAll(async () => {
  fixture.stop();
  await killAll();
  removeTempDirs();
});

const sorted = (urls: string[]) => [...urls].sort();
const expectedPages = (extra: string[] = []) =>
  sorted([`${fixture.url}/`, ...Array.from({ length: PAGES }, (_, i) => `${fixture.url}/p/${i}`), ...extra]);

/** Polls the cheap way (the first page of `data` only) until `n` pages are stored. */
const runningWith = (base: string, kind: "crawl" | "batch/scrape", id: string, n: number) =>
  until(
    async () => {
      const r = await api(base, `/v2/${kind}/${id}`);
      return r.body.completed >= n ? (r.body as { status: string; completed: number; total: number }) : undefined;
    },
    60_000,
    20,
  );

/** Starts `serve` on a data dir; a restart gets another port, the job ids are what carries over. */
const start = (dataDir: string, extra: string[] = []) =>
  serve(SEX(), ["--allow-private-network", "--data-dir", dataDir, "--log-level", "info", ...extra]);

describe("jobs survive kill -9", () => {
  test("a crawl of a few hundred pages finishes after a restart, every page exactly once", async () => {
    const dataDir = tempDir("sex-e2e-dur-");
    let s = await start(dataDir, ["--concurrency", "4"]);
    const started = await api(s.url, "/v2/crawl", {
      body: { url: `${fixture.url}/`, limit: PAGES + 10, sitemap: "skip", maxConcurrency: 4 },
    });
    expect(started.status).toBe(200);
    const id = started.body.id as string;

    // Wait until the crawl is well under way but nowhere near done.
    const before = await runningWith(s.url, "crawl", id, 20);
    expect(before.status).toBe("scraping");
    expect(before.completed).toBeLessThan(PAGES);
    expect(before.completed).toBeGreaterThanOrEqual(20);

    await s.stop("SIGKILL");
    s = await start(dataDir, ["--concurrency", "4"]);
    // The old id is readable at once, from the store, before any task of the restarted process has run.
    const early = await api(s.url, `/v2/crawl/${id}`);
    expect(early.status).toBe(200);
    expect(early.body.completed).toBeGreaterThanOrEqual(before.completed);

    const done = await jobDone(s.url, "crawl", id, 240_000);
    expect(done.status).toBe("completed");
    expect(done.completed).toBe(PAGES + 1);
    expect(done.total).toBe(PAGES + 1);
    expect(sorted(done.data.map((d) => d.metadata.sourceURL))).toEqual(expectedPages());
    // A page is stored once even if its task was redelivered; the site may see a page twice (the interrupted attempt).
    expect(new Set(done.data.map((d) => d.metadata.sourceURL)).size).toBe(done.data.length);
    await s.stop();
  }, 360_000);

  test("a batch scrape finishes after a restart, every URL exactly once", async () => {
    const dataDir = tempDir("sex-e2e-dur-");
    let s = await start(dataDir, ["--concurrency", "4"]);
    const urls = Array.from({ length: PAGES }, (_, i) => `${fixture.url}/p/${i}`);
    const started = await api(s.url, "/v2/batch/scrape", { body: { urls, maxConcurrency: 4 } });
    expect(started.status).toBe(200);
    const id = started.body.id as string;
    const before = await runningWith(s.url, "batch/scrape", id, 20);
    expect(before.status).toBe("scraping");
    expect(before.completed).toBeLessThan(PAGES);

    await s.stop("SIGKILL");
    s = await start(dataDir, ["--concurrency", "4"]);
    expect((await api(s.url, `/v2/batch/scrape/${id}`)).status).toBe(200);
    const done = await jobDone(s.url, "batch/scrape", id, 240_000);
    expect(done.status).toBe("completed");
    expect(done).toMatchObject({ completed: PAGES, total: PAGES });
    expect(sorted(done.data.map((d) => d.metadata.sourceURL))).toEqual(sorted(urls));
    const errors = await api(s.url, `/v2/batch/scrape/${id}/errors`);
    expect(errors.body.errors).toEqual([]);
    await s.stop();
  }, 360_000);

  test("a finished job is still readable, unchanged, after a SIGKILL and a restart", async () => {
    const dataDir = tempDir("sex-e2e-dur-");
    let s = await start(dataDir);
    const urls = [1, 2, 3].map((i) => `${fixture.url}/p/${i}`);
    const id = (await api(s.url, "/v2/batch/scrape", { body: { urls } })).body.id as string;
    const done = await jobDone(s.url, "batch/scrape", id);
    expect(done.completed).toBe(3);
    await s.stop("SIGKILL");
    s = await start(dataDir);
    const again = await readJob(s.url, "batch/scrape", id);
    expect(again.status).toBe("completed");
    expect(again.data.map((d) => d.markdown)).toEqual(done.data.map((d) => d.markdown));
    await s.stop();
  }, 120_000);
});

describe.skipIf(process.platform !== "linux")("the Lightpanda child does not survive SIGKILL of sex", () => {
  const lightpandaChildren = async (pid: number) => {
    const kids = await childrenOf(pid);
    return kids.filter((k) =>
      Bun.spawnSync(["ps", "-o", "args=", "-p", String(k)])
        .stdout.toString()
        .includes("lightpanda"),
    );
  };

  test("SIGKILL", async () => {
    const dataDir = tempDir("sex-e2e-dur-");
    // The process is warmed up at start, so the child exists once serve is listening (poll: the spawn is lazy-ish).
    const s = await start(dataDir, ["--lightpanda"]);
    const kids = await until(async () => {
      const k = await lightpandaChildren(s.proc.pid);
      return k.length > 0 ? k : undefined;
    }, 60_000);
    expect(s.stderr()).toContain("spawn=setpriv");
    await s.stop("SIGKILL");
    // pdeathsig: the kernel sends the child SIGTERM when its parent dies.
    await until(() => (kids.every((k) => !alive(k)) ? true : undefined), 15_000, 100);
    for (const k of kids) expect(alive(k)).toBe(false);
  }, 120_000);
});
