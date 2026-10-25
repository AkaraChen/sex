import type { Engine } from "./engine.ts";
import { decodeBody, safeFetch } from "./net.ts";

interface Rule {
  allow: boolean;
  pattern: RegExp;
  length: number;
}

export interface Robots {
  isAllowed(url: string): boolean;
  sitemaps: string[];
}

const ALLOW_ALL: Robots = { isAllowed: () => true, sitemaps: [] };

function toRegex(path: string): RegExp {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

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
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || (key !== "allow" && key !== "disallow")) continue;
    if (key === "disallow" && value === "") continue;
    current.rules.push({ allow: key === "allow", pattern: toRegex(value), length: value.length });
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
        if (!r.pattern.test(path)) continue;
        if (!best || r.length > best.length || (r.length === best.length && r.allow)) best = r;
      }
      return !best || best.allow;
    },
  };
}

export async function fetchRobots(engine: Engine, origin: string, userAgent: string, signal?: AbortSignal): Promise<Robots> {
  try {
    const res = await safeFetch(`${origin}/robots.txt`, {
      timeout: 10_000,
      signal,
      allowPrivateNetwork: engine.config.allowPrivateNetwork,
      userAgent: engine.config.userAgent,
    });
    if (res.status >= 400) return ALLOW_ALL;
    return parseRobots(decodeBody(res.body, res.contentType), userAgent);
  } catch {
    return ALLOW_ALL;
  }
}
