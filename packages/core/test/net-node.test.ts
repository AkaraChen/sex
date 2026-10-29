// safeFetch's Node path (undici with a lookup that refuses private addresses), run in a real `node` subprocess: under
// Bun, `std-env` picks the Bun path and Bun's undici ignores `connect.lookup`. Skipped when `node` is not on PATH.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const node = Bun.which("node");
const NET = new URL("../src/net.ts", import.meta.url).pathname;
const DEADLINE = new URL("../src/deadline.ts", import.meta.url).pathname;

/** Runs `body` as an ES module in Node with `safeFetch`, `publicLookup` and `Deadline` in scope; returns its JSON output. */
async function inNode(body: string): Promise<unknown> {
  const script = `import { safeFetch, publicLookup } from ${JSON.stringify(NET)};
import { Deadline } from ${JSON.stringify(DEADLINE)};
const opts = (allowPrivateNetwork) => ({ deadline: Deadline.start(5000), allowPrivateNetwork, userAgent: "t" });
const outcome = (p) => p.then((r) => ({ status: r.status, url: r.url, body: new TextDecoder().decode(r.body) }), (e) => ({ code: e.code }));
${body}`;
  const proc = Bun.spawn([node as string, "--input-type=module", "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) throw new Error(`node exited ${exit}: ${err}`);
  return JSON.parse(out);
}

describe.skipIf(!node)("safeFetch on Node", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname === "/r"
          ? new Response(null, { status: 302, headers: { location: "/ok" } })
          : new Response(`host=${req.headers.get("host")}`),
    });
  });
  afterAll(() => {
    server.stop(true);
  });

  test("fetches through undici and follows redirects", async () => {
    const out = await inNode(`console.log(JSON.stringify(await outcome(safeFetch("http://127.0.0.1:${server.port}/r", opts(true)))));`);
    expect(out).toEqual({ status: 200, url: `http://127.0.0.1:${server.port}/ok`, body: `host=127.0.0.1:${server.port}` });
  });

  test("refuses private addresses", async () => {
    const out = await inNode(`console.log(JSON.stringify([
  await outcome(safeFetch("http://127.0.0.1:${server.port}/", opts(false))),
  await outcome(safeFetch("http://localhost:${server.port}/", opts(false))),
]));`);
    expect(out).toEqual([{ code: "PRIVATE_NETWORK_BLOCKED" }, { code: "PRIVATE_NETWORK_BLOCKED" }]);
  });

  test("the connection's own lookup refuses a name that resolves to a private address", async () => {
    // What a rebinding DNS server's second answer meets: the lookup undici connects with checks it again.
    const out = await inNode(`publicLookup("localhost", { all: true }, (err, addresses) =>
  console.log(JSON.stringify({ code: err?.code, addresses })));`);
    expect(out).toEqual({ code: "PRIVATE_NETWORK_BLOCKED", addresses: [] });
  });
});
