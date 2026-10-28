// Jobs survive the process: a crawl interrupted by SIGKILL finishes after `sex serve` restarts on the same data dir.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureSite, waitFor } from "./helpers.ts";

const site = startFixtureSite();
const dataDir = mkdtempSync(join(tmpdir(), "sex-durability-"));
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
let child: ReturnType<typeof Bun.spawn> | undefined;

afterAll(() => {
  child?.kill("SIGKILL");
  site.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

async function serve(port: number) {
  child = Bun.spawn(
    ["bun", cli, "serve", "--port", String(port), "--data-dir", dataDir, "--allow-private-network", "--log-level", "warn"],
    {
      stdout: "ignore",
      stderr: "inherit",
      env: { ...process.env, SEX_DATA_DIR: "", SEX_DOCS: "", SEX_LIGHTPANDA: "", SEX_SEARXNG_URL: "http://127.0.0.1:1" },
    },
  );
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

test("a crawl interrupted by SIGKILL completes after a restart", async () => {
  const port = freePort();
  let base = await serve(port);
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

  base = await serve(port);
  const done = await waitFor(async () => {
    const s = await status();
    return s.status === "scraping" ? undefined : s;
  }, 30_000);
  expect(done.status).toBe("completed");
  expect(done.data.map((d) => d.metadata.sourceURL).sort()).toEqual([`${site.url}/`, `${site.url}/docs/a`, `${site.url}/docs/b`]);
}, 60_000);
