// sex-lite (and so the core it is built from) runs on Node: the CLI and the HTTP server, started from source with a
// plain `node` (type stripping, no flags). Skipped when `node` is not on PATH.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFixtureSite, startMockSearxng, waitFor } from "@sex/core/test/helpers.ts";

const node = Bun.which("node");
const CLI = resolve(import.meta.dir, "../src/cli.ts");

let site: ReturnType<typeof startFixtureSite>;
let searxng: ReturnType<typeof startMockSearxng>;

beforeAll(() => {
  site = startFixtureSite();
  searxng = startMockSearxng(site.url);
});

afterAll(() => {
  site.stop();
  searxng.stop();
});

// Minimal env so no SEX_* variables from the developer's shell leak into the run.
const spawn = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawn([node as string, CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SEX_SEARXNG_URL: searxng.url, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

const run = async (args: string[], env?: Record<string, string>) => {
  const proc = spawn(args, env);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
};

describe.skipIf(!node)("sex-lite on Node", () => {
  for (const workers of ["0", "1"]) {
    test(`fetch prints markdown (SEX_EXTRACT_WORKERS=${workers})`, async () => {
      const { code, stdout, stderr } = await run(["fetch", `${site.url}/docs/a`], { SEX_EXTRACT_WORKERS: workers });
      expect(stderr).not.toContain("Error");
      expect(code).toBe(0);
      expect(stdout).toContain("Paragraph 1 about doc a");
    }, 20_000);
  }

  test("fetch reads --options from a file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sex-lite-node-")), "options.json");
    writeFileSync(file, JSON.stringify({ formats: ["links"] }));
    const { code, stdout } = await run(["fetch", `${site.url}/`, "--options", file]);
    expect(code).toBe(0);
    expect(stdout).toContain(`${site.url}/docs/b`);
  }, 20_000);

  test("search", async () => {
    const { code, stdout } = await run(["search", "doc"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Doc B");
  }, 20_000);

  test("serve answers /health and /v2/scrape, and stops on SIGTERM", async () => {
    const proc = spawn(["serve", "--port", "0"], { SEX_ALLOW_PRIVATE_NETWORK: "1", SEX_EXTRACT_WORKERS: "1" });
    let log = "";
    const reader = (async () => {
      for await (const chunk of proc.stderr) log += new TextDecoder().decode(chunk);
    })();
    try {
      const base = await waitFor(() => /listening url=(http:\/\/\S+)/.exec(log)?.[1]);
      expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ status: "ok" });
      const res = await fetch(`${base}/v2/scrape`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `${site.url}/docs/b` }),
      });
      const body = (await res.json()) as { success: boolean; data: { markdown: string } };
      expect(body.success).toBe(true);
      expect(body.data.markdown).toContain("Paragraph 1 about doc b");
    } finally {
      proc.kill("SIGTERM");
    }
    expect(await proc.exited).toBe(0);
    await reader;
  }, 30_000);
});
