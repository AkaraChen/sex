import { afterAll, describe, expect, test } from "bun:test";
import { startCountingProxy } from "@searxng-js/sex-testing";
import { bin } from "../lib/bin.ts";
import { api, envFor, killAll, run, serve, until } from "../lib/proc.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { mockSearx, pagesSite, plain } from "./support.ts";

const lite = bin("sex-lite");
const pages = pagesSite();
const searx = mockSearx(() => [{ url: `${pages.url}/article`, title: "Article", content: "the article" }]);
afterAll(async () => {
  pages.stop();
  searx.stop();
  await killAll();
  removeTempDirs();
});

const fetchPlain = (args: string[] = [], env: Record<string, string | undefined> = {}) =>
  run(lite, ["fetch", `${pages.url}/plain`, ...args], { env });

describe("precedence: flag > SEX_* env > default", () => {
  test("--timeout beats SEX_TIMEOUT (tight flag, loose env)", async () => {
    const t = Date.now();
    const r = await run(lite, ["fetch", `${pages.url}/slow?ms=20000`, "--timeout", "1000"], { env: { SEX_TIMEOUT: "120000" } });
    expect(r.stderr).toContain("SCRAPE_TIMEOUT");
    expect(Date.now() - t).toBeLessThan(15_000);
  });

  test("--timeout beats SEX_TIMEOUT (loose flag, tight env)", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/slow?ms=2500`, "--timeout", "30000"], { env: { SEX_TIMEOUT: "1000" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Slow page");
  });

  test("SEX_TIMEOUT beats the 30 s default", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/slow?ms=20000`], { env: { SEX_TIMEOUT: "1000" } });
    expect(r.stderr).toContain("SCRAPE_TIMEOUT");
  });

  test("the default timeout lets a 2.5 s page through", async () => {
    const r = await run(lite, ["fetch", `${pages.url}/slow?ms=2500`]);
    expect(r.code).toBe(0);
  });

  test("--allow-private-network beats SEX_ALLOW_PRIVATE_NETWORK=0", async () => {
    const r = await fetchPlain(["--allow-private-network"], { SEX_ALLOW_PRIVATE_NETWORK: "0" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("plain text");
  });

  test("--user-agent beats SEX_USER_AGENT beats the default Chrome UA", async () => {
    const ua = async (args: string[], env: Record<string, string> = {}) =>
      (await run(lite, ["fetch", `${pages.url}/ua`, "--json", ...args], { env })).json().data.markdown as string;
    expect(await ua(["--user-agent", "from-flag/1"], { SEX_USER_AGENT: "from-env/1" })).toContain("from-flag/1");
    expect(await ua([], { SEX_USER_AGENT: "from-env/1" })).toContain("from-env/1");
    expect(await ua([])).toMatch(/Mozilla\/5\.0 .*Chrome\//);
  });

  test("--searxng-url beats SEX_SEARXNG_URL", async () => {
    const r = await run(lite, ["search", "q", "--searxng-url", searx.url], { env: { SEX_SEARXNG_URL: "http://127.0.0.1:9" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Article");
  });

  test("SEX_SEARXNG_URL beats the embedded SearXNG (nothing is started)", async () => {
    const r = await run(lite, ["search", "q"], { env: { SEX_SEARXNG_URL: searx.url } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  test("--max-body-bytes does not exist, SEX_MAX_BODY_BYTES is env only", async () => {
    const r = await fetchPlain(["--max-body-bytes", "10"]);
    // Unknown flags are ignored or refused, but they never change the limit.
    expect(r.stdout + r.stderr).not.toContain("RESPONSE_TOO_LARGE");
  });

  test("serve: PORT and HOST from the environment, --port / --host from the flags beat them", async () => {
    const free = async () => {
      const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
      const p = s.port as number;
      await s.stop(true);
      return p;
    };
    const start = (args: string[], env: Record<string, string>) =>
      Bun.spawn([lite, "serve", ...args], {
        env: envFor({ SEX_SEARXNG_URL: searx.url, ...env }),
        stdout: "ignore",
        stderr: "pipe",
        stdin: "ignore",
      });
    const envPort = await free();
    const a = start([], { PORT: String(envPort), HOST: "127.0.0.1" });
    try {
      const h = await until(async () => (await api(`http://127.0.0.1:${envPort}`, "/health").catch(() => undefined))?.status, 30_000);
      expect(h).toBe(200);
    } finally {
      a.kill("SIGTERM");
      await a.exited;
    }
    const flagPort = await free();
    const b = start(["--port", String(flagPort)], { PORT: String(envPort) });
    try {
      expect(await until(async () => (await api(`http://127.0.0.1:${flagPort}`, "/health").catch(() => undefined))?.status, 30_000)).toBe(
        200,
      );
      await expect(api(`http://127.0.0.1:${envPort}`, "/health")).rejects.toThrow();
    } finally {
      b.kill("SIGTERM");
      await b.exited;
    }
  }, 90_000);
});

describe("values", () => {
  test("empty and blank values count as unset", async () => {
    for (const v of ["", "   "]) {
      const r = await fetchPlain([], { SEX_TIMEOUT: v, SEX_CONCURRENCY: v, SEX_ALLOW_PRIVATE_NETWORK: v, SEX_USER_AGENT: v });
      expect(r.code, JSON.stringify(v)).toBe(0);
    }
  });

  test("booleans: 1/true/yes/on and 0/false/no/off, any case, trimmed", async () => {
    for (const v of ["1", "true", "TRUE", "Yes", " on ", "On"]) {
      expect((await fetchPlain([], { SEX_ALLOW_PRIVATE_NETWORK: v })).code, v).toBe(0);
    }
    for (const v of ["0", "false", "No", "OFF", " off "]) {
      const r = await fetchPlain([], { SEX_ALLOW_PRIVATE_NETWORK: v });
      expect(r.stderr, v).toContain("PRIVATE_NETWORK_BLOCKED");
    }
  });

  test("SEX_PROXY_URL: fetches go through the proxy, which sees the absolute-form request", async () => {
    // A public IP literal passes the SSRF check without DNS; the proxy delivers it to the local page.
    const proxy = await startCountingProxy((u) => new URL(`${pages.url}${u.pathname}${u.search}`));
    try {
      const r = await run(lite, ["fetch", "http://93.184.216.34/article"], {
        env: { SEX_PROXY_URL: proxy.url, SEX_ALLOW_PRIVATE_NETWORK: "0" },
      });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("# Heading One");
      expect(proxy.requests.map((q) => q.url)).toEqual(["http://93.184.216.34/article"]);
    } finally {
      proxy.close();
    }
  });
});

describe("invalid values fail at startup with CONFIG_INVALID, exit 2, nothing on stdout", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["SEX_TIMEOUT", { SEX_TIMEOUT: "abc" }],
    ["SEX_TIMEOUT", { SEX_TIMEOUT: "0" }],
    ["SEX_TIMEOUT", { SEX_TIMEOUT: "-5" }],
    ["SEX_TIMEOUT", { SEX_TIMEOUT: "1.5" }],
    ["SEX_CONCURRENCY", { SEX_CONCURRENCY: "0" }],
    ["SEX_ALLOW_PRIVATE_NETWORK", { SEX_ALLOW_PRIVATE_NETWORK: "maybe" }],
    ["SEX_MAX_BODY_BYTES", { SEX_MAX_BODY_BYTES: "10" }],
    ["SEX_EXTRACT_WORKERS", { SEX_EXTRACT_WORKERS: "-1" }],
    ["SEX_SEARXNG_URL", { SEX_SEARXNG_URL: "not a url" }],
    ["SEX_SEARXNG_URL", { SEX_SEARXNG_URL: "ftp://example.com" }],
    ["SEX_PROXY_URL", { SEX_PROXY_URL: "nonsense" }],
    ["SEX_STRICT_REQUESTS", { SEX_STRICT_REQUESTS: "sometimes" }],
  ];
  for (const [name, env] of cases) {
    test(`${JSON.stringify(env)}`, async () => {
      const r = await fetchPlain([], env);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("error: CONFIG_INVALID:");
      expect(r.stderr).toContain(name);
    });
  }

  test("invalid flags: --timeout 0, --concurrency x", async () => {
    for (const args of [
      ["--timeout", "0"],
      ["--timeout", "abc"],
      ["--concurrency", "x"],
    ]) {
      const r = await fetchPlain(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("CONFIG_INVALID");
    }
  });

  test("the same check runs for search and serve (serve never starts listening)", async () => {
    const s = await run(lite, ["search", "q"], { env: { SEX_TIMEOUT: "abc", SEX_SEARXNG_URL: searx.url } });
    expect(s.code).toBe(2);
    expect(s.stderr).toContain("CONFIG_INVALID");
    const v = await run(lite, ["serve", "--port", "0"], { env: { SEX_TIMEOUT: "abc" }, timeoutMs: 30_000 });
    expect(v.code).toBe(2);
    expect(v.stderr).toContain("CONFIG_INVALID");
    expect(v.stderr).not.toContain("listening");
  });

  test("a proxy URL with credentials is never echoed back", async () => {
    const r = await fetchPlain([], { SEX_PROXY_URL: "ftp://user:hunter2@proxy.example:3128" });
    expect(r.code).toBe(2);
    expect(r.stderr).not.toContain("hunter2");
    const stealth = await fetchPlain([], { SEX_STEALTH_PROXY_URL: "ftp://user:hunter3@proxy.example:3128" });
    expect(stealth.code).toBe(2);
    expect(stealth.stderr).not.toContain("hunter3");
  });

  // BUG: an invalid PORT / --port is not reported like every other invalid setting. `PORT=abc serve` dies with an
  // uncaught AppError and a stack dump (exit 1, not "error: CONFIG_INVALID: ..." with exit 2); `serve --port 99999`
  // dies with a RangeError dump; `serve --port abc` silently listens on 3002. README: "非法值在启动时直接失败：CLI 打印
  // error: CONFIG_INVALID ... 退出码 2".
  // Repro: PORT=abc sex-lite serve; sex-lite serve --port 99999; sex-lite serve --port abc.
  test.failing("an invalid PORT or --port is CONFIG_INVALID, exit 2", async () => {
    for (const [args, env] of [
      [["serve"], { PORT: "abc" }],
      [["serve", "--port", "99999"], {}],
      [["serve", "--port", "abc"], {}],
    ] as const) {
      const r = await run(lite, [...args], { env: { ...env, HOST: "127.0.0.1" }, timeoutMs: 8000 });
      expect(r.code, JSON.stringify([args, env])).toBe(2);
      expect(plain(r.stderr)).toContain("error: CONFIG_INVALID:");
    }
  });
});

describe("logging", () => {
  // `search` against a dead SearXNG logs a debug line ("retrying SearXNG request") before it fails.
  const dead = ["search", "q"];
  const env = { SEX_SEARXNG_URL: "http://127.0.0.1:9" };

  test("--log-level debug shows DEBUG lines on stderr, stdout stays empty", async () => {
    const r = await run(lite, [...dead, "--log-level", "debug"], { env });
    expect(r.stderr).toMatch(/\d{4}-\d\d-\d\dT[\d:.]+Z DEBUG retrying SearXNG request/);
    expect(r.stdout).toBe("");
  });

  test("SEX_LOG_LEVEL=debug does the same", async () => {
    const r = await run(lite, dead, { env: { ...env, SEX_LOG_LEVEL: "debug" } });
    expect(r.stderr).toContain("DEBUG retrying SearXNG request");
  });

  test("the default level (info) hides debug lines", async () => {
    const r = await run(lite, dead, { env });
    expect(r.stderr).not.toContain("DEBUG");
    expect(r.stderr).toContain("error: SEARCH_BACKEND_UNAVAILABLE");
  });

  test("the flag beats the variable in both directions", async () => {
    const quiet = await run(lite, [...dead, "--log-level", "warn"], { env: { ...env, SEX_LOG_LEVEL: "debug" } });
    expect(quiet.stderr).not.toContain("DEBUG");
    const loud = await run(lite, [...dead, "--log-level", "debug"], { env: { ...env, SEX_LOG_LEVEL: "silent" } });
    expect(loud.stderr).toContain("DEBUG");
  });

  test("silent / error hide log lines but the final 'error:' line stays", async () => {
    for (const level of ["silent", "error"]) {
      const r = await run(lite, [...dead, "--log-level", level], { env });
      expect(r.stderr, level).not.toMatch(/ (DEBUG|INFO|WARN) /);
      expect(r.stderr, level).toContain("error: SEARCH_BACKEND_UNAVAILABLE");
    }
  });

  test("warn level shows warnings (empty search with unresponsive engines)", async () => {
    const empty = mockSearx(() => Response.json({ results: [], unresponsive_engines: [["google", "CAPTCHA"]] }));
    try {
      const shown = await run(lite, ["search", "q", "--log-level", "warn"], { env: { SEX_SEARXNG_URL: empty.url } });
      expect(shown.stderr).toContain("WARN No results; unresponsive engines: google: CAPTCHA");
      const hidden = await run(lite, ["search", "q", "--log-level", "error"], { env: { SEX_SEARXNG_URL: empty.url } });
      expect(hidden.stderr).toBe("");
    } finally {
      empty.stop();
    }
  });

  test("serve logs its URL and one access line per request at info", async () => {
    const s = await serve(lite, [], { env: { SEX_SEARXNG_URL: searx.url } });
    try {
      await api(s.url, "/v2/search", { body: { query: "q" } });
      await until(() => (s.stderr().includes("path=/v2/search") ? true : undefined), 5000);
      expect(s.stderr()).toMatch(/INFO http server listening url=http:\/\/127\.0\.0\.1:\d+ docs=\S+\/docs mcp=\S+\/mcp/);
      expect(s.stderr()).toMatch(/INFO http method=POST path=\/v2\/search status=200 ms=\d+ rid=/);
    } finally {
      await s.stop();
    }
  }, 120_000);
});
