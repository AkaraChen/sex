#!/usr/bin/env bun
import { basename } from "node:path";
import { parseArgs } from "node:util";
import type { SearchRequest } from "@searxng-js/sex-search";
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

export interface CliDeps {
  createEngine?: (config: Config, log: Logger) => Engine;
  runStdio?: typeof runStdio;
  signals?: SignalSource;
  exit?: (code: number) => void;
}

const USAGE = `sex ${VERSION}

Usage:
  sex serve                         The Firecrawl v2 API on 127.0.0.1:3002
  sex scrape <url> [--markdown] [--format markdown,links]
  sex search <query> [--limit 10]
  sex map <url>
  sex parse <file>
  sex mcp                           The MCP tools over stdio

Environment: SEX_HOST, SEX_PORT, SEX_LOCAL_PATH, SEX_LOCAL_URL, SEX_LOCAL_TOKEN,
SEX_CHROME_PATH, SEX_BROWSER, SEX_ALLOW_PRIVATE, SEX_SEARXNG_URL, SEX_SEARXNG_PATH,
SEX_SEARCH_PROVIDER, SEX_SEARCH_<ID>_KEY, SEX_SEARCH_TIMEOUT,
SEX_LOG_LEVEL, SEX_TIMEOUT
`;

export async function main(argv: string[], deps: CliDeps = {}): Promise<void> {
  const [command = "serve", ...rest] = argv;
  if (command === "help" || argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  if (command === "version") {
    console.log(VERSION);
    return;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      markdown: { type: "boolean" },
      format: { type: "string" },
      limit: { type: "string" },
      help: { type: "boolean" },
    },
  });

  const config = loadConfig({
    ...process.env,
    ...(values.host ? { SEX_HOST: values.host } : {}),
    ...(values.port ? { SEX_PORT: values.port } : {}),
  });
  const log = createLogger(config.logLevel);
  const engine = (deps.createEngine ?? ((c, l) => new Engine(c, l)))(config, log);

  switch (command) {
    case "serve": {
      const app = createApp(engine);
      const server = Bun.serve({ hostname: config.host, port: config.port, fetch: (request) => app.fetch(request) });
      log.info("listening", { url: `http://${config.host}:${server.port}`, ...engine.describe() });
      void engine.warmup();
      let closing = false;
      const shutdown = async () => {
        if (closing) return;
        closing = true;
        await engine.close();
        await server.stop();
        process.exit(0);
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
      return;
    }

    case "scrape": {
      try {
        const url = positionals[0];
        if (!url) return fail("scrape needs a URL");
        const formats = values.format
          ? values.format.split(",").map((format) => format.trim())
          : values.markdown
            ? ["markdown"]
            : undefined;
        const { data } = await engine.scrape({ url, formats });
        console.log(values.markdown ? String(data.markdown ?? "") : JSON.stringify({ success: true, data }, null, 2));
      } finally {
        await engine.close();
      }
      return;
    }

    case "search": {
      try {
        const query = positionals.join(" ");
        if (!query) return fail("search needs a query");
        const request: SearchRequest = { query, ...(values.limit ? { limit: Number(values.limit) } : {}) };
        const { data, warning, provider } = await engine.search(request);
        console.log(JSON.stringify({ data, provider, ...(warning ? { warning } : {}) }, null, 2));
      } finally {
        await engine.close();
      }
      return;
    }

    case "map": {
      try {
        const url = positionals[0];
        if (!url) return fail("map needs a URL");
        console.log(JSON.stringify(await engine.map({ url }), null, 2));
      } finally {
        await engine.close();
      }
      return;
    }

    case "parse": {
      try {
        const path = positionals[0];
        if (!path) return fail("parse needs a file");
        const file = Bun.file(path);
        if (!(await file.exists())) return fail(`no such file: ${path}`);
        console.log(JSON.stringify(await engine.parse(new File([await file.arrayBuffer()], basename(path))), null, 2));
      } finally {
        await engine.close();
      }
      return;
    }

    case "mcp": {
      await runMcp(engine, deps);
      return;
    }

    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
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

function fail(message: string): void {
  console.error(message);
  console.error(USAGE);
  process.exitCode = 1;
}

export function run(argv = process.argv.slice(2)): void {
  main(argv).catch((err) => {
    console.error(failure(err).message);
    process.exitCode = 1;
  });
}

if (import.meta.main) run();
