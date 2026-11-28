#!/usr/bin/env bun
import { basename } from "node:path";
import type { SearchRequest } from "@searxng-js/sex-search";
import { type CommandDef, defineCommand, renderUsage, runCommand } from "citty";
import { type Config, loadConfig } from "./config.ts";
import { Engine } from "./engine.ts";
import { failure } from "./errors.ts";
import { createApp } from "./http.ts";
import { createLogger, type Logger } from "./log.ts";
import { runStdio } from "./mcp.ts";
import { VERSION } from "./version.ts";

export interface SignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface ServeHandle {
  port?: number;
  stop: () => void | Promise<void>;
}

export interface ServeOptions {
  hostname: string;
  port: number;
  fetch: (request: Request) => Response | Promise<Response>;
}

export interface CliDeps {
  createEngine?: (config: Config, log: Logger) => Engine;
  runStdio?: typeof runStdio;
  serve?: (options: ServeOptions) => ServeHandle;
  signals?: SignalSource;
  exit?: (code: number) => void;
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
}

const serveArgs = {
  host: {
    type: "string",
    description: "Bind host (env SEX_HOST, default 127.0.0.1)",
    valueHint: "host",
  },
  port: {
    type: "string",
    description: "Bind port (env SEX_PORT, default 3002)",
    valueHint: "port",
  },
} as const;

function buildEngine(
  deps: CliDeps,
  envOverrides: Record<string, string | undefined> = {},
): { config: Config; log: Logger; engine: Engine } {
  const config = loadConfig({ ...(deps.env ?? process.env), ...envOverrides });
  const log = createLogger(config.logLevel);
  const engine = (deps.createEngine ?? ((c, l) => new Engine(c, l)))(config, log);
  return { config, log, engine };
}

async function withEngine(deps: CliDeps, fn: (engine: Engine) => Promise<void>): Promise<void> {
  const { engine } = buildEngine(deps);
  try {
    await fn(engine);
  } finally {
    await engine.close();
  }
}

