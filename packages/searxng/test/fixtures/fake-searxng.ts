#!/usr/bin/env node
// Stands in for the SearXNG binary in test/searxng.test.ts (plain Node, so the test runs on Node and Bun alike).
// The settings file picks the behaviour: a line "fake: crash" exits at once, anything else serves /healthz,
// a one-result /search and /settings (the file as it read it).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const settings = readFileSync(process.env.SEARXNG_SETTINGS_PATH ?? "", "utf8");
if (settings.includes("fake: crash")) {
  console.error("fake: boom");
  process.exit(3);
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") return void res.end("OK");
  if (url.pathname === "/settings") return void res.end(settings);
  if (url.pathname === "/search") {
    res.setHeader("content-type", "application/json");
    return void res.end(
      JSON.stringify({
        results: [{ url: "https://example.com/", title: `fake: ${url.searchParams.get("q")}`, content: `pid ${process.pid}` }],
      }),
    );
  }
  res.statusCode = 404;
  res.end("not found");
}).listen(Number(process.env.SEARXNG_PORT), process.env.SEARXNG_BIND_ADDRESS);
// The real binary exits when its stdin closes (SEARXNG_EXIT_ON_STDIN_EOF), so a dead parent leaves nothing behind.
process.stdin.on("end", () => process.exit(0)).resume();
process.on("SIGTERM", () => process.exit(0));
