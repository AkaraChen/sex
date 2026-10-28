// Jobs survive the process: a crawl interrupted by SIGKILL finishes after `sex serve` restarts on the same data dir.
// With SEX_TEST_S3_URL (and the S3_* env) the same runs with documents on S3.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureSite, waitFor } from "./helpers.ts";

const site = startFixtureSite();
const dir = mkdtempSync(join(tmpdir(), "sex-durability-"));
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const s3Url = process.env.SEX_TEST_S3_URL?.replace(/\/+$/, "");
let child: ReturnType<typeof Bun.spawn> | undefined;
/** Every server started, so a failed run cannot leave one behind (it would hold the inherited stderr open). */
const children = new Set<ReturnType<typeof Bun.spawn>>();

afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  site.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function serve(port: number, dataDir: string, documentsUrl?: string) {
  const documents = documentsUrl ? ["--documents-url", documentsUrl] : [];
  child = Bun.spawn(
    ["bun", cli, "serve", "--port", String(port), "--data-dir", dataDir, ...documents, "--allow-private-network", "--log-level", "warn"],
    {
      stdout: "ignore",
      stderr: "inherit",
      env: {
        ...process.env,
        SEX_DATA_DIR: "",
        SEX_DOCUMENTS_URL: "",
        SEX_DOCS: "",
        SEX_LIGHTPANDA: "",
        SEX_SEARXNG_URL: "http://127.0.0.1:1",
      },
    },
  );
  children.add(child);
  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    () =>
      fetch(`${base}/health`).then(
        (r) => (r.ok ? true : undefined),
        () => undefined,
      ),
    15_000,
  );
  return base;
}

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port as number;
  s.stop(true);
  return port;
};

const variants: Array<[string, string | undefined]> = [["files", undefined]];
if (s3Url) variants.push(["S3", `${s3Url}/durability-${Bun.randomUUIDv7()}`]);

