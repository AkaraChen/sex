import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { killAll, run } from "../lib/proc.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { bunProject, nodeProject, packAll, sharedDone } from "./support.ts";

afterAll(async () => {
  await killAll();
  removeTempDirs();
  sharedDone();
});

const OURS = /^@searxng-js\/sex-/;

describe("version consistency", () => {
  test("every range one packed package puts on another is satisfied by the packed version", async () => {
    const tarballs = await packAll();
    const versions = new Map(tarballs.map((t) => [t.pkg.name, t.pkg.json.version as string]));
    const bad: string[] = [];
    for (const t of tarballs) {
      const { stdout } = await run("tar", ["xzOf", t.file, "package/package.json"]);
      const json = JSON.parse(stdout);
      for (const field of ["dependencies", "peerDependencies"]) {
        for (const [name, range] of Object.entries<string>(json[field] ?? {})) {
          if (!OURS.test(name)) continue;
          const version = versions.get(name);
          if (!version) bad.push(`${t.pkg.name} ${field}: ${name} is not a published package`);
          else if (!Bun.semver.satisfies(version, range)) bad.push(`${t.pkg.name} ${field}: ${name}@${range} does not accept ${version}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("npm ls on the Node project reports no invalid or missing @searxng-js package", async () => {
    const dir = await nodeProject();
    const r = await run("npm", ["ls", "--all", "--json", "--long=false"], { cwd: dir, env: { npm_config_update_notifier: "false" } });
    const tree = JSON.parse(r.stdout) as { problems?: string[]; dependencies?: Record<string, any> };
    const ours = (tree.problems ?? []).filter((p) => p.includes("@searxng-js/"));
    expect(ours).toEqual([]);

    // and the whole set of eleven is in the tree once, at one version
    const found = new Map<string, Set<string>>();
    const visit = (deps: Record<string, any> | undefined) => {
      for (const [name, node] of Object.entries<any>(deps ?? {})) {
        if (OURS.test(name)) {
          if (node.missing || node.invalid) throw new Error(`${name} is ${node.missing ? "missing" : "invalid"}`);
          (found.get(name) ?? found.set(name, new Set()).get(name)!).add(node.version);
        }
        visit(node.dependencies);
      }
    };
    visit(tree.dependencies);
    const packed = await packAll();
    expect([...found.keys()].sort()).toEqual(packed.map((t) => t.pkg.name).sort());
    for (const versions of found.values()) expect(versions.size).toBe(1);
  });

  test("the installed copies are the packed ones: one copy of each package in node_modules, none nested", async () => {
    const dir = await nodeProject();
    const r = await run(
      "find",
      [join(dir, "node_modules"), "-path", "*@searxng-js/sex-*", "-maxdepth", "6", "-name", "package.json", "-not", "-path", "*/dist/*"],
      {},
    );
    const paths = r.stdout
      .split("\n")
      .filter(Boolean)
      .filter((p) => /@searxng-js\/sex-[a-z]+\/package\.json$/.test(p));
    const nested = paths.filter((p) => (p.match(/node_modules/g) ?? []).length > 1);
    expect(nested).toEqual([]);
    for (const p of paths) expect(JSON.parse(readFileSync(p, "utf8")).version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("bun resolves the same set of packages", async () => {
    const dir = await bunProject();
    const packed = await packAll();
    for (const t of packed) {
      const json = JSON.parse(readFileSync(join(dir, "node_modules", t.pkg.name, "package.json"), "utf8"));
      expect(json.version).toBe(t.pkg.json.version);
    }
  });
});
