// Builds dist/sex-lite: one executable with SearXNG embedded (from the @searxng-js/<platform> package, by bun itself).
// No browser, LLM or here-docs.
//
//   bun packages/sex-lite/scripts/build.ts                          # this host
//   bun packages/sex-lite/scripts/build.ts --target bun-linux-arm64 # another target; its platform packages must be installed
import { join } from "node:path";
import { parseArgs } from "node:util";

const root = join(import.meta.dir, "..", "..", "..");
const { values } = parseArgs({ options: { target: { type: "string" }, outfile: { type: "string", default: "dist/sex-lite" } } });

// --root: the core extract-pool finds the embedded worker at <root>/core/src/extract-worker.ts.
const args = ["build", "--compile", "--minify", "--root", "packages"];
if (values.target) args.push("--target", values.target);
args.push(
  join(root, "packages/sex-lite/src/cli.ts"),
  join(root, "packages/core/src/extract-worker.ts"),
  "--outfile",
  values.outfile as string,
);
const proc = Bun.spawnSync(["bun", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
