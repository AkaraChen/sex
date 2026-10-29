// Job documents on S3 (SEX_DOCUMENTS_URL=s3://bucket/prefix, credentials from S3_* env): crawl and batch results are
// stored as objects, read back through the status routes, survive kill -9 + restart, and a wrong key is an error the
// caller can read, never silently lost data. Needs an S3 server (CI: SeaweedFS; locally the tests skip without SEX_E2E_S3_*).
import { afterAll, describe, expect, test } from "bun:test";
import { bin } from "../lib/bin.ts";
import { api, killAll, serve, until } from "../lib/proc.ts";
import { s3 as s3Service } from "../lib/services.ts";
import { html, prose, site } from "../lib/sites.ts";
import { removeTempDirs, tempDir } from "../lib/tmp.ts";
import { jobDone, readJob } from "./support.ts";

const creds = s3Service();
const PAGES = 40;
const fixture = site(async (_req, url) => {
  await Bun.sleep(100);
  if (url.pathname === "/")
    return html("root", `${prose("root")}${Array.from({ length: PAGES }, (_, i) => `<a href="/p/${i}">page ${i}</a>`).join(" ")}`);
  const m = /^\/p\/(\d+)$/.exec(url.pathname);
  return m
    ? html(`page ${m[1]}`, `<main><article><h1>page ${m[1]}</h1>${prose(`number ${m[1]}`)}</article></main>`)
    : new Response("nf", { status: 404 });
});

// One bucket for the whole file and a random prefix per test: SeaweedFS gives every bucket its own volumes and runs out of
// them after a few dozen buckets. The bucket is created by the first write.
const BUCKET = "sex-e2e-infra";
const run = crypto.randomUUID().slice(0, 8);
let n = 0;
/** A prefix of this run's own; the cleanup deletes only what is under `e2e-<run>/`. */
const prefix = () => `e2e-${run}/t${++n}`;

afterAll(async () => {
  fixture.stop();
  await killAll();
  removeTempDirs();
  if (creds) await removeObjects().catch(() => {});
});

const client = (bucket: string) =>
  new Bun.S3Client({
    endpoint: creds?.endpoint,
    accessKeyId: creds?.accessKeyId,
    secretAccessKey: creds?.secretAccessKey,
    bucket,
    region: "us-east-1",
  });

async function removeObjects() {
  const c = client(BUCKET);
  for (const o of (await c.list({ prefix: `e2e-${run}/` })).contents ?? []) await c.delete(o.key);
}

const env = (secret?: string) => ({
  S3_ENDPOINT: creds?.endpoint,
  S3_ACCESS_KEY_ID: creds?.accessKeyId,
  S3_SECRET_ACCESS_KEY: secret ?? creds?.secretAccessKey,
  S3_REGION: "us-east-1",
  // A developer's AWS_* must not win over S3_*.
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
});

const start = (dataDir: string, documentsUrl: string, secret?: string) =>
  serve(bin("sex"), ["--allow-private-network", "--data-dir", dataDir, "--documents-url", documentsUrl, "--log-level", "info"], {
    env: env(secret),
  });

