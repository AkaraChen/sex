// The EasyList + EasyPrivacy snapshot embedded in dist/sex for `blockAds`, pinned by upstream commit and by the SHA-256 of the
// domain table derived from it. Upgrade deliberately: change EASYLIST_COMMIT, run `bun scripts/adblock.ts` (it prints the new
// hash and counts), put the hash in ADBLOCK_TABLE_SHA256, then run `bun run build` and `bun test test/adblock.test.ts`.
//
// Only domain rules are used (no cosmetic filters, no URL patterns):
//   ||domain^                 block
//   ||domain^$third-party     block when the request leaves the page's site
//   @@||domain^               exception, wins over every block rule
// The table is plain text, one domain per line: `domain`, `~domain` (third-party only) or `@domain` (exception).
// EasyList is dual-licensed GPLv3 / CC BY-SA 3.0, see https://easylist.to/.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const EASYLIST_COMMIT = "09bcff85a3257dc0747e3c674893015af17dd508";
/** SHA-256 of the table `buildTable` derives from the lists at EASYLIST_COMMIT. */
export const ADBLOCK_TABLE_SHA256 = "fad4518420cdd1b21af5de7065ecb3010abf145d79ed865b917b98aaaf48375c";

const TEMPLATES = ["easylist.template", "easyprivacy.template"];
const RULE = /^(@@)?\|\|([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\^(?:\$(third-party|3p))?$/i;

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** One filter line as a table line, or undefined for everything the table cannot express (patterns, options, cosmetic rules). */
export function ruleToTableLine(line: string): string | undefined {
  const m = RULE.exec(line.trim());
  if (!m) return undefined;
  const domain = m[2]!.toLowerCase();
  return m[1] ? `@${domain}` : m[3] ? `~${domain}` : domain;
}

/** The table for a set of filter lists: deduplicated, sorted, and a plain block rule replaces a third-party-only one. */
export function buildTable(lists: Iterable<string>): string {
  const lines = new Set<string>();
  for (const list of lists) {
    for (const line of list.split("\n")) {
      const out = ruleToTableLine(line);
      if (out) lines.add(out);
    }
  }
  for (const line of lines) if (line.startsWith("~") && lines.has(line.slice(1))) lines.delete(line);
  return `${[...lines].sort().join("\n")}\n`;
}

async function fetchText(path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/easylist/easylist/${EASYLIST_COMMIT}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot download ${url}: HTTP ${res.status}`);
  return res.text();
}

/** EasyList and EasyPrivacy are templates of `%include easylist:<path>%` lines; fetch the template and every file it pulls in. */
async function downloadLists(): Promise<string[]> {
  const templates = await Promise.all(TEMPLATES.map(fetchText));
  const paths = new Set<string>();
  for (const t of templates) for (const m of t.matchAll(/^%include easylist:(.+)%$/gm)) paths.add(m[1]!);
  const parts = await Promise.all([...paths].map(fetchText));
  return [...templates, ...parts];
}

export interface EmbeddableAdblock {
  /** zstd-compressed table, to embed with `with { type: "file" }`. */
  path: string;
  commit: string;
  sha256: string;
}

/** The pinned table, derived from the upstream lists once into a build cache and checked against ADBLOCK_TABLE_SHA256. */
export async function adblockTable(): Promise<EmbeddableAdblock> {
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "sex-build");
  const path = join(dir, `adblock-${EASYLIST_COMMIT.slice(0, 12)}-${ADBLOCK_TABLE_SHA256.slice(0, 16)}.zst`);
  const result = { path, commit: EASYLIST_COMMIT, sha256: ADBLOCK_TABLE_SHA256 };
  if (ADBLOCK_TABLE_SHA256 && existsSync(path) && sha256(Bun.zstdDecompressSync(await Bun.file(path).bytes())) === ADBLOCK_TABLE_SHA256) {
    return result;
  }
  console.log(`downloading EasyList + EasyPrivacy at ${EASYLIST_COMMIT.slice(0, 12)}`);
  const table = buildTable(await downloadLists());
  const actual = sha256(table);
  if (actual !== ADBLOCK_TABLE_SHA256) {
    throw new Error(
      `ad block table at ${EASYLIST_COMMIT}: SHA-256 is ${actual} (${table.split("\n").length - 1} domains), expected ${ADBLOCK_TABLE_SHA256}`,
    );
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, Bun.zstdCompressSync(table, { level: 19 }));
  renameSync(tmp, path);
  return result;
}

// `bun scripts/adblock.ts` prints the table's hash and size (to pin a new commit); with an argument it writes the table there.
if (import.meta.main) {
  const table = buildTable(await downloadLists());
  const lines = table.split("\n").filter(Boolean);
  const count = (p: (l: string) => boolean) => lines.filter(p).length;
  console.log(
    `commit ${EASYLIST_COMMIT}\nsha256 ${sha256(table)}\n${lines.length} domains (${count((l) => l.startsWith("@"))} exceptions, ${count((l) => l.startsWith("~"))} third-party only), ${table.length} bytes, zstd ${Bun.zstdCompressSync(table, { level: 19 }).length}`,
  );
  if (process.argv[2]) writeFileSync(process.argv[2], table);
}
