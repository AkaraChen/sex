import { domainToASCII } from "node:url";

/**
 * Query operators (`site:`, `inurl:`, `intitle:`, each optionally negated) that search enforces on the returned results,
 * because SearXNG engines apply them inconsistently. Anything the parser is unsure about is left to the engines.
 */
export interface QueryOperators {
  sites: string[];
  excludedSites: string[];
  inurl: string[];
  intitle: string[];
  excludedInurl: string[];
  excludedIntitle: string[];
}

export interface OperatorPlan {
  /** The query sent to SearXNG. */
  query: string;
  operators: QueryOperators;
  /** inurl: / intitle: were taken out of the query (it has a site: too) and are enforced on the results instead. */
  relaxed: boolean;
}

// A quoted phrase matches first, so operator-like text inside it is skipped.
const OPERATOR_TOKEN = /("[^"]*")|(^|[\s(])(-?)(site|inurl|intitle):(?:"([^"]*)"|([^\s()"]+))(\)*)/gi;

const emptyOperators = (): QueryOperators => ({
  sites: [],
  excludedSites: [],
  inurl: [],
  intitle: [],
  excludedInurl: [],
  excludedIntitle: [],
});

function normalizeSite(value: string): string {
  const site = value.replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "");
  const slash = site.indexOf("/");
  const host = slash === -1 ? site : site.slice(0, slash);
  return (domainToASCII(host) || host) + (slash === -1 ? "" : site.slice(slash));
}

/** True when OR / | joins anything other than site: operators, which the matcher cannot represent. */
function hasUnsupportedOr(query: string): boolean {
  const unquoted = query.replace(/"[^"]*"/g, " ");
  const ors = unquoted.match(/(?:^|[\s(])(?:OR|\|)(?=[\s)(]|$)/g)?.length ?? 0;
  const siteOrs = unquoted.match(/site:[^\s()]+\)*\s+(?:OR|\|)\s+(?=\(*site:)/gi)?.length ?? 0;
  return ors > siteOrs;
}

/** An odd number of quotes means a phrase is open, so what is inside and after it cannot be read reliably. */
const hasUnbalancedQuotes = (query: string) => (query.match(/"/g)?.length ?? 0) % 2 === 1;

export function parseQueryOperators(query: string): QueryOperators {
  const operators = emptyOperators();
  if (hasUnbalancedQuotes(query)) return operators;
  for (const match of query.matchAll(OPERATOR_TOKEN)) {
    if (match[1] !== undefined) continue;
    const value = (match[5] ?? match[6] ?? "").trim().toLowerCase();
    if (!value) continue;
    const negated = match[3] === "-";
    switch (match[4]?.toLowerCase()) {
      case "site": {
        const site = normalizeSite(value);
        if (site) (negated ? operators.excludedSites : operators.sites).push(site);
        break;
      }
      case "inurl":
        (negated ? operators.excludedInurl : operators.inurl).push(value);
        break;
      case "intitle":
        (negated ? operators.excludedIntitle : operators.intitle).push(value);
        break;
    }
  }
  return operators;
}

/**
 * Parses the operators of `query`. With a site: next to inurl: / intitle: the query sent on keeps site: and the other
 * terms as plain words (engines often return nothing for the combination) and the inurl: / intitle: filters apply to the results.
 */
export function planOperatorQuery(query: string): OperatorPlan {
  if (hasUnsupportedOr(query)) return { query, operators: emptyOperators(), relaxed: false };
  const operators = parseQueryOperators(query);
  const relaxed =
    operators.sites.length > 0 &&
    operators.inurl.length + operators.intitle.length + operators.excludedInurl.length + operators.excludedIntitle.length > 0;
  if (!relaxed) return { query, operators, relaxed };

  const rewritten = query
    .replace(OPERATOR_TOKEN, (token, phrase, lead, negated, name, quoted, bare, closing) => {
      if (phrase !== undefined || name.toLowerCase() === "site") return token;
      if (negated) return lead + closing;
      return lead + (quoted !== undefined ? `"${quoted}"` : bare) + closing;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { query: rewritten, operators, relaxed };
}

function matchesSite(url: URL, site: string): boolean {
  const slash = site.indexOf("/");
  const host = slash === -1 ? site : site.slice(0, slash);
  const path = slash === -1 ? "" : site.slice(slash);
  const hostname = url.hostname.toLowerCase();
  if (hostname !== host && !hostname.endsWith(`.${host}`)) return false;
  return !path || url.pathname.toLowerCase().startsWith(path);
}

function decodedUrl(url: string): string {
  try {
    return decodeURI(url).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

const inUrl = (url: string, term: string) => term.split(/\s+/).every((word) => url.includes(word));

/** True when the result passes every operator of the plan (a plan without enforceable operators accepts everything). */
export function matchesQueryOperators(result: { url?: string | null; title?: string | null }, plan: OperatorPlan): boolean {
  const { operators, relaxed } = plan;
  const filtersSites = operators.sites.length > 0 || operators.excludedSites.length > 0;
  if (!filtersSites && !relaxed) return true;
  if (!result.url) return false;

  let parsed: URL;
  try {
    parsed = new URL(result.url);
  } catch {
    return false;
  }
  if (operators.excludedSites.some((site) => matchesSite(parsed, site))) return false;
  if (operators.sites.length > 0 && !operators.sites.some((site) => matchesSite(parsed, site))) return false;
  if (!relaxed) return true;

  const url = decodedUrl(result.url);
  const title = (result.title ?? "").toLowerCase();
  return (
    operators.inurl.every((term) => inUrl(url, term)) &&
    !operators.excludedInurl.some((term) => inUrl(url, term)) &&
    operators.intitle.every((term) => title.includes(term)) &&
    !operators.excludedIntitle.some((term) => title.includes(term))
  );
}
