// Builds dist/sex: one executable with SearXNG, Lightpanda, and here-docs (SEX_DOCS) with its native engines embedded.
//
//   bun scripts/build.ts                         # this host
//   bun scripts/build.ts --target bun-linux-arm64 # another target; its platform packages must be installed
//
// here-docs' runtime closure (its dependencies plus the optional platform packages matching the target) is embedded
// file by file with `with { type: "file" }`. At runtime src/engine/docs.ts extracts it once to a cache directory and
// loads here-docs from there, because native libraries (.node, .so) can only be loaded from real files.
// --compile-autoload-package-json lets the executable resolve those on-disk packages through their package.json.
//
// SearXNG comes from the @searxng-js/<platform> package and is embedded by bun itself. Lightpanda is the release pinned in
// scripts/lightpanda.ts: downloaded once into $XDG_CACHE_HOME/sex-build, checked against its SHA-256, embedded
// zstd-compressed, and decompressed by src/engine/browser.ts on first use. The EasyList + EasyPrivacy domain table behind
// `blockAds` (scripts/adblock.ts, pinned by upstream commit and SHA-256) is embedded the same way and parsed on first use.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { adblockTable } from "./adblock.ts";
import { lightpandaFor } from "./lightpanda.ts";

// The workspace root: dependencies are hoisted into its node_modules (bunfig.toml), and dist/ is written there.
const root = join(import.meta.dir, "..", "..", "..");
const nodeModules = join(root, "node_modules");
const { values } = parseArgs({ options: { target: { type: "string" }, outfile: { type: "string", default: "dist/sex" } } });

/** os / cpu / libc of the target, in package.json terms. */
function platformOf(target: string | undefined) {
  if (!target) {
    const glibc = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
    return {
      os: process.platform as string,
      cpu: process.arch as string,
      libc: process.platform === "linux" ? (glibc ? "glibc" : "musl") : undefined,
    };
  }
  const m = /^bun-(linux|darwin|windows)-(x64|arm64)(?:-(musl))?(?:-(?:baseline|modern))?$/.exec(target);
  if (!m) throw new Error(`unsupported --target ${target}`);
  const os = m[1] === "windows" ? "win32" : (m[1] as string);
  return { os, cpu: m[2] as string, libc: os === "linux" ? (m[3] ? "musl" : "glibc") : undefined };
}

const platform = platformOf(values.target);

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  libc?: string[];
}

/** package.json `os` / `cpu` / `libc` lists, including `!negations`. */
const allows = (list: string[] | undefined, value: string | undefined) =>
  !list?.length || value === undefined || (list.some((v) => !v.startsWith("!")) ? list.includes(value) : !list.includes(`!${value}`));

/** Node resolution from a package directory: its own node_modules, then each parent's. */
function packageDir(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root || dirname(dir) === dir) return undefined;
  }
}

const packages = new Map<string, string>();
function visit(name: string, from: string, optional: boolean) {
  const dir = packageDir(name, from);
  if (!dir) {
    if (optional) return;
    throw new Error(`${name} is not installed (needed by here-docs); run bun install`);
  }
  if (packages.has(dir)) return;
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  if (!allows(manifest.os, platform.os) || !allows(manifest.cpu, platform.cpu) || !allows(manifest.libc, platform.libc)) return;
  packages.set(dir, manifest.name);
  for (const dep of Object.keys(manifest.dependencies ?? {})) visit(dep, dir, false);
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) visit(dep, dir, true);
}
visit("here-docs", root, false);

const files: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue; // nested packages are visited on their own
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
for (const dir of packages.keys()) walk(dir);
files.sort();

const hash = createHash("sha256");
for (const f of files) hash.update(relative(nodeModules, f)).update("\0").update(readFileSync(f));
const digest = hash.digest("hex").slice(0, 16);

const lightpanda = await lightpandaFor(platform);
const lightpandaImport = lightpanda
  ? `import { registerEmbeddedLightpanda } from "./engine/browser.ts";\nimport lightpanda from ${JSON.stringify(lightpanda.path)} with { type: "file" };\nregisterEmbeddedLightpanda(${JSON.stringify(lightpanda.version)}, ${JSON.stringify(lightpanda.sha256)}, lightpanda);\n`
  : "";
console.log(
  lightpanda
    ? `embedding lightpanda ${lightpanda.version} (${(statSync(lightpanda.path).size / 2 ** 20).toFixed(0)} MiB zstd)`
    : `no lightpanda build for ${platform.os}-${platform.cpu}${platform.libc ? `-${platform.libc}` : ""}: --lightpanda needs a binary on PATH`,
);

const adblock = await adblockTable();
const adblockImport = `import { registerEmbeddedAdblock } from "./engine/adblock.ts";\nimport adblock from ${JSON.stringify(adblock.path)} with { type: "file" };\nregisterEmbeddedAdblock(${JSON.stringify(adblock.commit)}, ${JSON.stringify(adblock.sha256)}, adblock);\n`;
console.log(`embedding ad block table ${adblock.commit.slice(0, 12)} (${(statSync(adblock.path).size / 2 ** 10).toFixed(0)} KiB zstd)`);

// Next to cli.ts so its relative imports resolve; the embedded worker's path comes from --root below, not from this file.
const entry = join(root, "packages", "sex", "src", "cli.embedded.gen.ts");
const imports = files.map((f, i) => `import f${i} from ${JSON.stringify(f)} with { type: "file" };`).join("\n");
const table = files.map((f, i) => `  ${JSON.stringify(relative(nodeModules, f))}: f${i},`).join("\n");
writeFileSync(
  entry,
  `// Generated by scripts/build.ts; not checked in.\nimport { registerEmbeddedDocs } from "./engine/docs.ts";\n${imports}\n\nregisterEmbeddedDocs(${JSON.stringify(digest)}, {\n${table}\n});\n${lightpandaImport}${adblockImport}await import("./cli.ts");\n`,
);

const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(
  `embedding here-docs for ${platform.os}-${platform.cpu}${platform.libc ? `-${platform.libc}` : ""}: ${packages.size} packages, ${files.length} files, ${(bytes / 2 ** 20).toFixed(0)} MiB (digest ${digest})`,
);
try {
  // --root: the core extract-pool finds the embedded worker at <root>/core/src/extract-worker.ts.
  const args = ["build", "--compile", "--minify", "--compile-autoload-package-json", "--external", "here-docs", "--root", "packages"];
  if (values.target) args.push("--target", values.target);
  args.push(entry, join(root, "packages/core/src/extract-worker.ts"), "--outfile", values.outfile as string);
  const proc = Bun.spawnSync(["bun", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
} finally {
  rmSync(entry, { force: true });
}
