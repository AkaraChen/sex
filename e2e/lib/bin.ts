import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The repository root. */
export const ROOT = resolve(import.meta.dir, "../..");

/** HTML pages, report.docx, scan.pdf, hello.png: the fixtures the app tests use. */
export const FIXTURES = join(ROOT, "apps/sex/test/fixtures");

/** Where the binaries are: `SEX_E2E_BIN_DIR` (CI downloads them there), else `dist/` from `bun run build` / `build:lite`. */
const BIN_DIR = process.env.SEX_E2E_BIN_DIR ? resolve(process.env.SEX_E2E_BIN_DIR) : join(ROOT, "dist");

/** Base directory for temporary files: `SEX_E2E_TMP` (a local /tmp may be small), else the OS temp dir. */
export const TMP_BASE = process.env.SEX_E2E_TMP ? resolve(process.env.SEX_E2E_TMP) : tmpdir();

/** Path of a built binary; fails loudly when it is missing instead of skipping. */
export function bin(name: "sex" | "sex-lite"): string {
  const path = join(BIN_DIR, name);
  if (!existsSync(path)) throw new Error(`${path} not found: run \`bun run build\` / \`bun run build:lite\`, or set SEX_E2E_BIN_DIR`);
  return path;
}
