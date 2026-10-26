import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { startFixtureSite, startMockSearxng } from "./helpers.ts";

const repoRoot = resolve(import.meta.dir, "..");

// Minimal env so no SEX_* variables from the developer's shell leak into the run.
const cli = async (args: string[]) => {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
};

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

describe("sex fetch", () => {
  test("--options formats html prints the HTML", async () => {
    const { code, stdout } = await cli(["fetch", `${site.url}/`, "--options", '{"formats":["html"]}']);
    expect(code).toBe(0);
    expect(stdout).toContain("<");
    expect(stdout).toContain("Paragraph 1 about home");
  }, 20_000);

  test("default output is markdown", async () => {
    const { code, stdout } = await cli(["fetch", `${site.url}/`]);
    expect(code).toBe(0);
    expect(stdout.startsWith("# ")).toBe(true);
  }, 20_000);
});

describe("sex search validation", () => {
  test("an unknown source is a BAD_REQUEST with exit code 2", async () => {
    const { code, stderr } = await cli(["search", "docs", "--searxng-url", searxng.url, "--sources", "webb"]);
    expect(code).toBe(2);
    expect(stderr).toContain("BAD_REQUEST");
    expect(stderr).toContain("sources");
  }, 20_000);

  test("all sources failing exits 1 with the backend error", async () => {
    const { code, stderr } = await cli(["search", "docs", "--searxng-url", "http://127.0.0.1:1", "--sources", "web,news"]);
    expect(code).toBe(1);
    expect(stderr).toContain("SEARCH_BACKEND_UNAVAILABLE");
  }, 20_000);

  test("--json honours --limit", async () => {
    const { code, stdout } = await cli(["search", "docs", "--searxng-url", searxng.url, "-n", "1", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.data.web).toHaveLength(1);
  }, 20_000);
});

describe("sex mcp", () => {
  test("is no longer a command: MCP is served by `sex serve` at /mcp", async () => {
    const { code, stderr } = await cli(["mcp"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown command");
    expect(stderr).toContain("mcp");
  }, 20_000);
});
