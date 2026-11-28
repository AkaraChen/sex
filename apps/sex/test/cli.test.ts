import { afterAll, beforeAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { main, runMcp } from "../src/cli.ts";
import type { Config } from "../src/config.ts";
import { Engine } from "../src/engine.ts";
import { createLogger } from "../src/log.ts";
import { runStdio } from "../src/mcp.ts";
import { VERSION } from "../src/version.ts";

let dir: string;
let sampleFile: string;
let localStub: string;

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

/**
 * Fake firecrawl-local for subprocess CLI tests: serves `/health`, records its PID and SIGTERM receipt
 * in files named by `STUB_PID_FILE` / `STUB_STOP_FILE`, and optionally fails `/v2/scrape` with 500.
 */
const LOCAL_STUB = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const port = Number(value("--port"));
const token = value("--token");
if (process.env.STUB_PID_FILE) writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (request.headers.get("authorization") !== "Bearer " + token) {
      return Response.json({ success: false, error: "unauthorized" }, { status: 401 });
    }
    if (process.env.STUB_FAIL === "1") {
      return Response.json({ success: false, error: "boom" }, { status: 500 });
    }
    return Response.json({ success: true, data: { title: "Stub", markdown: "# stub" } });
  },
});
process.on("SIGTERM", () => {
  if (process.env.STUB_STOP_FILE) writeFileSync(process.env.STUB_STOP_FILE, "SIGTERM");
  void server.stop(true).finally(() => process.exit(0));
});
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sex-cli-test-"));
  sampleFile = join(dir, "sample.txt");
  await writeFile(sampleFile, "hello");
  localStub = join(dir, "firecrawl-local");
  await writeFile(localStub, LOCAL_STUB);
  await chmod(localStub, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function createSpyEngine(
  config: Config,
  overrides: Partial<Pick<Engine, "scrape" | "search" | "map" | "parse" | "close" | "warmup">> = {},
): { engine: Engine; closeCount: () => number } {
  const engine = new Engine(config, createLogger("error"));
  let closes = 0;
  const originalClose = engine.close.bind(engine);
  engine.close = async () => {
    closes++;
    if (overrides.close) await overrides.close();
    else await originalClose();
  };
  if (overrides.scrape) engine.scrape = overrides.scrape;
  if (overrides.search) engine.search = overrides.search;
  if (overrides.map) engine.map = overrides.map;
  if (overrides.parse) engine.parse = overrides.parse;
  if (overrides.warmup) engine.warmup = overrides.warmup;
  return { engine, closeCount: () => closes };
}

async function runCliSubprocess(args: string[]) {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    env: { ...process.env, NO_COLOR: "1", SEX_LOG_LEVEL: "error" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

// --- version & help ---

test("version subcommand and --version / -v flags output pure version string", async () => {
  for (const argv of [["version"], ["--version"], ["-v"]]) {
    const out: string[] = [];
    await main(argv, { stdout: (line) => out.push(line) });
    expect(out).toEqual([VERSION]);
  }
});

test("help outputs root usage with all subcommands", async () => {
  for (const argv of [["--help"], ["-h"], ["help"]]) {
    const out: string[] = [];
    await main(argv, { stdout: (line) => out.push(line) });
    expect(out.length).toBe(1);
    const text = out[0]!;
    for (const cmd of ["serve", "scrape", "search", "map", "parse", "mcp", "version"]) {
      expect(text).toContain(cmd);
    }
  }
});

test("subcommand --help / -h shows only that subcommand's options", async () => {
  const serveOut: string[] = [];
  await main(["serve", "--help"], { stdout: (line) => serveOut.push(line) });
  expect(serveOut[0]).toContain("--host");
  expect(serveOut[0]).toContain("--port");
  expect(serveOut[0]).not.toContain("--markdown");
  expect(serveOut[0]).not.toContain("--limit");

  const scrapeOut: string[] = [];
  await main(["scrape", "-h"], { stdout: (line) => scrapeOut.push(line) });
  expect(scrapeOut[0]).toContain("--markdown");
  expect(scrapeOut[0]).toContain("--format");
  expect(scrapeOut[0]).not.toContain("--port");
  expect(scrapeOut[0]).not.toContain("--limit");

  const searchOut: string[] = [];
  await main(["help", "search"], { stdout: (line) => searchOut.push(line) });
  expect(searchOut[0]).toContain("--limit");
  expect(searchOut[0]).not.toContain("--markdown");
  expect(searchOut[0]).not.toContain("--port");
});

test("unknown command and unknown help target reject", async () => {
  await expect(main(["bogus"])).rejects.toThrow(/Unknown command.*bogus/);
  await expect(main(["help", "bogus"])).rejects.toThrow(/Unknown command.*bogus/);
});

// --- serve & default command ---

test("default command (no args) runs serve with default host/port and cleans up on SIGTERM", async () => {
  const signals = new EventEmitter();
  const exits: number[] = [];
  let listened: { hostname: string; port: number } | undefined;
  let stopped = 0;
  let closeCount = () => 0;

  await main([], {
    env: { SEX_LOG_LEVEL: "error" },
    createEngine: (config) => {
      const spy = createSpyEngine(config, { warmup: async () => {} });
      closeCount = spy.closeCount;
      return spy.engine;
    },
    serve: ({ hostname, port }) => {
      listened = { hostname, port };
      return {
        port,
        stop: () => {
          stopped++;
        },
      };
    },
    signals,
    exit: (code) => exits.push(code),
  });

  expect(listened).toEqual({ hostname: "127.0.0.1", port: 3002 });
  signals.emit("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(closeCount()).toBe(1);
  expect(stopped).toBe(1);
  expect(exits).toEqual([0]);
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
});

test("top-level flags (--port / --host) route to default serve command", async () => {
  for (const [argv, expected] of [
    [["--port", "3003"], { hostname: "127.0.0.1", port: 3003 }],
    [["--host", "0.0.0.0", "--port", "3004"], { hostname: "0.0.0.0", port: 3004 }],
    [["--port=3005"], { hostname: "127.0.0.1", port: 3005 }],
    [["serve", "--host", "0.0.0.0", "--port", "4000"], { hostname: "0.0.0.0", port: 4000 }],
  ] as const) {
    const signals = new EventEmitter();
    let listened: { hostname: string; port: number } | undefined;
    await main([...argv], {
      env: { SEX_LOG_LEVEL: "error" },
      createEngine: (config) => createSpyEngine(config, { warmup: async () => {} }).engine,
      serve: ({ hostname, port }) => {
        listened = { hostname, port };
        return { port, stop: () => {} };
      },
      signals,
      exit: () => {},
    });
    expect(listened).toEqual(expected);
  }
});

test("serve rejects invalid port via loadConfig", async () => {
  let created = 0;
  const deps = {
    createEngine: (config: Config) => {
      created++;
      return createSpyEngine(config).engine;
    },
  };

  await expect(main(["serve", "--port", "abc"], deps)).rejects.toThrow(/SEX_PORT must be a positive integer/);
  await expect(main(["serve", "--port", "0"], deps)).rejects.toThrow(/SEX_PORT must be a positive integer/);
  expect(created).toBe(0);
});

// --- scrape ---

test("scrape parses url, --markdown, and --format options and closes engine", async () => {
  const calls: Array<{ url: string; formats?: unknown[] }> = [];
  const makeDeps = (out: string[]) => {
    let closeCount = () => 0;
    return {
      deps: {
        stdout: (line: string) => out.push(line),
        createEngine: (config: Config) => {
          const spy = createSpyEngine(config, {
            scrape: async (req) => {
              calls.push({ url: req.url, formats: req.formats });
              return { success: true, data: { markdown: "# Hello", links: ["https://example.com"] } };
            },
          });
          closeCount = spy.closeCount;
          return spy.engine;
        },
      },
      closeCount: () => closeCount(),
    };
  };

  const jsonOut: string[] = [];
  const run1 = makeDeps(jsonOut);
  await main(["scrape", "https://example.com"], run1.deps);
  expect(run1.closeCount()).toBe(1);
  expect(JSON.parse(jsonOut[0]!)).toEqual({
    success: true,
    data: { markdown: "# Hello", links: ["https://example.com"] },
  });

  const mdOut: string[] = [];
  const run2 = makeDeps(mdOut);
  await main(["scrape", "https://example.com", "--markdown"], run2.deps);
  expect(run2.closeCount()).toBe(1);
  expect(mdOut).toEqual(["# Hello"]);

  const fmtOut: string[] = [];
  const run3 = makeDeps(fmtOut);
  await main(["scrape", "https://example.com", "--format", "markdown, links"], run3.deps);
  expect(run3.closeCount()).toBe(1);
  expect(JSON.parse(fmtOut[0]!).success).toBe(true);

  expect(calls).toEqual([
    { url: "https://example.com", formats: undefined },
    { url: "https://example.com", formats: ["markdown"] },
    { url: "https://example.com", formats: ["markdown", "links"] },
  ]);
});

test("scrape rejects missing url", async () => {
  await expect(main(["scrape"])).rejects.toThrow(/Missing required positional argument: URL/);
});

// --- search ---

test("search joins multi-word queries, parses --limit, and supports -- separator", async () => {
  const requests: Array<{ query: string; limit?: number }> = [];
  const runSearch = async (argv: string[]) => {
    const out: string[] = [];
    let closeCount = () => 0;
    await main(argv, {
      stdout: (line) => out.push(line),
      createEngine: (config) => {
        const spy = createSpyEngine(config, {
          search: async (req) => {
            requests.push({ query: req.query, limit: req.limit });
            return { data: { web: [] }, provider: "searxng" };
          },
        });
        closeCount = spy.closeCount;
        return spy.engine;
      },
    });
    expect(closeCount()).toBe(1);
    return JSON.parse(out[0]!);
  };

  expect(await runSearch(["search", "hello", "world"])).toEqual({ data: { web: [] }, provider: "searxng" });
  await runSearch(["search", "hello", "world", "--limit", "10"]);
  await runSearch(["search", "--limit", "5", "firecrawl", "rust"]);
  await runSearch(["search", "--", "-foo", "--help"]);

  expect(requests).toEqual([
    { query: "hello world", limit: undefined },
    { query: "hello world", limit: 10 },
    { query: "firecrawl rust", limit: 5 },
    { query: "-foo --help", limit: undefined },
  ]);
});

test("search validates query and positive integer --limit", async () => {
  await expect(main(["search"])).rejects.toThrow(/Missing required positional argument: QUERY/);
  await expect(main(["search", "   "])).rejects.toThrow(/non-empty query/);
  await expect(main(["search", "hello", "--limit", "0"])).rejects.toThrow(/positive integer/);
  await expect(main(["search", "hello", "--limit", "-5"])).rejects.toThrow(/positive integer/);
  await expect(main(["search", "hello", "--limit", "1.5"])).rejects.toThrow(/positive integer/);
  await expect(main(["search", "hello", "--limit", "abc"])).rejects.toThrow(/positive integer/);
  await expect(main(["search", "hello", "--limit"])).rejects.toThrow(/positive integer/);
});

// --- map & parse ---

test("map calls engine.map and rejects missing url", async () => {
  const out: string[] = [];
  let closeCount = () => 0;
  await main(["map", "https://example.com"], {
    stdout: (line) => out.push(line),
    createEngine: (config) => {
      const spy = createSpyEngine(config, {
        map: async ({ url }) => ({ links: [url] }),
      });
      closeCount = spy.closeCount;
      return spy.engine;
    },
  });
  expect(closeCount()).toBe(1);
  expect(JSON.parse(out[0]!)).toEqual({ links: ["https://example.com"] });

  await expect(main(["map"])).rejects.toThrow(/Missing required positional argument: URL/);
});

test("parse reads file, calls engine.parse, and rejects missing or nonexistent file", async () => {
  const out: string[] = [];
  let seenName = "";
  let closeCount = () => 0;
  await main(["parse", sampleFile], {
    stdout: (line) => out.push(line),
    createEngine: (config) => {
      const spy = createSpyEngine(config, {
        parse: async (file) => {
          seenName = file instanceof File ? file.name : "";
          return { success: true, data: { markdown: await file.text() } };
        },
      });
      closeCount = spy.closeCount;
      return spy.engine;
    },
  });
  expect(seenName).toBe("sample.txt");
  expect(closeCount()).toBe(1);
  expect(JSON.parse(out[0]!)).toEqual({ success: true, data: { markdown: "hello" } });

  await expect(main(["parse"])).rejects.toThrow(/Missing required positional argument: FILE/);
  await expect(main(["parse", join(dir, "does-not-exist.txt")])).rejects.toThrow(/no such file/);
});

// --- engine cleanup on failure (PR #107 semantics) ---

test("scrape closes engine when engine.scrape throws", async () => {
  let closeCount = () => 0;
  await expect(
    main(["scrape", "https://example.com"], {
      createEngine: (config) => {
        const spy = createSpyEngine(config, {
          scrape: async () => {
            throw new Error("scrape failed");
          },
        });
        closeCount = spy.closeCount;
        return spy.engine;
      },
    }),
  ).rejects.toThrow("scrape failed");
  expect(closeCount()).toBe(1);
});

test("search closes engine when engine.search throws", async () => {
  let closeCount = () => 0;
  await expect(
    main(["search", "hello", "world"], {
      createEngine: (config) => {
        const spy = createSpyEngine(config, {
          search: async () => {
            throw new Error("search failed");
          },
        });
        closeCount = spy.closeCount;
        return spy.engine;
      },
    }),
  ).rejects.toThrow("search failed");
  expect(closeCount()).toBe(1);
});

test("map closes engine when engine.map throws", async () => {
  let closeCount = () => 0;
  await expect(
    main(["map", "https://example.com"], {
      createEngine: (config) => {
        const spy = createSpyEngine(config, {
          map: async () => {
            throw new Error("map failed");
          },
        });
        closeCount = spy.closeCount;
        return spy.engine;
      },
    }),
  ).rejects.toThrow("map failed");
  expect(closeCount()).toBe(1);
});

test("parse closes engine when engine.parse throws", async () => {
  let closeCount = () => 0;
  await expect(
    main(["parse", sampleFile], {
      createEngine: (config) => {
        const spy = createSpyEngine(config, {
          parse: async () => {
            throw new Error("parse failed");
          },
        });
        closeCount = spy.closeCount;
        return spy.engine;
      },
    }),
  ).rejects.toThrow("parse failed");
  expect(closeCount()).toBe(1);
});

test("mcp closes engine once when stdio transport ends (EOF)", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const signals = new EventEmitter();
  const exits: number[] = [];
  let closeCount = () => 0;

  const running = main(["mcp"], {
    createEngine: (config) => {
      const spy = createSpyEngine(config);
      closeCount = spy.closeCount;
      return spy.engine;
    },
    runStdio: (engine, options) => runStdio(engine, { ...options, transport: new StdioServerTransport(stdin, stdout) }),
    signals,
    exit: (code) => exits.push(code),
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(closeCount()).toBe(0);

  stdin.end();
  await running;

  expect(closeCount()).toBe(1);
  expect(exits).toEqual([]);
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
});

test("mcp closes engine when runStdio throws", async () => {
  const signals = new EventEmitter();
  let closeCount = () => 0;

  await expect(
    main(["mcp"], {
      createEngine: (config) => {
        const spy = createSpyEngine(config);
        closeCount = spy.closeCount;
        return spy.engine;
      },
      runStdio: async () => {
        throw new Error("stdio broken");
      },
      signals,
      exit: () => {},
    }),
  ).rejects.toThrow("stdio broken");

  expect(closeCount()).toBe(1);
  expect(signals.listenerCount("SIGINT")).toBe(0);
  expect(signals.listenerCount("SIGTERM")).toBe(0);
});

test("mcp closes engine idempotently on SIGINT and SIGTERM", async () => {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const signals = new EventEmitter();
    const exits: number[] = [];
    let releaseClose!: () => void;
    const closeBarrier = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      logLevel: "error",
      allowPrivate: false,
      timeoutMs: 1_000,
      searchChain: [],
      searchExcluded: [],
      searchKeys: {},
    };
    const spy = createSpyEngine(config, {
      close: () => closeBarrier,
    });

    const running = runMcp(spy.engine, {
      runStdio: (engine, options) =>
        runStdio(engine, { ...options, transport: new StdioServerTransport(stdin, stdout) }),
      signals,
      exit: (code) => exits.push(code),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spy.closeCount()).toBe(0);

    // Fire both signals back-to-back while engine.close() is still pending to verify idempotency.
    signals.emit(sig);
    signals.emit(sig === "SIGINT" ? "SIGTERM" : "SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spy.closeCount()).toBe(1);
    expect(exits).toEqual([]);

    releaseClose();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(spy.closeCount()).toBe(1);
    expect(exits).toEqual([0]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  }
});

// --- subprocess CLI end-to-end tests ---

test("cli subprocess outputs pure version and help on stdout, and errors only on stderr", async () => {
  for (const args of [["version"], ["--version"], ["-v"]]) {
    const res = await runCliSubprocess(args);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(`${VERSION}\n`);
    expect(res.stderr).toBe("");
  }

  const helpRes = await runCliSubprocess(["--help"]);
  expect(helpRes.code).toBe(0);
  expect(helpRes.stdout).toContain("USAGE sex");
  expect(helpRes.stderr).toBe("");

  const subHelpRes = await runCliSubprocess(["scrape", "--help"]);
  expect(subHelpRes.code).toBe(0);
  expect(subHelpRes.stdout).toContain("--markdown");
  expect(subHelpRes.stderr).toBe("");

  for (const [args, pattern, expectUsage] of [
    [["scrape"], /Missing required positional argument: URL/, true],
    [["bogus"], /Unknown command/, true],
    [["search", "hello", "--limit", "0"], /positive integer/, false],
  ] as const) {
    const res = await runCliSubprocess([...args]);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toMatch(pattern);
    if (expectUsage) expect(res.stderr).toContain("USAGE");
  }
});

test("cli scrape stops started firecrawl-local child process on request failure", async () => {
  const pidFile = join(dir, "scrape.pid");
  const stopFile = join(dir, "scrape.stop");
  const proc = Bun.spawn(["bun", CLI_PATH, "scrape", "https://example.com"], {
    env: {
      ...process.env,
      SEX_LOCAL_PATH: localStub,
      SEX_LOG_LEVEL: "error",
      STUB_PID_FILE: pidFile,
      STUB_STOP_FILE: stopFile,
      STUB_FAIL: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const code = await proc.exited;
  expect(code).toBe(1);
  expect(await new Response(proc.stdout).text()).toBe("");
  expect(await readFile(stopFile, "utf8")).toBe("SIGTERM");
  const childPid = Number(await readFile(pidFile, "utf8"));
  expect(childPid).toBeGreaterThan(0);
  expect(() => process.kill(childPid, 0)).toThrow();
});

async function startMcpAndFetch(tag: string) {
  const pidFile = join(dir, `${tag}.pid`);
  const stopFile = join(dir, `${tag}.stop`);
  const proc = Bun.spawn(["bun", CLI_PATH, "mcp"], {
    env: {
      ...process.env,
      SEX_LOCAL_PATH: localStub,
      SEX_LOG_LEVEL: "error",
      STUB_PID_FILE: pidFile,
      STUB_STOP_FILE: stopFile,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const readLine = async (): Promise<Record<string, unknown>> => {
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        return JSON.parse(line) as Record<string, unknown>;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("unexpected EOF on mcp stdout");
      buf += decoder.decode(value, { stream: true });
    }
  };

  const send = (msg: unknown) => {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
  });
  const initReply = await readLine();
  expect(initReply.id).toBe(1);

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "web_fetch", arguments: { url: "https://example.com" } },
  });
  const toolReply = await readLine();
  expect(toolReply.id).toBe(2);
  expect(JSON.stringify(toolReply)).toContain("# stub");

  const childPid = Number(await readFile(pidFile, "utf8"));
  expect(childPid).toBeGreaterThan(0);

  return { proc, reader, childPid, stopFile };
}

test("cli mcp stops firecrawl-local child process when stdin closes", async () => {
  const { proc, reader, childPid, stopFile } = await startMcpAndFetch("mcp-eof");
  proc.stdin.end();
  const code = await proc.exited;
  reader.releaseLock();

  expect(code).toBe(0);
  expect(await readFile(stopFile, "utf8")).toBe("SIGTERM");
  expect(() => process.kill(childPid, 0)).toThrow();
});

test("cli mcp stops firecrawl-local child process on SIGTERM", async () => {
  const { proc, reader, childPid, stopFile } = await startMcpAndFetch("mcp-sigterm");
  proc.kill("SIGTERM");
  const code = await proc.exited;
  reader.releaseLock();

  expect(code).toBe(0);
  expect(await readFile(stopFile, "utf8")).toBe("SIGTERM");
  expect(() => process.kill(childPid, 0)).toThrow();
});
