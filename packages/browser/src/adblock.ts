/**
 * The EasyList + EasyPrivacy domain table behind `blockAds`: loaded on first use into three Sets and matched by label suffix.
 *
 * The table is made by `scripts/adblock.ts` (pinned upstream commit + SHA-256): `domain`, `~domain` (third-party requests only)
 * or `@domain` (exception) per line. the compiled sex binary embeds it zstd-compressed (`registerEmbeddedAdblock`); from source the same
 * script derives it into the build cache on first use, like Lightpanda from PATH or here-docs from node_modules.
 */

import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import type { Logger } from "./logger.ts";

export class AdBlockList {
  private constructor(
    private readonly block: ReadonlySet<string>,
    private readonly thirdParty: ReadonlySet<string>,
    private readonly allow: ReadonlySet<string>,
  ) {}

  static parse(table: string): AdBlockList {
    const block = new Set<string>();
    const thirdParty = new Set<string>();
    const allow = new Set<string>();
    let start = 0;
    while (start < table.length) {
      let end = table.indexOf("\n", start);
      if (end < 0) end = table.length;
      if (end > start) {
        const first = table.charCodeAt(start);
        if (first === 64 /* @ */) allow.add(table.slice(start + 1, end));
        else if (first === 126 /* ~ */) thirdParty.add(table.slice(start + 1, end));
        else block.add(table.slice(start, end));
      }
      start = end + 1;
    }
    return new AdBlockList(block, thirdParty, allow);
  }

  static readonly empty = AdBlockList.parse("");

  get size(): number {
    return this.block.size + this.thirdParty.size + this.allow.size;
  }

  /**
   * Whether a request to `host` (lowercase, as `URL.hostname`) is an ad or tracker. `pageSite` is the registrable domain of the
   * page, which decides whether a third-party-only rule applies. The host and each parent domain are looked up, from the
   * longest to the shortest, never the bare TLD; an exception on any of them wins over every block rule.
   */
  blocks(host: string, pageSite: string): boolean {
    let blocked = false;
    let dot = host.lastIndexOf(".");
    while (dot > 0) {
      dot = host.lastIndexOf(".", dot - 1);
      const suffix = host.slice(dot + 1);
      if (this.allow.has(suffix)) return false;
      if (blocked) continue;
      if (this.block.has(suffix)) blocked = true;
      else if (this.thirdParty.has(suffix)) blocked = siteOf(host) !== pageSite;
    }
    return blocked;
  }
}

/** Second-level labels under a country code (`co.uk`, `com.au`) that make the registrable domain three labels long. */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);

/** The registrable domain, without a public suffix list: two labels, or three under `co.uk`-style suffixes. IPs stay whole. */
export function siteOf(host: string): string {
  const labels = host.split(".");
  if (labels.length <= 2 || /^[\d.]+$/.test(host) || host.includes(":")) return host;
  const tld = labels[labels.length - 1]!;
  const take = tld.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** The table embedded in the compiled binary by `scripts/build.ts`, zstd-compressed. */
let embedded: { commit: string; sha256: string; file: string } | undefined;

export function registerEmbeddedAdblock(commit: string, sha256: string, file: string): void {
  embedded = { commit, sha256, file };
}

async function readTable(): Promise<string> {
  let file: string;
  if (embedded) file = embedded.file;
  else {
    // Not a literal import: the compiled binary has the table embedded and must not bundle the build scripts, and the
    // published dist must stay one file. From a source checkout the script is next to src/; in a published package it is
    // not, and the import fails (blockAds then has no effect, see below).
    const script = new URL("../scripts/adblock.ts", import.meta.url).href;
    const { adblockTable } = (await import(script)) as typeof import("../scripts/adblock.ts");
    file = (await adblockTable()).path;
  }
  return new TextDecoder().decode(zstdDecompressSync(readFileSync(file)));
}

let loaded: Promise<AdBlockList> | undefined;

/**
 * The list, decompressed and parsed on first use and shared afterwards. A table that cannot be had (a source checkout without
 * network) logs a warning once and means no blocking, not failed scrapes.
 */
export function loadAdBlockList(logger?: Logger): Promise<AdBlockList> {
  loaded ??= (async () => {
    const t0 = performance.now();
    try {
      const list = AdBlockList.parse(await readTable());
      logger?.info("ad block list loaded", { domains: list.size, ms: Math.round(performance.now() - t0) });
      return list;
    } catch (err) {
      logger?.warn("ad block list unavailable; blockAds has no effect", { error: err instanceof Error ? err.message : String(err) });
      return AdBlockList.empty;
    }
  })();
  return loaded;
}
