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
