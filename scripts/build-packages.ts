// Builds every published package (private: false) and the private libraries whose tests run on Node
// ("sexNodeTests": true) in one tsdown workspace build: one process, the packages compiling in parallel.
// With none it does nothing and succeeds.
//
//   bun scripts/build-packages.ts                  # everything
//   bun scripts/build-packages.ts scrape map       # only these package directories (Bun.Glob patterns)
//   bun scripts/build-packages.ts --concurrency 2  # cap parallel builds (default: 4, or fewer on small machines)
//
// No dependency order is needed: a package resolves its workspace siblings through the "sex-source" condition to
// their src/ (conditionNames in each tsdown.config.ts) and the dts builds share packages/tsconfig.build.json, so no
// package reads another's dist. A new package needs no change here — it is picked up when its manifest says so.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const root = join(import.meta.dir, "..");
const dir = join(root, "packages");
const { values, positionals } = parseArgs({
  options: { concurrency: { type: "string", short: "c" } },
  allowPositionals: true,
});

const buildable = readdirSync(dir).filter((name) => {
  const manifest = join(dir, name, "package.json");
  if (!existsSync(manifest)) return false;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  return pkg.private !== true || pkg.sexNodeTests === true;
});

const selected = positionals.length
  ? buildable.filter((name) => positionals.some((pattern) => new Bun.Glob(pattern).match(name)))
  : buildable;
if (positionals.length) {
  const unknown = positionals.filter((pattern) => !buildable.some((name) => new Bun.Glob(pattern).match(name)));
  if (unknown.length) {
    console.error(`no buildable package matches ${unknown.join(", ")}\nbuildable: ${buildable.join(", ")}`);
    process.exit(1);
  }
}
if (selected.length === 0) {
  console.log("no packages to build");
  process.exit(0);
}

const concurrency = values.concurrency ? Number(values.concurrency) : Math.min(4, Math.max(1, availableParallelism() - 1));
if (!Number.isInteger(concurrency) || concurrency < 1) {
  console.error("--concurrency must be a positive integer");
  process.exit(1);
}

console.log(`building ${selected.length} package${selected.length === 1 ? "" : "s"}: ${selected.join(" ")}`);
const started = performance.now();
const proc = Bun.spawnSync(
  ["bun", "x", "tsdown", "-W", "--concurrency", String(concurrency), ...selected.flatMap((name) => ["-F", `packages/${name}`])],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
console.log(`built ${selected.length} package${selected.length === 1 ? "" : "s"} in ${((performance.now() - started) / 1000).toFixed(1)}s`);
