import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TMP_BASE } from "./bin.ts";

const made: string[] = [];

/** A fresh temporary directory, removed by `removeTempDirs()` (the suites call it in `afterAll`). */
export function tempDir(prefix = "sex-e2e-"): string {
  const dir = mkdtempSync(join(TMP_BASE, prefix));
  made.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}
