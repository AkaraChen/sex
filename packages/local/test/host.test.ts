import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StartServerError, startServer } from "../src/host.ts";
import { LocalService } from "../src/service.ts";

const dir = await mkdtemp(join(tmpdir(), "sex-local-test-"));

const STUB = `#!/usr/bin/env bun
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const port = Number(value("--port"));
const token = value("--token");
if (args.includes("--exit-early")) process.exit(2);
const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (request.headers.get("authorization") !== "Bearer " + token) {
      return Response.json({ success: false, error: "unauthorized" }, { status: 401 });
    }
    return Response.json({ success: true, data: { markdown: "# stub" } });
  },
});
process.on("SIGTERM", () => process.exit(0));
console.error("stub listening on " + server.port);
`;

await writeFile(join(dir, "firecrawl-local"), STUB);
await chmod(join(dir, "firecrawl-local"), 0o755);
const stub = join(dir, "firecrawl-local");

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("startServer waits for /health and speaks the token", async () => {
  const server = await startServer({ binaryPath: stub });
  expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
  expect((await fetch(`${server.url}/health`)).ok).toBe(true);

  const authorized = await fetch(`${server.url}/v2/scrape`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com" }),
  });
  expect(await authorized.json()).toMatchObject({ success: true, data: { markdown: "# stub" } });

  const anonymous = await fetch(`${server.url}/v2/scrape`, { method: "POST" });
  expect(anonymous.status).toBe(401);

  await server.stop();
  expect(await server.exited).toBe(0);
});

test("a child that exits before /health is a StartServerError", async () => {
  const error = await startServer({ binaryPath: stub, args: ["--exit-early"], timeoutMs: 2000 }).catch((err) => err);
  expect(error).toBeInstanceOf(StartServerError);
  expect(error.message).toContain("exited with code 2");
});

test("a missing binary is a StartServerError", async () => {
  const error = await startServer({ binaryPath: join(dir, "nope"), timeoutMs: 500 }).catch((err) => err);
  expect(error).toBeInstanceOf(StartServerError);
});

test("repeated failed starts stop restarting for a cooldown", async () => {
  const service = new LocalService({ binaryPath: stub, args: ["--exit-early"], timeoutMs: 500 });
  for (let attempt = 0; attempt < 3; attempt++) await service.warmup().catch(() => undefined);
  const error = await service.warmup().catch((err) => err);
  expect(error).toBeInstanceOf(StartServerError);
  expect(error.message).toContain("failed starts");
  await service.close();
});

test("an external instance is used as given", async () => {
  const service = new LocalService({ url: "http://127.0.0.1:1234/", token: "t" });
  expect(service.managed).toBe(false);
  expect(await service.url()).toBe("http://127.0.0.1:1234");
  expect(await service.token()).toBe("t");
});
