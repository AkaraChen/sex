#!/usr/bin/env bun
import { basename } from "node:path";
import type { SearchRequest } from "@searxng-js/sex-search";
import { type ArgsDef, type CittyPlugin, type CommandDef, defineCommand, renderUsage, runCommand } from "citty";
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

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function isUsageError(err: unknown): err is Error {
  return err instanceof CliUsageError || (err instanceof Error && err.name === "CLIError");
}

function parseNonEmpty(raw: string, flag: string): string {
  const value = raw.trim();
  if (!value) throw new CliUsageError(`${flag} must not be empty`);
  return value;
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new CliUsageError(`${flag} must be a positive integer, got "${raw}"`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${flag} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function parsePort(raw: string): number {
  const parsed = parsePositiveInt(raw, "--port");
  if (parsed > 65535) {
    throw new CliUsageError(`--port must be between 1 and 65535, got "${raw}"`);
  }
  return parsed;
}

function parseFormats(raw: string | undefined, markdown: boolean | undefined): string[] | undefined {
  if (raw !== undefined) {
    const formats = raw
      .split(",")
      .map((format) => format.trim())
      .filter(Boolean);
    if (formats.length === 0) {
      throw new CliUsageError(`--format must specify at least one format, got "${raw}"`);
    }
    return formats;
  }
  return markdown ? ["markdown"] : undefined;
}

function validateRawArgs(rawArgs: string[], argsDef: ArgsDef): void {
  const longOptions = new Map<string, "boolean" | "value">();
  const shortOptions = new Map<string, "boolean" | "value">();

  for (const [name, def] of Object.entries(argsDef)) {
    if (def.type === "positional") continue;
    const kind = def.type === "boolean" ? "boolean" : "value";
    longOptions.set(name, kind);
    const aliases = "alias" in def && def.alias ? (Array.isArray(def.alias) ? def.alias : [def.alias]) : [];
    for (const alias of aliases) {
      if (alias.length === 1) shortOptions.set(alias, kind);
      else longOptions.set(alias, kind);
    }
  }

  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === undefined || token === "--") break;

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const flag = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (flag.startsWith("no-") && longOptions.get(flag.slice(3)) === "boolean") {
        if (eq !== -1) throw new CliUsageError(`Option --${flag} does not take a value`);
        continue;
      }
      const kind = longOptions.get(flag);
      if (!kind) throw new CliUsageError(`Unknown option: --${flag}`);
      if (kind === "boolean") {
        if (eq !== -1) throw new CliUsageError(`Option --${flag} does not take a value`);
        continue;
      }
      if (eq === -1) {
        if (i + 1 >= rawArgs.length) throw new CliUsageError(`Option --${flag} requires a value`);
        i++;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const eq = token.indexOf("=");
      const shorts = eq === -1 ? token.slice(1) : token.slice(1, eq);
      for (let j = 0; j < shorts.length; j++) {
        const ch = shorts[j];
        if (ch === undefined) break;
        const kind = shortOptions.get(ch);
        if (!kind) throw new CliUsageError(`Unknown option: -${ch}`);
        if (kind === "boolean") {
          if (eq !== -1) throw new CliUsageError(`Option -${ch} does not take a value`);
          continue;
        }
        if (eq === -1 && j === shorts.length - 1) {
          if (i + 1 >= rawArgs.length) throw new CliUsageError(`Option -${ch} requires a value`);
          i++;
        }
        break;
      }
    }
  }
}

function strictArgs(opts: { variadic?: boolean } = {}): CittyPlugin {
  return {
    name: "strict-args",
    async setup({ rawArgs, args, cmd }) {
      const argsDef: ArgsDef = typeof cmd.args === "function" ? await cmd.args() : ((await cmd.args) ?? {});
      validateRawArgs(rawArgs, argsDef);
      if (!opts.variadic) {
        const expected = Object.values(argsDef).filter((arg) => arg.type === "positional").length;
        const extra = args._[expected];
        if (extra !== undefined) throw new CliUsageError(`Unexpected argument: ${extra}`);
      }
    },
  };
}

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
    args: {
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
    },
    plugins: [strictArgs()],
    run({ args }) {
      const host = args.host !== undefined ? parseNonEmpty(args.host, "--host") : undefined;
      const port = args.port !== undefined ? String(parsePort(args.port)) : undefined;
      const { config, log, engine } = buildEngine(deps, {
        ...(host ? { SEX_HOST: host } : {}),
        ...(port ? { SEX_PORT: port } : {}),
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
    plugins: [strictArgs()],
    async run({ args }) {
      const formats = parseFormats(args.format, args.markdown);
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
    plugins: [strictArgs({ variadic: true })],
    async run({ args }) {
      const query = args._.join(" ").trim();
      if (!query) throw new CliUsageError("search needs a non-empty query");
      const limit = args.limit !== undefined ? parsePositiveInt(args.limit, "--limit") : undefined;
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
    plugins: [strictArgs()],
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
    plugins: [strictArgs()],
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
    plugins: [strictArgs()],
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
    plugins: [strictArgs()],
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
    default: "serve",
    subCommands,
  });

  return { root, subCommands };
}

function normalizeArgv(argv: string[]): string[] {
  const first = argv[0];
  if (first !== undefined && first.startsWith("-") && first !== "--help" && first !== "-h") {
    return ["serve", ...argv];
  }
  return argv;
}

function hasHelpFlag(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

function resolveCommandForUsage(
  root: CommandDef<any>,
  subCommands: Record<string, CommandDef<any>>,
  argv: string[],
): [CommandDef<any>, CommandDef<any> | undefined] {
  const normalized = normalizeArgv(argv);
  const first = normalized[0];
  if (first === "help") {
    const targetName = normalized[1];
    if (targetName && targetName in subCommands) {
      return [subCommands[targetName]!, root];
    }
    return [root, undefined];
  }
  if (first && first in subCommands) {
    return [subCommands[first]!, root];
  }
  return [root, undefined];
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const { root, subCommands } = createCli(deps);

  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    stdout(VERSION);
    return;
  }

  if (argv[0] === "help") {
    if (argv.length === 1) {
      stdout(await renderUsage(root));
      return;
    }
    if (argv.length === 2) {
      const targetName = argv[1]!;
      const target = subCommands[targetName];
      if (!target) throw new CliUsageError(`Unknown command ${targetName}`);
      stdout(await renderUsage(target, root));
      return;
    }
    throw new CliUsageError(`Unexpected argument: ${argv[2]}`);
  }

  const normalized = normalizeArgv(argv);
  if (hasHelpFlag(normalized)) {
    const [target, parent] = resolveCommandForUsage(root, subCommands, normalized);
    stdout(await renderUsage(target, parent));
    return;
  }

  await runCommand(root, { rawArgs: normalized });
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
    if (isUsageError(err)) {
      console.error(err.message);
      const { root, subCommands } = createCli();
      const [target, parent] = resolveCommandForUsage(root, subCommands, argv);
      console.error("");
      console.error(await renderUsage(target, parent));
    } else {
      console.error(failure(err).message);
    }
    process.exitCode = 1;
  });
}

if (import.meta.main) run();
