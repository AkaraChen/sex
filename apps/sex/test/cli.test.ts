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
  overrides: Partial<Pick<Engine, "scrape" | "search" | "map" | "parse" | "close">> = {},
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
  return { engine, closeCount: () => closes };
}

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
