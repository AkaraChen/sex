// Sets the version of every published package (packages/* without "private": true) to one value:
//
//   bun run set-version 0.1.0-rc.1
//
// Until 0.1.0 is out the published packages move in lockstep, so every prerelease is one set of matching versions.
// Internal ranges stay `workspace:*` / `workspace:^`; `bun pm pack` (scripts/release.ts) writes the real versions.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: bun run set-version <semver>, e.g. 0.1.0-rc.1");
  process.exit(2);
}
const root = join(import.meta.dir, "..", "packages");
for (const dir of readdirSync(root)) {
  const file = join(root, dir, "package.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const manifest = JSON.parse(text) as { name: string; version: string; private?: boolean };
  if (manifest.private) continue;
  // Replace only the version line, so the file keeps its formatting.
  writeFileSync(file, text.replace(/"version": "[^"]*"/, `"version": "${version}"`));
  console.log(`${manifest.name} ${manifest.version} -> ${version}`);
}
