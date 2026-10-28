import type { Deadline } from "./deadline.ts";
import type { Engine } from "./engine.ts";
import { decodeBody, safeFetch } from "./net.ts";

interface Rule {
  allow: boolean;
  pattern: string;
  anchored: boolean;
  length: number;
}

export interface Robots {
  isAllowed(url: string): boolean;
  sitemaps: string[];
}

const ALLOW_ALL: Robots = { isAllowed: () => true, sitemaps: [] };

/** robots.txt body that forbids everything; stands in for a server error response (RFC 9309 section 2.3.1.4). */
export const DISALLOW_ALL_TXT = "User-agent: *\nDisallow: /\n";

/** The robots.txt text to apply for a fetched response: 5xx means disallow all, other errors (4xx) mean allow all. */
export function robotsTextFor(status: number, body: () => string): string {
  if (status >= 500) return DISALLOW_ALL_TXT;
  return status < 400 ? body() : "";
}

/** Glob match where `*` matches any run of characters; every other character is literal. */
function globMatch(pattern: string, text: string): boolean {
  let p = 0,
    t = 0,
    star = -1,
    mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

function toRule(allow: boolean, value: string): Rule {
  const anchored = value.endsWith("$");
  const body = (anchored ? value.slice(0, -1) : value).replace(/\*{2,}/g, "*");
  return { allow, pattern: body, anchored, length: value.length };
}

const ruleMatches = (r: Rule, path: string) => globMatch(r.anchored ? r.pattern : `${r.pattern}*`, path);

export function parseRobots(text: string, userAgent: string): Robots {
  const ua = userAgent.toLowerCase();
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[] } | undefined;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      // An empty token matches no crawler (it would otherwise match every user agent as a substring).
      if (value) current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || (key !== "allow" && key !== "disallow")) continue;
    if (key === "disallow" && value === "") continue;
    current.rules.push(toRule(key === "allow", value));
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  return {
    sitemaps,
    isAllowed(url: string) {
      let path: string;
      try {
        const u = new URL(url);
        path = u.pathname + u.search;
      } catch {
        return true;
      }
      let best: Rule | undefined;
      for (const r of rules) {
        if (!ruleMatches(r, path)) continue;
        if (!best || r.length > best.length || (r.length === best.length && r.allow)) best = r;
      }
      return !best || best.allow;
    },
  };
}

export async function fetchRobots(engine: Engine, origin: string, userAgent: string, deadline: Deadline): Promise<Robots> {
  try {
    const res = await safeFetch(`${origin}/robots.txt`, {
      deadline: deadline.slice(10_000),
      allowPrivateNetwork: engine.config.allowPrivateNetwork,
      userAgent: engine.config.userAgent,
      maxBodyBytes: engine.config.maxBodyBytes,
    });
    const text = robotsTextFor(res.status, () => decodeBody(res.body, res.contentType));
    return text ? parseRobots(text, userAgent) : ALLOW_ALL;
  } catch {
    return ALLOW_ALL;
  }
}
