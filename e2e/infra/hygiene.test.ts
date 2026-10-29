// Process hygiene of the `sex` binary: signals, child processes, concurrent CLI runs, and configuration that cannot work
// failing at start with a message instead of limping on.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bin } from "../lib/bin.ts";
import { api, killAll, run, until } from "../lib/proc.ts";
import { html, prose, site } from "../lib/sites.ts";
import { removeTempDirs, tempDir } from "../lib/tmp.ts";
import { alive, childrenOf, startSex } from "./support.ts";

const fixture = site((_req, url) =>
  html(`Page ${url.pathname}`, `<main><article><h1>Heading of ${url.pathname}</h1>${prose(url.pathname)}</article></main>`),
);
afterAll(async () => {
  fixture.stop();
  await killAll();
  removeTempDirs();
});

const argsOf = (pid: number) => Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)]).stdout.toString();
/** Direct children of `pid`, named by what they are. */
async function childrenByKind(pid: number) {
  const out: { searxng?: number; lightpanda?: number } = {};
  for (const k of await childrenOf(pid)) {
    const args = argsOf(k);
    if (args.includes("lightpanda")) out.lightpanda = k;
    else if (args.includes("searxng")) out.searxng = k;
  }
  return out;
}

describe.skipIf(process.platform !== "linux")("children of serve: the managed SearXNG and the Lightpanda browser", () => {
  /** Managed SearXNG (no SEX_SEARXNG_URL) and Lightpanda, both warmed up by serve; resolves once both children exist. */
  async function serveWithChildren(extra: string[] = []) {
    const s = await startSex(["--lightpanda", ...extra], { SEX_SEARXNG_URL: undefined });
    const kids = await until(
      async () => {
        const k = await childrenByKind(s.proc.pid);
        return k.searxng && k.lightpanda ? { searxng: k.searxng, lightpanda: k.lightpanda } : undefined;
      },
      90_000,
      200,
    );
    return { s, kids };
  }
  const gone = async (...pids: number[]) => {
    await until(() => (pids.every((p) => !alive(p)) ? true : undefined), 20_000, 100);
    for (const p of pids) expect(alive(p)).toBe(false);
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    test(`${signal}: exits 0 and takes SearXNG and Lightpanda with it`, async () => {
      const { s, kids } = await serveWithChildren();
      expect(await s.stop(signal)).toBe(0);
      await gone(kids.searxng, kids.lightpanda);
    }, 180_000);
  }

  test("SIGKILL: neither child outlives sex (SearXNG exits on its stdin pipe closing, Lightpanda by pdeathsig)", async () => {
    const { s, kids } = await serveWithChildren();
    await s.stop("SIGKILL");
    await gone(kids.searxng, kids.lightpanda);
  }, 180_000);

  test("SIGTERM while a scrape is in flight still exits, and leaves no child", async () => {
    const slow = site(async () => {
      await Bun.sleep(30_000);
      return new Response("late");
    });
    try {
      const { s, kids } = await serveWithChildren(["--allow-private-network"]);
      const pending = fetch(new URL("/v2/scrape", s.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${slow.url}/`, timeout: 60_000 }),
      }).catch(() => undefined);
      await until(() => (slow.hits.length > 0 ? true : undefined), 10_000, 50);
      const started = Date.now();
      s.proc.kill("SIGTERM");
      expect(await s.proc.exited).toBeLessThanOrEqual(1);
      expect(Date.now() - started).toBeLessThan(15_000);
      await pending;
      await gone(kids.searxng, kids.lightpanda);
    } finally {
      slow.stop();
    }
  }, 180_000);
});

describe("concurrent CLI runs", () => {
  const fetchCli = (path: string, extra: string[] = [], env = {}) =>
    run(bin("sex"), ["fetch", `${fixture.url}${path}`, "--allow-private-network", "--log-level", "error", ...extra], {
      env,
      timeoutMs: 120_000,
    });

  test("several fetches at once each print their own page", async () => {
    const paths = ["/a", "/b", "/c", "/d"];
    const results = await Promise.all(paths.map((p) => fetchCli(p)));
    results.forEach((r, i) => {
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Heading of ${paths[i]}`);
      for (const other of paths.filter((p) => p !== paths[i])) expect(r.stdout).not.toContain(`Heading of ${other}`);
    });
  }, 180_000);

  test("several fetches at once on one data dir (shared SQLite files) all succeed", async () => {
    const dataDir = tempDir("sex-e2e-shared-");
    const paths = ["/e", "/f", "/g", "/h"];
    const results = await Promise.all(paths.map((p) => fetchCli(p, [], { SEX_DATA_DIR: dataDir })));
    results.forEach((r, i) => {
      expect([paths[i], r.code, r.stderr.slice(0, 300)]).toEqual([paths[i], 0, ""]);
      expect(r.stdout).toContain(`Heading of ${paths[i]}`);
    });
  }, 180_000);

  test("two fetches with --lightpanda at once: two browsers, two answers", async () => {
    const [a, b] = await Promise.all([fetchCli("/js-a", ["--lightpanda"]), fetchCli("/js-b", ["--lightpanda"])]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout).toContain("Heading of /js-a");
    expect(b.stdout).toContain("Heading of /js-b");
  }, 180_000);
});

