#!/usr/bin/env bun
// Stands in for the SearXNG binary in test/searxng.test.ts. The settings file picks the behaviour:
// a line "fake: crash" exits at once, anything else serves /healthz, a one-result /search and /settings (the file as it read it).
import { readFileSync } from "node:fs";

const settings = readFileSync(process.env.SEARXNG_SETTINGS_PATH ?? "", "utf8");
if (settings.includes("fake: crash")) {
  console.error("fake: boom");
  process.exit(3);
}

Bun.serve({
  hostname: process.env.SEARXNG_BIND_ADDRESS,
  port: Number(process.env.SEARXNG_PORT),
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("OK");
    if (url.pathname === "/settings") return new Response(settings);
    if (url.pathname === "/search") {
      const q = url.searchParams.get("q");
      return Response.json({ results: [{ url: "https://example.com/", title: `fake: ${q}`, content: `pid ${process.pid}` }] });
    }
    return new Response("not found", { status: 404 });
  },
});
// The real binary exits when its stdin closes (SEARXNG_EXIT_ON_STDIN_EOF), so a dead parent leaves nothing behind.
process.stdin.on("end", () => process.exit(0)).resume();
process.on("SIGTERM", () => process.exit(0));