function createCli(deps: CliDeps = {}) {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));

  const serve = defineCommand({
    meta: {
      name: "serve",
      description: "Start the Firecrawl v2 HTTP API server on 127.0.0.1:3002 (default)",
    },
    args: serveArgs,
    run({ args }) {
      const { config, log, engine } = buildEngine(deps, {
        ...(args.host ? { SEX_HOST: args.host } : {}),
        ...(args.port ? { SEX_PORT: args.port } : {}),
      });
      const app = createApp(engine);
      const startServer = deps.serve ?? ((options: ServeOptions) => Bun.serve(options));
      const server = startServer({
        hostname: config.host,
        port: config.port,
        fetch: (request) => app.fetch(request),
      });
      log.info("listening", { url: `http://${config.host}:${server.port}`, ...engine.describe() });
      void engine.warmup();

      const signals = deps.signals ?? process;
      const exit = deps.exit ?? ((code: number) => process.exit(code));
      let closing = false;
      const onSignal = () => {
        if (closing) return;
        closing = true;
        signals.off("SIGINT", onSignal);
        signals.off("SIGTERM", onSignal);
        void (async () => {
          try {
            await engine.close().catch(() => {});
            await server.stop();
          } finally {
            exit(0);
          }
        })();
      };
      signals.once("SIGINT", onSignal);
      signals.once("SIGTERM", onSignal);
    },
  });

  const scrape = defineCommand({
    meta: {
      name: "scrape",
      description: "Scrape a URL and print JSON or markdown",
    },
    args: {
      url: {
        type: "positional",
        description: "URL to scrape",
        required: true,
      },
      markdown: {
        type: "boolean",
        description: "Print markdown content only",
      },
      format: {
        type: "string",
        description: "Comma-separated output formats (e.g. markdown,links)",
        valueHint: "formats",
      },
    },
    async run({ args }) {
      const formats = args.format
        ? args.format
            .split(",")
            .map((format) => format.trim())
            .filter(Boolean)
        : args.markdown
          ? ["markdown"]
          : undefined;
      await withEngine(deps, async (engine) => {
        const { data } = await engine.scrape({ url: args.url, formats });
        stdout(args.markdown ? String(data.markdown ?? "") : JSON.stringify({ success: true, data }, null, 2));
      });
    },
  });

  const search = defineCommand({
    meta: {
      name: "search",
      description: "Search the web via SearXNG or configured search providers",
    },
    args: {
      query: {
        type: "positional",
        description: "Search query (multiple words allowed)",
        required: true,
      },
      limit: {
        type: "string",
        description: "Maximum number of results (positive integer)",
        valueHint: "n",
      },
    },
    async run({ args }) {
      const query = args._.join(" ").trim();
      if (!query) throw new Error("search needs a non-empty query");
      const limit = args.limit !== undefined ? Number(args.limit) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
        throw new Error(`--limit must be a positive integer, got "${args.limit}"`);
      }
      const request: SearchRequest = { query, ...(limit !== undefined ? { limit } : {}) };
      await withEngine(deps, async (engine) => {
        const { data, warning, provider } = await engine.search(request);
        stdout(JSON.stringify({ data, provider, ...(warning ? { warning } : {}) }, null, 2));
      });
    },
  });

  const map = defineCommand({
    meta: {
      name: "map",
      description: "Discover URLs on a website",
    },
    args: {
      url: {
        type: "positional",
        description: "URL to map",
        required: true,
      },
    },
    async run({ args }) {
      await withEngine(deps, async (engine) => {
        stdout(JSON.stringify(await engine.map({ url: args.url }), null, 2));
      });
    },
  });

  const parse = defineCommand({
    meta: {
      name: "parse",
      description: "Convert a local document to markdown via here-docs",
    },
    args: {
      file: {
        type: "positional",
        description: "Path to the file to parse",
        required: true,
      },
    },
    async run({ args }) {
      const file = Bun.file(args.file);
      if (!(await file.exists())) throw new Error(`no such file: ${args.file}`);
      await withEngine(deps, async (engine) => {
        stdout(JSON.stringify(await engine.parse(new File([await file.arrayBuffer()], basename(args.file))), null, 2));
      });
    },
  });

  const mcp = defineCommand({
    meta: {
      name: "mcp",
      description: "Serve the MCP tools over stdio",
    },
    async run() {
      const { engine } = buildEngine(deps);
      await runMcp(engine, deps);
    },
  });

  const version = defineCommand({
    meta: {
      name: "version",
      description: "Print the sex version",
    },
    run() {
      stdout(VERSION);
    },
  });

  const subCommands: Record<string, CommandDef<any>> = {
    serve,
    scrape,
    search,
    map,
    parse,
    mcp,
    version,
  };

  const root = defineCommand({
    meta: {
      name: "sex",
      version: VERSION,
      description: "Self-hosted Firecrawl v2 API, MCP server, and web CLI",
    },
    args: serveArgs,
    default: "serve",
    subCommands: {
      ...subCommands,
      help: defineCommand({
        meta: { name: "help", hidden: true },
        args: { command: { type: "positional", required: false } },
        async run({ args }) {
          const sub = args.command ? subCommands[args.command] : undefined;
          if (args.command && !sub) throw new Error(`Unknown command ${args.command}`);
          stdout(await renderUsage(sub ?? root, sub ? root : undefined));
        },
      }),
    },
  });

  return { root, subCommands };
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const { root, subCommands } = createCli(deps);

  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    stdout(VERSION);
    return;
  }

  const endOfOptions = argv.indexOf("--");
  const flagsPart = endOfOptions === -1 ? argv : argv.slice(0, endOfOptions);
  if (flagsPart.includes("--help") || flagsPart.includes("-h")) {
    const sub = argv[0] ? subCommands[argv[0]] : undefined;
    stdout(await renderUsage(sub ?? root, sub ? root : undefined));
    return;
  }

  await runCommand(root, { rawArgs: argv });
}

export async function runMcp(engine: Engine, deps: Pick<CliDeps, "runStdio" | "signals" | "exit"> = {}): Promise<void> {
  const serve = deps.runStdio ?? runStdio;
  const signals = deps.signals ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const controller = new AbortController();

  let closing: Promise<void> | undefined;
  const closeEngine = () => {
    if (!closing) closing = engine.close();
    return closing;
  };

  let signaled = false;
  const onSignal = () => {
    if (signaled) return;
    signaled = true;
    controller.abort();
    void closeEngine()
      .catch(() => {})
      .finally(() => exit(0));
  };

  signals.once("SIGINT", onSignal);
  signals.once("SIGTERM", onSignal);
  try {
    await serve(engine, { signal: controller.signal });
  } finally {
    try {
      await closeEngine();
    } finally {
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
    }
  }
}

export function run(argv = process.argv.slice(2)): void {
  main(argv).catch(async (err) => {
    if (err instanceof Error && err.name === "CLIError") {
      const { root, subCommands } = createCli();
      const sub = argv[0] ? subCommands[argv[0]] : undefined;
      console.error(err.message);
      console.error("");
      console.error(await renderUsage(sub ?? root, sub ? root : undefined));
    } else {
      console.error(failure(err).message);
    }
    process.exitCode = 1;
  });
}

if (import.meta.main) run();