describe.skipIf(!creds)("documents on S3", () => {
  test("a batch scrape and a crawl are stored as objects under the prefix and read back", async () => {
    const bucket = BUCKET;
    const pre = prefix();
    const url = `s3://${bucket}/${pre}`;
    const s = await start(tempDir(), url);
    expect((await api(s.url, "/health")).body.documents).toBe(url);

    const urls = [1, 2, 3, 4].map((i) => `${fixture.url}/p/${i}`);
    const batch = (await api(s.url, "/v2/batch/scrape", { body: { urls } })).body.id as string;
    const crawl = (await api(s.url, "/v2/crawl", { body: { url: `${fixture.url}/`, limit: 6, sitemap: "skip" } })).body.id as string;
    const b = await jobDone(s.url, "batch/scrape", batch);
    const c = await jobDone(s.url, "crawl", crawl);
    expect(b).toMatchObject({ status: "completed", completed: 4, total: 4 });
    expect(c).toMatchObject({ status: "completed", completed: 6, total: 6 });
    expect(b.data.map((d) => d.metadata.sourceURL).sort()).toEqual([...urls].sort());
    expect(b.data.every((d) => (d.markdown ?? "").includes("Paragraph 1 about"))).toBe(true);

    // One object per document, named <prefix>/<jobId>/<random>.json, and nothing lands on local disk next to the database.
    const keys = ((await client(bucket).list({ prefix: `${pre}/` })).contents ?? []).map((o) => o.key);
    expect(keys.filter((k) => k.startsWith(`${pre}/${batch}/`))).toHaveLength(4);
    expect(keys.filter((k) => k.startsWith(`${pre}/${crawl}/`))).toHaveLength(6);
    expect(keys.every((k) => k.slice(pre.length + 1).match(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.json$/))).toBe(true);
    const doc = JSON.parse(
      await client(bucket)
        .file(keys.find((k) => k.startsWith(`${pre}/${batch}/`)) as string)
        .text(),
    );
    expect(doc.metadata.sourceURL).toMatch(/\/p\/\d$/);
    await s.stop();
  }, 120_000);

  test("the prefix is optional in the URL form: s3://bucket/ stores <jobId>/<id>.json at the bucket root", async () => {
    const s = await start(tempDir(), `s3://${BUCKET}`);
    const id = (await api(s.url, "/v2/batch/scrape", { body: { urls: [`${fixture.url}/p/1`] } })).body.id as string;
    await jobDone(s.url, "batch/scrape", id);
    const keys = ((await client(BUCKET).list({ prefix: `${id}/` })).contents ?? []).map((o) => o.key);
    expect(keys).toHaveLength(1);
    for (const k of keys) await client(BUCKET).delete(k);
    await s.stop();
  }, 60_000);

  test("a finished job is still readable after a clean restart and after a kill -9", async () => {
    const url = `s3://${BUCKET}/${prefix()}`;
    const dataDir = tempDir();
    let s = await start(dataDir, url);
    const urls = [1, 2, 3].map((i) => `${fixture.url}/p/${i}`);
    const id = (await api(s.url, "/v2/batch/scrape", { body: { urls } })).body.id as string;
    const first = await jobDone(s.url, "batch/scrape", id);
    expect(await s.stop()).toBe(0);
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      s = await start(dataDir, url);
      const again = await readJob(s.url, "batch/scrape", id);
      expect(again.status).toBe("completed");
      expect(again.data.map((d) => d.markdown)).toEqual(first.data.map((d) => d.markdown));
      await s.stop(signal);
    }
  }, 120_000);

  test("a crawl interrupted by kill -9 finishes after a restart with every page once, on S3", async () => {
    const url = `s3://${BUCKET}/${prefix()}`;
    const dataDir = tempDir();
    let s = await start(dataDir, url);
    const id = (await api(s.url, "/v2/crawl", { body: { url: `${fixture.url}/`, limit: PAGES + 1, sitemap: "skip", maxConcurrency: 3 } }))
      .body.id as string;
    await until(async () => ((await api(s.url, `/v2/crawl/${id}`)).body.completed >= 8 ? true : undefined), 60_000, 20);
    expect((await api(s.url, `/v2/crawl/${id}`)).body.status).toBe("scraping");
    await s.stop("SIGKILL");
    s = await start(dataDir, url);
    const done = await jobDone(s.url, "crawl", id, 180_000);
    expect(done).toMatchObject({ status: "completed", completed: PAGES + 1, total: PAGES + 1 });
    const urls = done.data.map((d) => d.metadata.sourceURL);
    expect(new Set(urls).size).toBe(PAGES + 1);
    await s.stop();
  }, 300_000);

  test("wrong credentials: the write failure is reported on the job, nothing is claimed as stored", async () => {
    const s = await start(tempDir(), `s3://${BUCKET}/${prefix()}`, "not-the-secret");
    const id = (await api(s.url, "/v2/batch/scrape", { body: { urls: [`${fixture.url}/p/1`, `${fixture.url}/p/2`] } })).body.id as string;
    const done = await jobDone(s.url, "batch/scrape", id);
    // No document is reported as stored, and the cause is in the errors, in words.
    expect(done.completed).toBe(0);
    expect(done.data).toEqual([]);
    const { errors } = (await api(s.url, `/v2/batch/scrape/${id}/errors`)).body as { errors: Array<{ url: string; error: string }> };
    expect(errors).toHaveLength(2);
    for (const e of errors) expect(e.error).toMatch(/signature|credential|access|denied|forbidden|auth/i);
    await s.stop();
  }, 60_000);

  test("wrong credentials on a restart: documents are left out of the page with a warning, and come back with the right key", async () => {
    const url = `s3://${BUCKET}/${prefix()}`;
    const dataDir = tempDir();
    let s = await start(dataDir, url);
    const id = (await api(s.url, "/v2/batch/scrape", { body: { urls: [1, 2].map((i) => `${fixture.url}/p/${i}`) } })).body.id as string;
    await jobDone(s.url, "batch/scrape", id);
    await s.stop();

    s = await start(dataDir, url, "not-the-secret");
    const blind = await api(s.url, `/v2/batch/scrape/${id}`);
    // Loud, never silent: either the request fails with the S3 error in its message (what sex does for a bad signature,
    // as a 500), or the documents are left out and a warning is logged (what the README describes for a missing permission).
    // What it must not do is return an empty or partial page as if that were the job's result.
    if (blind.status === 200) {
      expect(blind.body.data).toEqual([]);
      expect(s.stderr()).toMatch(/warn/i);
    } else {
      expect(blind.status).toBe(500);
      expect(blind.body.error).toMatch(/signature|credential|access|denied|forbidden|auth/i);
      expect(s.stderr()).toContain("ERROR");
    }
    await s.stop();

    s = await start(dataDir, url);
    const back = await readJob(s.url, "batch/scrape", id);
    expect(back.data).toHaveLength(2);
    await s.stop();
  }, 120_000);
});
