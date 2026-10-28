// The Lightpanda release embedded in dist/sex, pinned by version and SHA-256 per platform.
// Upgrade deliberately: change VERSION and every hash (from `gh release view <version> -R lightpanda-io/browser --json assets`),
// then run `bun run build` and SEX_TEST_LIGHTPANDA_PATH=<the binary> bun test test/browser.test.ts.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LIGHTPANDA_VERSION = "1.0.2";

/** Release asset and its SHA-256 per `<os>-<cpu>`; Lightpanda has no Windows build, and the Linux ones need glibc 2.35+. */
const ASSETS: Record<string, { name: string; sha256: string }> = {
  "linux-x64": { name: "lightpanda-x86_64-linux", sha256: "ae7d01d261efb9e480e18ce3424533332883863bcf70b12a4321b5733f37e19e" },
  "linux-arm64": { name: "lightpanda-aarch64-linux", sha256: "ac546dfc43c533430da92b75ab36f2a29da7d6324d5d38baf606ef2e0d849345" },
  "darwin-x64": { name: "lightpanda-x86_64-macos", sha256: "91a775ecc67937d8d79c1b1a315748e52157804f18f629c6e1c6332a46255fc6" },
  "darwin-arm64": { name: "lightpanda-aarch64-macos", sha256: "9f3ee749a55d1abc5f8fdda0d9559c3b2abcec5bff5bfe902bc06c0a89538ec4" },
};

export interface EmbeddableLightpanda {
  /** zstd-compressed binary, to embed with `with { type: "file" }`. */
  path: string;
  version: string;
  sha256: string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The pinned Lightpanda binary for a target, downloaded once into a build cache, checked against its SHA-256 and
 * compressed with zstd (76 MB -> about 23 MB). Undefined for targets without a Lightpanda build (Windows, musl).
 */
export async function lightpandaFor(platform: { os: string; cpu: string; libc?: string }): Promise<EmbeddableLightpanda | undefined> {
  if (platform.libc === "musl") return undefined;
  const asset = ASSETS[`${platform.os}-${platform.cpu}`];
  if (!asset) return undefined;
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sex-build");
  const path = join(dir, `${asset.name}-${LIGHTPANDA_VERSION}-${asset.sha256.slice(0, 16)}.zst`);
  if (existsSync(path) && sha256(Bun.zstdDecompressSync(await Bun.file(path).bytes())) === asset.sha256) {
    return { path, version: LIGHTPANDA_VERSION, sha256: asset.sha256 };
  }
  const url = `https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/${asset.name}`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot download ${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== asset.sha256) throw new Error(`${asset.name} ${LIGHTPANDA_VERSION}: SHA-256 is ${actual}, expected ${asset.sha256}`);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, Bun.zstdCompressSync(bytes, { level: 10 }));
  renameSync(tmp, path);
  return { path, version: LIGHTPANDA_VERSION, sha256: asset.sha256 };
}
