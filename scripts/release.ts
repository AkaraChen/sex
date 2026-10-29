// Publishes every published package (packages/* without "private": true) whose package.json version is not on npm yet.
//
//   bun run release            # publish what is missing (CI: through npm trusted publishing, with provenance)
//   bun run release --dry-run  # pack and print what would be published
//
// Run `bun run build:packages` first. Each package is packed with `bun pm pack` (which turns `workspace:` ranges into the
// real versions) and the tarball is published with the npm CLI, in dependency order. A prerelease (`0.1.0-rc.1`) goes to
// the `next` dist-tag, a release to `latest`. In GitHub Actions npm authenticates through OIDC (no token): each package
// must have this repository's release.yml as its trusted publisher (see RELEASING.md). After publishing, CI pushes a
// `<name>@<version>` git tag for each package it published.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dryRun = process.argv.includes("--dry-run");
const ci = process.env.GITHUB_ACTIONS === "true";

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const packages = readdirSync(join(root, "packages"))
  .map((dir) => ({ dir: join(root, "packages", dir), file: join(root, "packages", dir, "package.json") }))
  .filter((p) => existsSync(p.file))
  .map((p) => ({ dir: p.dir, manifest: JSON.parse(readFileSync(p.file, "utf8")) as Manifest }))
  .filter((p) => !p.manifest.private);

// Dependencies first, so a dependent is never on npm before the version it needs.
const byName = new Map(packages.map((p) => [p.manifest.name, p]));
const ordered: typeof packages = [];
const visiting = new Set<string>();
function visit(name: string) {
  const p = byName.get(name);
  if (!p || ordered.includes(p)) return;
  if (visiting.has(name)) throw new Error(`dependency cycle through ${name}`);
  visiting.add(name);
  for (const dep of Object.keys({ ...p.manifest.dependencies, ...p.manifest.peerDependencies })) visit(dep);
  visiting.delete(name);
  ordered.push(p);
}
for (const name of byName.keys()) visit(name);

function sh(cmd: string[], cwd = root): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

/** Whether `name@version` is on the registry (404 = not yet). */
function published(name: string, version: string): boolean {
  const r = sh(["npm", "view", `${name}@${version}`, "version", "--json"]);
  if (r.code === 0) return r.out.trim() !== "";
  if (/E404|404 Not Found/.test(r.out)) return false;
  throw new Error(`npm view ${name}@${version} failed:\n${r.out}`);
}

const missing = ordered.filter((p) => !published(p.manifest.name, p.manifest.version));
if (missing.length === 0) {
  console.log("Every published package's version is already on npm; nothing to do.");
  process.exit(0);
}
for (const p of missing) {
  if (!existsSync(join(p.dir, "dist", "index.js"))) throw new Error(`${p.manifest.name}: no dist/ — run \`bun run build:packages\` first`);
}

const out = mkdtempSync(join(tmpdir(), "sex-release-"));
const done: string[] = [];
try {
  for (const p of missing) {
    const { name, version } = p.manifest;
    const tag = version.includes("-") ? "next" : "latest";
    const before = new Set(readdirSync(out));
    const pack = sh(["bun", "pm", "pack", "--destination", out], p.dir);
    if (pack.code !== 0) throw new Error(`bun pm pack failed for ${name}:\n${pack.out}`);
    const tarball = readdirSync(out).find((f) => f.endsWith(".tgz") && !before.has(f));
    if (!tarball) throw new Error(`bun pm pack wrote no tarball for ${name}`);
    const args = ["npm", "publish", join(out, tarball), "--access", "public", "--tag", tag];
    if (ci) args.push("--provenance");
    if (dryRun) args.push("--dry-run");
    console.log(`${dryRun ? "[dry run] " : ""}publishing ${name}@${version} (tag ${tag})`);
    const r = Bun.spawnSync(args, { cwd: root, stdout: "inherit", stderr: "inherit", stdin: "inherit" });
    if (r.exitCode !== 0) throw new Error(`npm publish failed for ${name}@${version}`);
    done.push(`${name}@${version}`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (ci && !dryRun && done.length) {
  for (const tag of done) {
    const r = sh(["git", "tag", tag]);
    if (r.code !== 0) console.warn(`could not tag ${tag}: ${r.out}`);
  }
  const push = sh(["git", "push", "origin", ...done.map((t) => `refs/tags/${t}`)]);
  if (push.code !== 0) console.warn(`could not push tags: ${push.out}`);
}
console.log(`${dryRun ? "would publish" : "published"}: ${done.join(", ")}`);
