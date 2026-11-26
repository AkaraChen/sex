#!/usr/bin/env bun
import { basename } from "node:path";
import { parseArgs } from "node:util";
import type { SearchRequest } from "@searxng-js/sex-search";
import { loadConfig } from "./config.ts";
import { Engine } from "./engine.ts";
import { failure } from "./errors.ts";
import { createApp } from "./http.ts";
import { createLogger } from "./log.ts";
import { runStdio } from "./mcp.ts";
import { VERSION } from "./version.ts";

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

async function main(argv: string[]): Promise<void> {
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
  const engine = new Engine(config, log);

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
      const url = positionals[0];
      if (!url) return fail("scrape needs a URL");
      const formats = values.format
        ? values.format.split(",").map((format) => format.trim())
        : values.markdown
          ? ["markdown"]
          : undefined;
      const { data } = await engine.scrape({ url, formats });
      console.log(values.markdown ? String(data.markdown ?? "") : JSON.stringify({ success: true, data }, null, 2));
      await engine.close();
      return;
    }

    case "search": {
      const query = positionals.join(" ");
      if (!query) return fail("search needs a query");
      const request: SearchRequest = { query, ...(values.limit ? { limit: Number(values.limit) } : {}) };
      const { data, warning, provider } = await engine.search(request);
      console.log(JSON.stringify({ data, provider, ...(warning ? { warning } : {}) }, null, 2));
      await engine.close();
      return;
    }

    case "map": {
      const url = positionals[0];
      if (!url) return fail("map needs a URL");
      console.log(JSON.stringify(await engine.map({ url }), null, 2));
      await engine.close();
      return;
    }

    case "parse": {
      const path = positionals[0];
      if (!path) return fail("parse needs a file");
      const file = Bun.file(path);
      if (!(await file.exists())) return fail(`no such file: ${path}`);
      console.log(JSON.stringify(await engine.parse(new File([await file.arrayBuffer()], basename(path))), null, 2));
      await engine.close();
      return;
    }

    case "mcp": {
      await runStdio(engine);
      return;
    }

    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

function fail(message: string): void {
  console.error(message);
  console.error(USAGE);
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((err) => {
  console.error(failure(err).message);
  process.exitCode = 1;
});
