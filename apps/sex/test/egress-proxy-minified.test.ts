import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EgressProxy } from "@searxng-js/sex-browser";
import type { EgressPolicy } from "@searxng-js/sex-egress";
import { basic, connectTo, startServer, viaProxy } from "../../../packages/browser/test/proxy-support.ts";

// The release binary is built with --minify, which renames classes and functions. Nothing may depend on a name (a proxy library
// that told its own errors apart by class name answered 500 to everything once minified). Needs Bun.build, so it is not one
// of the package's Node tests.
test("the proxy works from a minified bundle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sex-egress-"));
  const upstream = await startServer();
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(
      entry,
      `export { EgressProxy } from ${JSON.stringify(join(import.meta.dir, "../../../packages/browser/src/egress-proxy.ts"))};\n` +
        `export { EgressPolicy } from ${JSON.stringify(join(import.meta.dir, "../../../packages/egress/src/egress.ts"))};\n`,
    );
    const built = await Bun.build({ entrypoints: [entry], minify: true, target: "bun", conditions: ["sex-source"] });
    expect(built.success).toBe(true);
    const bundle = join(dir, "bundle.js");
    writeFileSync(bundle, (await built.outputs[0]?.text()) ?? "");
    const { EgressProxy: Minified, EgressPolicy: MinifiedPolicy } = (await import(bundle)) as {
      EgressProxy: typeof EgressProxy;
      EgressPolicy: typeof EgressPolicy;
    };
    const strict = new Minified(new MinifiedPolicy({ allowPrivateNetwork: false }));
    const l = await strict.open();
    const header = basic(l.credentials.username, l.credentials.password);
    expect((await viaProxy(l.server, `http://127.0.0.1:${upstream.port}/`)).status).toBe(407);
    expect((await viaProxy(l.server, `http://127.0.0.1:${upstream.port}/`, { auth: header })).status).toBe(403);
    expect((await connectTo(l.server, `127.0.0.1:${upstream.port}`, header)).status).toBe(403);
    expect(upstream.hits).toEqual([]);
    l.close();
    await strict.close();
    const open = new Minified(new MinifiedPolicy({ allowPrivateNetwork: true }));
    const o = await open.open();
    const ok = await viaProxy(o.server, `http://127.0.0.1:${upstream.port}/fine`, {
      auth: basic(o.credentials.username, o.credentials.password),
    });
    expect([ok.status, ok.body]).toEqual([200, "GET /fine "]);
    o.close();
    await open.close();
  } finally {
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
