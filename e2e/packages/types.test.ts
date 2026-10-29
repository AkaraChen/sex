import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/bin.ts";
import { killAll, run } from "../lib/proc.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { nodeProject, sharedDone } from "./support.ts";

// A TypeScript project that depends on the installed tarballs and type-checks with the repository's compiler.
const TSC = join(ROOT, "node_modules/.bin/tsc");
let project = "";

const COMMON = {
  target: "es2023",
  strict: true,
  noEmit: true,
  skipLibCheck: false,
  types: ["node"],
  lib: ["es2023", "dom"],
  noUncheckedIndexedAccess: true,
  verbatimModuleSyntax: true,
};
const CONFIGS = {
  bundler: { ...COMMON, module: "esnext", moduleResolution: "bundler" },
  nodenext: { ...COMMON, module: "nodenext", moduleResolution: "nodenext" },
} as const;

beforeAll(async () => {
  project = await nodeProject(["undici", "marked", "yaml", "@types/node"], "types");
  // kept as .ts.txt in the repository: they are only meant to compile against the installed packages (and misuse must not)
  mkdirSync(join(project, "types"), { recursive: true });
  for (const file of ["consumer", "misuse"]) cpSync(join(import.meta.dir, "types", `${file}.ts.txt`), join(project, "types", `${file}.ts`));
  for (const [name, compilerOptions] of Object.entries(CONFIGS)) {
    for (const file of ["consumer", "misuse"]) {
      writeFileSync(
        join(project, `tsconfig.${name}.${file}.json`),
        JSON.stringify({ compilerOptions, files: [`types/${file}.ts`] }, null, 2),
      );
    }
  }
});

afterAll(async () => {
  await killAll();
  removeTempDirs();
  sharedDone();
});

const tsc = (config: string) => run(TSC, ["-p", config, "--pretty", "false"], { cwd: project, timeoutMs: 240_000 });

for (const name of Object.keys(CONFIGS)) {
  describe(`moduleResolution ${name}`, () => {
    test("the consumer's code compiles without errors", async () => {
      const r = await tsc(`tsconfig.${name}.consumer.json`);
      expect(r.stdout + r.stderr).toBe("");
      expect(r.code).toBe(0);
    });

    test("every deliberate misuse is a type error, and nothing else is", async () => {
      const r = await tsc(`tsconfig.${name}.misuse.json`);
      expect(r.code).not.toBe(0);
      const tagged = readFileSync(join(project, "types/misuse.ts"), "utf8")
        .split("\n")
        .flatMap((line, i) => (line.includes("// MISUSE") ? [i + 1] : []));
      expect(tagged.length).toBeGreaterThan(0);
      const errors = [...r.stdout.matchAll(/^types\/misuse\.ts\((\d+),\d+\): error TS\d+/gm)].map((m) => Number(m[1]));
      const elsewhere = r.stdout.split("\n").filter((l) => /error TS/.test(l) && !l.startsWith("types/misuse.ts("));
      expect(elsewhere).toEqual([]);
      expect([...new Set(errors)].sort((a, b) => a - b)).toEqual(tagged);
    });
  });
}
