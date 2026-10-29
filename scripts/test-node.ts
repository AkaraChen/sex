// Runs node --test over the tests of published packages and of the private libraries bundled into them, against dist.
// A package opts in by having test/*.test.ts; apps and apps-only libraries (sex-server) stay on bun:test.
// With none it does nothing and succeeds.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "packages");
const files: string[] = [];
for (const name of readdirSync(dir)) {
  const manifest = join(dir, name, "package.json");
  const tests = join(dir, name, "test");
  if (!existsSync(manifest) || !existsSync(tests)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.sexNodeTests !== true) continue;
  for (const f of readdirSync(tests)) if (f.endsWith(".test.ts")) files.push(join(tests, f));
}

if (files.length === 0) {
  console.log("no Node tests");
  process.exit(0);
}
const proc = Bun.spawnSync(["node", "--test", ...files], { cwd: root, stdout: "inherit", stderr: "inherit" });
process.exit(proc.exitCode ?? 1);
