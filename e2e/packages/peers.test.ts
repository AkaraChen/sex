import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { killAll } from "../lib/proc.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { bunProject, consumeOk, consumerSite, NODE_PEERS, nodeProject, sharedDone } from "./support.ts";

const site = consumerSite();
afterAll(async () => {
  site.stop();
  await killAll();
  removeTempDirs();
  sharedDone();
});

const PEER_PACKAGES = [...NODE_PEERS, "@aws-sdk/client-s3"];
const installed = (project: string, pkg: string) => existsSync(join(project, "node_modules", pkg, "package.json"));

describe("Node project without the optional peers", () => {
  test("npm does not install them by itself", async () => {
    const project = await nodeProject([], "node-nopeers");
    for (const pkg of PEER_PACKAGES) expect(installed(project, pkg)).toBe(false);
  });

  test("every package still imports", async () => {
    const project = await nodeProject([], "node-nopeers");
    const r = await consumeOk(project, "node", "peers.mjs", { siteUrl: site.url });
    for (const [name, exports] of Object.entries(r.imports)) expect([name, typeof exports]).toEqual([name, "number"]);
  });

  const cases: Array<[string, string, string]> = [
    ["undici", "undici", "safeFetch"],
    ["undici", "undiciViaScrape", "scrapeUrl"],
    ["marked", "marked", "markdownToHtml"],
    ["yaml", "yaml", "generatedSettings with a proxyUrl"],
    ["@aws-sdk/client-s3", "s3", "an s3:// document log"],
  ];
  for (const [peer, key, what] of cases) {
    test(`${what} throws NOT_SUPPORTED naming ${peer}`, async () => {
      const project = await nodeProject([], "node-nopeers");
      const r = await consumeOk(project, "node", "peers.mjs", { siteUrl: site.url });
      expect(r[key]).toMatchObject({ ok: false, isAppError: true, code: "NOT_SUPPORTED" });
      expect(r[key].message).toContain(peer);
      expect(r[key].message).toContain(`npm install ${peer}`);
    });
  }
});

describe("Node project with only undici", () => {
  test("fetching works, Markdown to HTML still names marked", async () => {
    const project = await nodeProject(["undici"], "node-undici");
    const r = await consumeOk(project, "node", "peers.mjs", { siteUrl: site.url });
    expect(r.undici.ok).toBe(true);
    expect(r.undiciViaScrape.ok).toBe(true);
    expect(r.marked).toMatchObject({ ok: false, code: "NOT_SUPPORTED" });
    expect(r.yaml).toMatchObject({ ok: false, code: "NOT_SUPPORTED" });
  });
});

describe("Bun project", () => {
  test("the Node-only optional peers are not installed", async () => {
    const project = await bunProject();
    for (const pkg of PEER_PACKAGES) expect([pkg, installed(project, pkg)]).toEqual([pkg, false]);
  });

  test("needs none of them: fetching, Markdown to HTML and YAML settings work on Bun's own APIs", async () => {
    const project = await bunProject();
    const r = await consumeOk(project, "bun", "peers.mjs", { siteUrl: site.url });
    expect(r.undici.ok).toBe(true);
    expect(r.undiciViaScrape.ok).toBe(true);
    expect(r.marked.ok).toBe(true);
    expect(r.yaml.ok).toBe(true);
  });
});