describe("a configuration that cannot work fails at start", () => {
  const start = (args: string[], env = {}) => run(bin("sex"), ["serve", "--port", "0", ...args], { env, timeoutMs: 30_000 });

  test("a data dir that is not a directory: non-zero exit, never listening, the path in the message", async () => {
    const base = tempDir("sex-e2e-nodir-");
    const file = join(base, "file");
    writeFileSync(file, "x");
    const dir = join(file, "data");
    const r = await start(["--data-dir", dir]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toContain("http server listening");
    expect(r.stderr).toContain(dir);
  }, 60_000);

  test.skipIf(process.getuid?.() === 0)(
    "a data dir without write permission: non-zero exit, never listening, the path in the message",
    async () => {
      const base = tempDir("sex-e2e-ro-");
      const ro = join(base, "ro");
      mkdirSync(ro, { mode: 0o500 });
      const dir = join(ro, "data");
      const r = await start(["--data-dir", dir]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).not.toContain("http server listening");
      expect(r.stderr).toContain(dir);
    },
    60_000,
  );

  // BUG (UX): an unusable data dir ends in an unhandled exception: stderr is an excerpt of the minified bundle plus a stack
  // trace, where CONFIG_INVALID is a single line. Not security. Delete `.failing` once it is reported like a config error.
  test.failing("a data dir that cannot be created is reported as one line, not a source excerpt and a stack trace", async () => {
    const base = tempDir("sex-e2e-nodir-");
    writeFileSync(join(base, "file"), "x");
    const r = await start(["--data-dir", join(base, "file", "data")]);
    expect(r.stderr).not.toContain("$bunfs");
    expect(r.stderr.trim().split("\n").length).toBeLessThanOrEqual(3);
  }, 60_000);

  test("a port that is taken: non-zero exit with the reason", async () => {
    const taken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    try {
      const r = await run(bin("sex"), ["serve", "--host", "127.0.0.1", "--port", String(taken.port), "--data-dir", tempDir()], {
        timeoutMs: 30_000,
      });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/EADDRINUSE|in use|address/i);
    } finally {
      taken.stop(true);
    }
  }, 60_000);

  const invalidDocumentUrls = [
    "s3://",
    "s3:///prefix-only",
    "ftp://host/path",
    "not a url",
    "s3://bucket/a?x=1",
    "file://relative/path",
    "http://bucket.example/",
  ];
  for (const url of invalidDocumentUrls) {
    test(`SEX_DOCUMENTS_URL=${JSON.stringify(url)} is CONFIG_INVALID`, async () => {
      for (const via of ["flag", "env"] as const) {
        const r = via === "flag" ? await start(["--documents-url", url]) : await start([], { SEX_DOCUMENTS_URL: url });
        expect([via, r.code === 0]).toEqual([via, false]);
        expect(r.stderr).toContain("CONFIG_INVALID");
        expect(r.stderr).toContain("SEX_DOCUMENTS_URL");
        expect(r.stderr).not.toContain("http server listening");
      }
    }, 60_000);
  }

  // BUG (security, low): the CONFIG_INVALID message quotes the whole SEX_DOCUMENTS_URL, so credentials written in the URL
  // (s3://key:secret@bucket/...) land in stderr / the service log. SEX_PROXY_URL is redacted in its errors; this should be too.
  test.failing("an invalid SEX_DOCUMENTS_URL with credentials in it does not echo them", async () => {
    const r = await start(["--documents-url", "s3://AKIAEXAMPLEKEY:SuperSecretValue123@bucket/prefix?bad=1"]);
    expect(r.stderr).toContain("CONFIG_INVALID");
    expect(r.stderr).not.toContain("SuperSecretValue123");
  }, 60_000);

  test("SEX_REDIS_URL is rejected with CONFIG_INVALID (the Redis queue is gone)", async () => {
    const r = await start([], { SEX_REDIS_URL: "redis://127.0.0.1:6379" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("CONFIG_INVALID");
    expect(r.stderr).toContain("SEX_REDIS_URL");
  }, 60_000);

  test("a valid s3:// URL with an unusable endpoint does not stop serve from starting, and /health names the target", async () => {
    // Documents are written when a job stores a page, not at start: the server must come up and say where it will write.
    const s = await startSex(["--documents-url", "s3://some-bucket/some/prefix"], {
      S3_ENDPOINT: "http://127.0.0.1:9",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
    });
    expect((await api(s.url, "/health")).body.documents).toBe("s3://some-bucket/some/prefix");
    await s.stop();
  }, 60_000);
});

describe("an HTML response without markup", () => {
  // BUG (not security): a response served as text/html whose body has no tags at all (even an empty body: a bare "Forbidden",
  // an empty 200) is a 500 EXTRACT_FAILED "Cannot destructure property 'firstElementChild' from null or undefined value", also
  // for a 403, where the caller should get the status. Reproduce: respond 200 text/html with body `hello`, POST /v2/scrape.
  test.failing("is a document with its status code, not EXTRACT_FAILED", async () => {
    const bare = site(
      (_req, url) =>
        new Response(url.pathname === "/empty" ? "" : "Forbidden", {
          status: url.pathname === "/empty" ? 200 : 403,
          headers: { "content-type": "text/html" },
        }),
    );
    const s = await startSex(["--allow-private-network"]);
    try {
      for (const path of ["/text", "/empty"]) {
        const res = await api(s.url, "/v2/scrape", { body: { url: `${bare.url}${path}` } });
        expect([path, res.body.code]).not.toEqual([path, "EXTRACT_FAILED"]);
      }
    } finally {
      bare.stop();
      await s.stop();
    }
  }, 60_000);
});
