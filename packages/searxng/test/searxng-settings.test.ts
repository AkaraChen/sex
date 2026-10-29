// The proxy for the managed SearXNG: the settings that get generated, and when they do not.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DEFAULT_SETTINGS } from "@searxng-js/searxng";
import { generatedSettings, proxiedSettings, redactProxy, SearxngService } from "@searxng-js/sex-searxng";
import { parse } from "yaml";

const fake = join(import.meta.dirname, "fixtures", "fake-searxng.ts");
const dir = mkdtempSync(join(tmpdir(), "sex-searxng-settings-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const PROXY = "http://user:s3cr%40t:w@proxy.example:3128";

type Parsed = { outgoing: { proxies: Record<string, string[]> } & Record<string, unknown> } & Record<string, unknown>;
/** The fields of `actual` named in `expected` must equal it, recursively for objects. */
function matches(actual: unknown, expected: unknown, path = "$"): void {
  if (typeof expected === "object" && expected !== null && !Array.isArray(expected)) {
    for (const [k, v] of Object.entries(expected)) matches((actual as Record<string, unknown>)[k], v, `${path}.${k}`);
  } else assert.deepEqual(actual, expected, path);
}

describe("generated settings", () => {
  test("outgoing.proxies in SearXNG's format, on top of the default settings", async () => {
    matches(parse(await proxiedSettings(PROXY)), {
      use_default_settings: true,
      search: { formats: ["html", "json"] },
      server: { limiter: false, image_proxy: false },
      outgoing: { proxies: { "all://": [PROXY] } },
    });
    assert.ok(!Object.keys(parse(DEFAULT_SETTINGS) as object).includes("outgoing"));
  });

  test("an outgoing section the base already has is merged into, not duplicated", async () => {
    const base = `${DEFAULT_SETTINGS}outgoing:\n  request_timeout: 3\n  pool_connections: 50\n  proxies:\n    "https://": ["http://other:1"]\n    "all://": ["http://old:2"]\n`;
    const out = await proxiedSettings(PROXY, base);
    assert.equal(out.match(/^outgoing:/gm)?.length, 1);
    matches(parse(out), {
      use_default_settings: true,
      outgoing: { request_timeout: 3, pool_connections: 50, proxies: { "https://": ["http://other:1"], "all://": [PROXY] } },
    });
  });

  for (const url of [
    "http://user:p:w@proxy.example:3128",
    "http://us@er:pa#ss@proxy.example:3128",
    'http://us"er:pa\'ss"@proxy.example:3128',
    "http://u:a\\b%22c%23d@proxy.example:3128/#frag",
    "http://u:: #x@proxy.example:3128",
  ]) {
    test(`credentials round-trip unchanged: ${url}`, async () => {
      assert.deepEqual((parse(await proxiedSettings(url)) as Parsed).outgoing.proxies["all://"], [url]);
    });
  }

  test("only a managed instance on the default settings gets the proxy", async () => {
    assert.notEqual(await generatedSettings({ proxyUrl: PROXY }), undefined);
    assert.equal(await generatedSettings({}), undefined);
    assert.equal(await generatedSettings({ proxyUrl: PROXY, url: "http://searx:8080" }), undefined);
    assert.equal(await generatedSettings({ proxyUrl: PROXY, settingsPath: "/etc/searxng/settings.yml" }), undefined);
  });
});

describe("redactProxy", () => {
  test("hides the URL, the credentials and their decoded form", () => {
    const text = `ProxyError via ${PROXY}; auth user:s3cr%40t:w / user:s3cr@t:w failed, password s3cr@t:w, again ${new URL(PROXY).href}, encoded ${new URL(PROXY).password}`;
    const out = redactProxy(text, PROXY);
    for (const secret of ["s3cr%40t", "s3cr@t", "s3cr%3A"]) assert.ok(!out.includes(secret), secret);
    assert.ok(out.includes("<redacted>"));
  });

  test("without a proxy the text is unchanged", () => {
    assert.equal(redactProxy("anything", undefined), "anything");
  });
});

describe("managed SearXNG with a proxy", () => {
  const withProxy = (extra: { binaryPath?: string; settingsPath?: string }) => new SearxngService({ proxyUrl: PROXY, ...extra });
  const settingsSeen = async (s: SearxngService) => (await fetch(`${await s.url()}/settings`)).text();
  const leftovers = () =>
    readdirSync(tmpdir()).filter((n) => n.startsWith("sex-searxng-") && existsSync(join(tmpdir(), n, "settings.yml")));

  test("the process reads outgoing.proxies, and the file is gone once it is up", async () => {
    const before = leftovers();
    const searxng = withProxy({ binaryPath: fake });
    try {
      assert.ok((await settingsSeen(searxng)).includes(PROXY));
      assert.deepEqual(leftovers(), before);
    } finally {
      await searxng.close();
    }
  });

  test("the operator's own settings file is used as it is", async () => {
    const own = join(dir, "own.yml");
    writeFileSync(own, "use_default_settings: true\noutgoing:\n  request_timeout: 3\n");
    const searxng = withProxy({ binaryPath: fake, settingsPath: own });
    try {
      const seen = await settingsSeen(searxng);
      assert.ok(seen.includes("request_timeout: 3"));
      assert.ok(!seen.includes("proxies"));
    } finally {
      await searxng.close();
    }
  });

  test("a failed start does not put the proxy credentials in the error", async () => {
    const bin = join(dir, "echo-proxy.ts");
    // Dies printing the settings it was given, as a server that logs its config would.
    writeFileSync(
      bin,
      `#!/usr/bin/env node\nimport { readFileSync } from "node:fs";\nconsole.error(readFileSync(process.env.SEARXNG_SETTINGS_PATH, "utf8"));process.exit(3);\n`,
      { mode: 0o755 },
    );
    const searxng = withProxy({ binaryPath: bin });
    try {
      const err = (await searxng.url().catch((e: unknown) => e)) as Error;
      assert.match(err.message, /did not start/);
      assert.ok(!err.message.includes("s3cr%40t"));
      assert.ok(!err.message.includes(PROXY));
    } finally {
      await searxng.close();
    }
  });
});