test.each(variants)(
  "a crawl interrupted by SIGKILL completes after a restart (documents in %s)",
  async (_, documentsUrl) => {
    const port = freePort();
    const dataDir = mkdtempSync(join(dir, "data-"));
    let base = await serve(port, dataDir, documentsUrl);
    // A 1s politeness delay keeps most pages queued (as delayed tasks) when the process is killed.
    const started = (await (
      await fetch(`${base}/v2/crawl`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${site.url}/`, limit: 10, delay: 1, sitemap: "skip" }),
      })
    ).json()) as { id: string };
    const status = async () =>
      (await (await fetch(`${base}/v2/crawl/${started.id}`)).json()) as {
        status: string;
        completed: number;
        data: Array<{ metadata: { sourceURL: string } }>;
      };
    await waitFor(async () => ((await status()).completed >= 1 ? true : undefined), 15_000);
    const before = await status();
    expect(before.status).toBe("scraping");
    // Pages were still queued when the process died, so the rest can only come from the restarted process.
    expect(before.completed).toBeLessThan(3);

    child?.kill("SIGKILL");
    await child?.exited;

    base = await serve(port, dataDir, documentsUrl);
    const done = await waitFor(async () => {
      const s = await status();
      return s.status === "scraping" ? undefined : s;
    }, 30_000);
    expect(done.status).toBe("completed");
    expect(done.data.map((d) => d.metadata.sourceURL).sort()).toEqual([`${site.url}/`, `${site.url}/docs/a`, `${site.url}/docs/b`]);

    child?.kill("SIGKILL");
    await child?.exited;
    if (documentsUrl) {
      const url = new URL(documentsUrl);
      const client = new Bun.S3Client({ bucket: url.hostname });
      const keys = ((await client.list({ prefix: `${url.pathname.slice(1)}/` })).contents ?? []).map((o) => o.key);
      expect(keys.length).toBeGreaterThanOrEqual(3);
      await Promise.all(keys.map((k) => client.delete(k)));
    }
  },
  60_000,
);

/** A site whose /slow page never answers its first request (the task running it is what gets killed), then behaves. */
function startHangingSite() {
  const hits = { slow: 0 };
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const html = (title: string) =>
        new Response(
          `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${"Some words on a page. ".repeat(40)}</p></article></body></html>`,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      if (pathname === "/slow") {
        if (hits.slow++ === 0) return new Promise<Response>(() => {});
        return html("slow");
      }
      return html(pathname);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

test("a task running when the process is SIGKILLed is redelivered and its job completes", async () => {
  const hanging = startHangingSite();
  try {
    const port = freePort();
    const dataDir = mkdtempSync(join(dir, "data-"));
    let base = await serve(port, dataDir);
    const started = (await (
      await fetch(`${base}/v2/batch/scrape`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls: [`${hanging.url}/slow`, `${hanging.url}/fast`] }),
      })
    ).json()) as { id: string };
    const status = async () =>
      (await (await fetch(`${base}/v2/batch/scrape/${started.id}`)).json()) as {
        status: string;
        completed: number;
        total: number;
        data: Array<{ metadata: { sourceURL: string } }>;
      };
    // The fast page finishes; the slow one is held open by the site, so its task is running when the process dies.
    await waitFor(async () => ((await status()).completed === 1 && hanging.hits.slow === 1 ? true : undefined), 15_000);
    expect((await status()).status).toBe("scraping");

    child?.kill("SIGKILL");
    await child?.exited;

    base = await serve(port, dataDir);
    const done = await waitFor(async () => {
      const s = await status();
      return s.status === "scraping" ? undefined : s;
    }, 45_000);
    expect(done.status).toBe("completed");
    expect(done.completed).toBe(2);
    expect(done.data.map((d) => d.metadata.sourceURL).sort()).toEqual([`${hanging.url}/fast`, `${hanging.url}/slow`]);
    expect(hanging.hits.slow).toBe(2);
  } finally {
    hanging.stop();
  }
}, 90_000);

test("a job's maxConcurrency still holds after a restart", async () => {
  // Every page takes a moment and the site counts how many are being served at once; a request the client
  // abandoned (the killed process) stops counting when its connection drops.
  let inFlight = 0;
  let peak = 0;
  const site = Bun.serve({
    port: 0,
    async fetch(req) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      let open = true;
      const leave = () => {
        if (open) inFlight--;
        open = false;
      };
      req.signal.addEventListener("abort", leave);
      await Bun.sleep(250);
      leave();
      return new Response(
        "<html><head><title>p</title></head><body><article><h1>p</h1><p>" +
          "Some words on a page. ".repeat(40) +
          "</p></article></body></html>",
        {
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    },
  });
  try {
    const port = freePort();
    const dataDir = mkdtempSync(join(dir, "data-"));
    let base = await serve(port, dataDir);
    const urls = Array.from({ length: 12 }, (_, i) => `http://127.0.0.1:${site.port}/p/${i}`);
    const started = (await (
      await fetch(`${base}/v2/batch/scrape`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls, maxConcurrency: 1 }),
      })
    ).json()) as { id: string };
    const status = async () =>
      (await (await fetch(`${base}/v2/batch/scrape/${started.id}`)).json()) as { status: string; completed: number };
    await waitFor(async () => ((await status()).completed >= 2 ? true : undefined), 15_000);
    expect(peak).toBe(1);

    child?.kill("SIGKILL");
    await child?.exited;
    const before = peak;
    expect(before).toBe(1);
    // The restarted process works through the rest of the queue; it must not run them side by side.
    base = await serve(port, dataDir);
    const done = await waitFor(async () => {
      const s = await status();
      return s.status === "scraping" ? undefined : s;
    }, 45_000);
    expect(done.status).toBe("completed");
    expect(done.completed).toBe(12);
    expect(peak).toBe(1);
  } finally {
    site.stop(true);
  }
}, 90_000);
