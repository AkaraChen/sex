// Builds every published package (private: false) with tsdown into dist/index.js + dist/index.d.ts, and the private
// libraries whose tests run on Node ("sexNodeTests": true), because those tests import them by name and Node reads dist.
// With none it does nothing and succeeds.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dir = join(root, "packages");
const published = readdirSync(dir).filter((name) => {
  const manifest = join(dir, name, "package.json");
  if (!existsSync(manifest)) return false;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  return pkg.private !== true || pkg.sexNodeTests === true;
});

if (published.length === 0) {
  console.log("no packages to build");
  process.exit(0);
}
for (const name of published) {
  console.log(`building ${name}`);
  const proc = Bun.spawnSync(["bunx", "tsdown"], { cwd: join(dir, name), stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
}
