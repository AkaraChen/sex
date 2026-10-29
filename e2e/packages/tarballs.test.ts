import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { killAll } from "../lib/proc.ts";
import { removeTempDirs, tempDir } from "../lib/tmp.ts";
import { must, PRIVATE_PACKAGES, packAll, sharedDone, type Tarball } from "./support.ts";

/** Opened tarballs: the files `npm publish` would upload, as an installing project gets them. */
interface Unpacked extends Tarball {
  root: string;
  files: string[];
  json: Record<string, any>;
}

let unpacked: Unpacked[] = [];

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(join(dir, name)).isDirectory()) out.push(...walk(join(dir, name), rel));
    else out.push(rel);
  }
  return out.sort();
}

beforeAll(async () => {
  const tarballs = await packAll();
  unpacked = [];
  for (const t of tarballs) {
    const dir = tempDir("untar-");
    await must("tar", ["xzf", t.file, "-C", dir], dir);
    const root = join(dir, "package");
    unpacked.push({ ...t, root, files: walk(root), json: JSON.parse(readFileSync(join(root, "package.json"), "utf8")) });
  }
});

afterAll(async () => {
  await killAll();
  removeTempDirs();
  sharedDone();
});

const each = (name: string, check: (u: Unpacked) => void | Promise<void>) =>
  test(name, async () => {
    expect(unpacked.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const u of unpacked) {
      try {
        await check(u);
      } catch (e) {
        failures.push(`${u.pkg.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failures.length) throw new Error(`\n${failures.join("\n")}`);
  });

/** Every `exports` target (not the `sex-source` condition, which points into the repository's src/). */
function exportTargets(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object")
    for (const [condition, v] of Object.entries(value)) if (condition !== "sex-source") exportTargets(v, out);
  return out;
}

/** The package names a built file imports (static, dynamic and `import("x")` types). Node built-ins are left out. */
function importedPackages(text: string): Set<string> {
  const names = new Set<string>();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|^import\s*)["']([^"'./\s][^"'\s]*)["']/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const spec = m[1] as string;
    if (spec.startsWith("node:") || builtinModules.includes(spec)) continue;
    const parts = spec.split("/");
    names.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string));
  }
  return names;
}

describe("published tarballs", () => {
  test("every package under packages/ that is not private is packed", () => {
    const names = unpacked.map((u) => u.pkg.name);
    expect(names).toEqual(
      ["browser", "docs", "egress", "jobs", "llm", "map", "page", "scrape", "search", "searxng", "store"].map(
        (n) => `@searxng-js/sex-${n}`,
      ),
    );
  });

  each("has dist/index.js, dist/index.d.ts and README.md, and no src/", (u) => {
    for (const f of ["package.json", "README.md", "dist/index.js", "dist/index.d.ts"]) expect(u.files).toContain(f);
    expect(u.files.filter((f) => f.startsWith("src/") || f.includes("/test/") || /\.test\.[jt]s$/.test(f))).toEqual([]);
    expect(u.files.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))).toEqual([]);
  });

  test("sex-page ships the extract worker next to index.js", () => {
    const page = unpacked.find((u) => u.pkg.dir === "page");
    expect(page?.files).toContain("dist/extract-worker.js");
  });

  each("depends on no private package, and uses no workspace: protocol", (u) => {
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries<string>(u.json[field] ?? {})) {
        expect([field, name, PRIVATE_PACKAGES.includes(name)]).toEqual([field, name, false]);
        expect([field, name, range.startsWith("workspace:")]).toEqual([field, name, false]);
      }
    }
    // devDependencies are not installed by a consumer, but the protocol must be gone from them too
    for (const [name, range] of Object.entries<string>(u.json.devDependencies ?? {}))
      expect([name, range.startsWith("workspace:")]).toEqual([name, false]);
  });

  each("no file mentions a private package", (u) => {
    const hits: string[] = [];
    for (const f of u.files.filter((f) => f.startsWith("dist/") || f === "README.md")) {
      const text = readFileSync(join(u.root, f), "utf8");
      for (const name of PRIVATE_PACKAGES) if (text.includes(name)) hits.push(`${f} mentions ${name}`);
    }
    expect(hits).toEqual([]);
  });

  each("exports point at files that exist", (u) => {
    const targets = exportTargets(u.json.exports);
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) expect([t, existsSync(join(u.root, t))]).toEqual([t, true]);
    expect(u.json.exports["."].types).toBe("./dist/index.d.ts");
    expect(u.json.exports["."].default).toBe("./dist/index.js");
    expect(u.json.type).toBe("module");
  });

  each("every bare import of dist is a declared dependency or peer", (u) => {
    const declared = new Set([...Object.keys(u.json.dependencies ?? {}), ...Object.keys(u.json.peerDependencies ?? {})]);
    for (const f of ["dist/index.js", "dist/index.d.ts", "dist/extract-worker.js"].filter((f) => u.files.includes(f))) {
      const imported = importedPackages(readFileSync(join(u.root, f), "utf8"));
      if (f === "dist/index.js") expect(imported.size).toBeGreaterThan(0);
      const missing = [...imported].filter((n) => !declared.has(n));
      expect([f, missing]).toEqual([f, []]);
    }
  });

  each("Node-only libraries are optional peers, never dependencies", (u) => {
    const meta = u.json.peerDependenciesMeta ?? {};
    for (const name of Object.keys(u.json.peerDependencies ?? {})) {
      // the sex packages a plugin extends are required peers; anything else is a library the Node user installs
      if (name.startsWith("@searxng-js/")) continue;
      expect([name, meta[name]?.optional]).toEqual([name, true]);
    }
    for (const name of ["undici", "marked", "yaml", "@aws-sdk/client-s3"])
      expect(Object.keys(u.json.dependencies ?? {})).not.toContain(name);
  });

  test("the optional peers the READMEs name are declared where the READMEs say", () => {
    const peers = (dir: string) => unpacked.find((u) => u.pkg.dir === dir)?.json;
    expect(peers("egress")?.peerDependenciesMeta?.undici).toEqual({ optional: true });
    expect(peers("page")?.peerDependenciesMeta?.marked).toEqual({ optional: true });
    expect(peers("searxng")?.peerDependenciesMeta?.yaml).toEqual({ optional: true });
    expect(peers("jobs")?.peerDependenciesMeta?.["@aws-sdk/client-s3"]).toEqual({ optional: true });
  });

  each("declares the engines, a README with an Install or Example section, and a repository", (u) => {
    expect(u.json.engines?.node).toBe(">=24");
    expect(u.json.repository?.url).toContain("github.com");
    expect(u.json.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(readFileSync(join(u.root, "README.md"), "utf8")).toMatch(/^## (Install|Example)/m);
  });

  each("README documents a diagnostics channel that dist publishes on (all but sex-egress)", (u) => {
    if (u.pkg.dir === "egress") return;
    const channel = `searxng-js:sex:${u.pkg.dir}`;
    expect(readFileSync(join(u.root, "README.md"), "utf8")).toContain(channel);
    expect(readFileSync(join(u.root, "dist/index.js"), "utf8")).toContain(channel);
  });

  each("dist/index.js is valid ES module syntax for Node", async (u) => {
    const r = await must("node", ["--check", join(u.root, "dist/index.js")], u.root);
    expect(r.code).toBe(0);
  });
});
