import { badRequest } from "@sex/core/errors.ts";
import { fileKindOf } from "@sex/core/rewrite.ts";

/** Limits for user-supplied include/exclude regexes (the request schema allows the same). */
export const MAX_PATTERNS = 100;
export const MAX_PATTERN_LENGTH = 1000;
/** Only this much of a URL is matched, so a pattern cannot be fed an arbitrarily long input. */
export const MAX_MATCH_LENGTH = 2048;

/**
 * Why a regex source risks catastrophic backtracking, or undefined if it looks safe. A heuristic in the spirit of
 * `safe-regex`: an unbounded quantifier on a group that already contains an unbounded quantifier (`(a+)+`), or on a
 * group whose alternatives overlap (`(a|a)*`, `(a|ab)+`). Look-arounds and backreferences are allowed.
 */
export function unsafeRegexReason(source: string): string | undefined {
  interface Group {
    repeats: boolean;
    branches: string[];
    branch: string;
  }
  const stack: Group[] = [{ repeats: false, branches: [], branch: "" }];
  const top = () => stack[stack.length - 1] as Group;
  const unbounded = (i: number): number => {
    // Length of an unbounded quantifier (`*`, `+`, `{n,}`) at i, or 0.
    const c = source[i];
    if (c === "*" || c === "+") return 1;
    if (c === "{") return /^\{\d+,\}/.exec(source.slice(i, i + 20))?.[0].length ?? 0;
    return 0;
  };
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    if (c === "\\") {
      top().branch += source.slice(i, i + 2);
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      top().branch += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      top().branch += c;
    } else if (c === "(") {
      const prefix = /^\(\?(?::|=|!|<=|<!|<[^>]+>)/.exec(source.slice(i, i + 80))?.[0] ?? "(";
      stack.push({ repeats: false, branches: [], branch: "" });
      i += prefix.length - 1;
    } else if (c === ")" && stack.length > 1) {
      const group = stack.pop() as Group;
      group.branches.push(group.branch);
      const q = unbounded(i + 1);
      if (q) {
        if (group.repeats) return "a quantified group that itself contains an unbounded quantifier";
        const branches = group.branches.filter(Boolean);
        for (const [a, x] of branches.entries())
          for (const [b, y] of branches.entries())
            if (a !== b && y.startsWith(x)) return "a quantified group with overlapping alternatives";
      }
      const parent = top();
      parent.repeats ||= group.repeats || q > 0;
      parent.branch += `(${group.branch})`;
    } else if (c === "|") {
      top().branches.push(top().branch);
      top().branch = "";
    } else {
      top().branch += c;
      // The quantifier of an atom marks the enclosing group as repeating.
      if (unbounded(i)) top().repeats = true;
    }
  }
  return undefined;
}

/** Compiles include/exclude regexes; throws 400 for invalid syntax, too many or too long patterns, and risky ones. */
export function compilePatterns(patterns: string[] | undefined, name: string): RegExp[] {
  if ((patterns?.length ?? 0) > MAX_PATTERNS) throw badRequest(`${name} has more than ${MAX_PATTERNS} patterns`);
  return (patterns ?? []).map((p) => {
    if (p.length > MAX_PATTERN_LENGTH) throw badRequest(`Regex in ${name} is longer than ${MAX_PATTERN_LENGTH} characters`);
    let re: RegExp;
    try {
      re = new RegExp(p);
    } catch {
      throw badRequest(`Invalid regex in ${name}: ${p}`);
    }
    const reason = unsafeRegexReason(p);
    if (reason) throw badRequest(`Regex in ${name} could backtrack catastrophically (${reason}): ${p}`);
    return re;
  });
}

/** Whether a pattern passes every check of `compilePatterns`. */
export function isAcceptablePattern(pattern: string): boolean {
  try {
    compilePatterns([pattern], "pattern");
    return true;
  } catch {
    return false;
  }
}

/** Exclude patterns win; with include patterns, one of them has to match. */
export function matchesPatterns(target: string, includes: RegExp[], excludes: RegExp[]): boolean {
  const t = target.length > MAX_MATCH_LENGTH ? target.slice(0, MAX_MATCH_LENGTH) : target;
  if (excludes.some((r) => r.test(t))) return false;
  return !includes.length || includes.some((r) => r.test(t));
}

/** Files that are never worth a crawl slot: archives, media, fonts, binaries and page assets. */
const SKIP_EXT =
  /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|mp3|wav|ogg|oga|flac|aac|m4a|wma|mp4|m4v|mkv|avi|mov|wmv|flv|webm|mpe?g|woff2?|ttf|otf|eot|exe|dmg|msi|apk|iso|bin|deb|rpm|jar|svg|ico|avif|heic|css|js|mjs|map)$/i;

/** True for URLs that are clearly not web pages. PDFs and office documents are kept; images only if `docs` converts them. */
export function isSkippableFile(url: URL, docsEnabled: boolean): boolean {
  if (SKIP_EXT.test(url.pathname)) return true;
  return fileKindOf(url) === "image" && !docsEnabled;
}

/**
 * The directory a crawl or map stays within. `/docs/` and `/docs` both mean the `/docs` section; `/docs/index.html`
 * means the `/docs/` directory; `/` is the whole site.
 */
export function basePathOf(pathname: string): string {
  if (pathname.endsWith("/")) return pathname;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  if (lastSegment.includes(".")) return pathname.replace(/\/[^/]*$/, "/");
  return `${pathname}/`;
}
