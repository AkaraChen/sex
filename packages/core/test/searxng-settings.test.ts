// SEX_PROXY_URL for the managed SearXNG: the settings sex generates, and when it does not.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseEngine } from "../src/engine.ts";
import { generatedSettings, proxiedSettings, redactProxy } from "../src/searxng-settings.ts";
import { testCoreConfig } from "./helpers.ts";

const fake = join(import.meta.dir, "fixtures", "fake-searxng.ts");
const dir = mkdtempSync(join(tmpdir(), "sex-searxng-settings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PROXY = "http://user:s3cr%40t:w@proxy.example:3128";

describe("generated settings", () => {
  test("outgoing.proxies in SearXNG's format, on top of the default settings", () => {
    const yaml = proxiedSettings(PROXY);
    expect(yaml).toContain("use_default_settings: true");
    expect(yaml).toContain("search:\n  formats: [html, json]");
    expect(yaml).toContain(`outgoing:\n  proxies:\n    all://:\n      - "${PROXY}"\n`);
    expect(Bun.YAML.parse(yaml)).toMatchObject({ outgoing: { proxies: { "all://": [PROXY] } } });
  });

  test("quotes and backslashes in credentials stay one YAML string", () => {
    const url = 'http://us"er:pa\\ss#x@proxy:1';
    expect(
      (Bun.YAML.parse(proxiedSettings(url)) as { outgoing: { proxies: Record<string, string[]> } }).outgoing.proxies["all://"],
    ).toEqual([url]);
  });

  test("only a managed instance on sex's own settings gets the proxy", () => {
    expect(generatedSettings({ proxyUrl: PROXY })).toBeDefined();
    expect(generatedSettings({})).toBeUndefined();
    expect(generatedSettings({ proxyUrl: PROXY, searxngUrl: "http://searx:8080" })).toBeUndefined();
    expect(generatedSettings({ proxyUrl: PROXY, searxngSettings: "/etc/searxng/settings.yml" })).toBeUndefined();
  });
});

describe("redactProxy", () => {
  test("hides the URL, the credentials and their decoded form", () => {
    const text = `ProxyError via ${PROXY}; auth user:s3cr%40t:w / user:s3cr@t:w failed, password s3cr@t:w, again ${new URL(PROXY).href}, encoded ${new URL(PROXY).password}`;
    const out = redactProxy(text, PROXY);
    for (const secret of ["s3cr%40t", "s3cr@t", "s3cr%3A"]) expect(out).not.toContain(secret);
    expect(out).toContain("<redacted>");
  });

  test("without a proxy the text is unchanged", () => {
    expect(redactProxy("anything", undefined)).toBe("anything");
  });
});

describe("managed SearXNG with SEX_PROXY_URL", () => {
  // The proxy comes from the environment only, so it is set on the resolved config.
  const withProxy = (overrides: Parameters<typeof testCoreConfig>[0]) => new BaseEngine({ ...testCoreConfig(overrides), proxyUrl: PROXY });
  const settingsSeen = async (engine: BaseEngine) => (await fetch(`${await engine.searxng.url()}/settings`)).text();
  const leftovers = () =>
    readdirSync(tmpdir()).filter((n) => n.startsWith("sex-searxng-") && existsSync(join(tmpdir(), n, "settings.yml")));

  test("the process reads outgoing.proxies, and the file is gone once it is up", async () => {
    const before = leftovers();
    const engine = withProxy({ searxngUrl: "", searxngPath: fake });
    try {
      expect(await settingsSeen(engine)).toContain(PROXY);
      expect(leftovers()).toEqual(before);
    } finally {
      await engine.close();
    }
  });

  test("the operator's own settings file is used as it is", async () => {
    const own = join(dir, "own.yml");
    writeFileSync(own, "use_default_settings: true\noutgoing:\n  request_timeout: 3\n");
    const engine = withProxy({ searxngUrl: "", searxngPath: fake, searxngSettings: own });
    try {
      const seen = await settingsSeen(engine);
      expect(seen).toContain("request_timeout: 3");
      expect(seen).not.toContain("proxies");
    } finally {
      await engine.close();
    }
  });

  test("a failed start does not put the proxy credentials in the error", async () => {
    const bin = join(dir, "echo-proxy.ts");
    // Dies printing the settings it was given, as a server that logs its config would.
    writeFileSync(
      bin,
      `#!/usr/bin/env bun\nconsole.error(require("node:fs").readFileSync(process.env.SEARXNG_SETTINGS_PATH, "utf8"));process.exit(3);\n`,
      { mode: 0o755 },
    );
    const engine = withProxy({ searxngUrl: "", searxngPath: bin });
    try {
      const err = (await engine.searxng.url().catch((e: unknown) => e)) as Error;
      expect(err.message).toContain("did not start");
      expect(err.message).not.toContain("s3cr%40t");
      expect(err.message).not.toContain(PROXY);
    } finally {
      await engine.close();
    }
  });
});
