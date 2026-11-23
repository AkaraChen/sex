/**
 * Which private addresses an operator lets the server reach: an allowlist of networks and host names, plus loopback as a
 * switch of its own. `EgressPolicy` applies it after resolving a host, so an allowed address is pinned like a public one and
 * every redirect hop is checked again.
 *
 * Some addresses are never allowed, whatever the list says: link-local (`169.254.0.0/16`, `fe80::/10`, which holds most
 * cloud metadata services) and the metadata addresses outside it (`NEVER_ALLOWED`).
 */

import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

/** What an operator writes: entries such as `192.168.1.0/24`, `10.0.0.5:8080`, `fd00::/8`, `[fd00::1]:443`, `docs.corp.internal`, `*.corp.internal`. */
export interface PrivateNetworkAllowlist {
  /** Networks (CIDR or a single address) and host names, each optionally with `:port`. */
  allow: readonly string[];
  /** Loopback (`localhost`, `127.0.0.0/8`, `::1`, and the unspecified address, which reaches it): only with this on. */
  loopback?: boolean;
}

/**
 * How far private networks are open: `false` refuses every non-public address, `true` checks nothing (and pins nothing; for
 * tests and local tools), an allowlist opens exactly what it names.
 */
export type PrivateNetworkAccess = boolean | PrivateNetworkAllowlist;

/** One parsed entry. `port` undefined = every port. */
export type PrivateNetworkRule =
  | { kind: "network"; entry: string; range: [ipaddr.IPv4 | ipaddr.IPv6, number]; port: number | undefined }
  | { kind: "host"; entry: string; host: string; wildcard: boolean; port: number | undefined };

/**
 * `syntax`: not a network, address or host name (or not a string); `url`: a URL instead of a host; `port`: a bad port;
 * `prefix`: a bad prefix length; `never`: link-local or metadata only; `loopback`: loopback, which has its own switch.
 */
export type EntryErrorReason = "syntax" | "url" | "port" | "prefix" | "never" | "loopback";

/** An entry that was not understood or can never take effect, with why. */
export interface PrivateNetworkEntryError {
  entry: string;
  /** What is wrong, for a program (a settings form words it itself): see `EntryErrorReason`. */
  reason: EntryErrorReason;
  message: string;
}

export interface ParsedAllowlist {
  rules: PrivateNetworkRule[];
  loopback: boolean;
  errors: PrivateNetworkEntryError[];
}

/**
 * Metadata services that are not link-local, refused even when an allowlist covers them. (`169.254.169.254`,
 * `169.254.170.2` and the rest of `169.254.0.0/16` are refused as link-local.)
 */
export const NEVER_ALLOWED: readonly string[] = [
  "fd00:ec2::254", // AWS IMDS over IPv6
  "100.100.100.200", // Alibaba Cloud
  "168.63.129.16", // Azure wireserver
];
const neverAllowed = new Set(NEVER_ALLOWED.map((a) => ipaddr.parse(a).toNormalizedString()));

const v4Blocked = (a: ipaddr.IPv4) => a.range() !== "unicast";
const fromParts = (hi: number, lo: number) => new ipaddr.IPv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);

/** True for anything that is not a globally routable unicast address (IPv6 forms embedding IPv4 are unwrapped). */
export function isPrivateIp(ip: string): boolean {
  if (!isIP(ip)) return false;
  const addr = ipaddr.parse(ip);
  if (addr.kind() === "ipv4") return v4Blocked(addr as ipaddr.IPv4);
  const v6 = addr as ipaddr.IPv6;
  if (v6.isIPv4MappedAddress()) return v4Blocked(v6.toIPv4Address());
  const p = v6.parts;
  if (p.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1 and deprecated IPv4-compatible ::a.b.c.d
  const range = v6.range();
  if (range === "rfc6052") return v4Blocked(fromParts(p[6] ?? 0, p[7] ?? 0)); // NAT64 64:ff9b::/96
  if (range === "6to4") return v4Blocked(fromParts(p[1] ?? 0, p[2] ?? 0)); // 2002:AABB:CCDD::/48
  return range !== "unicast"; // teredo, ULA, link-local, multicast, reserved, ...
}

/** The address a check should judge: IPv4 embedded in IPv6 (mapped, compatible, NAT64, 6to4) is unwrapped. */
export function effectiveAddress(ip: string): ipaddr.IPv4 | ipaddr.IPv6 {
  const addr = ipaddr.parse(ip);
  if (addr.kind() === "ipv4") return addr;
  const v6 = addr as ipaddr.IPv6;
  if (v6.isIPv4MappedAddress()) return v6.toIPv4Address();
  const p = v6.parts;
  if (p.slice(0, 6).every((x) => x === 0) && (p[6] !== 0 || (p[7] ?? 0) > 1)) return fromParts(p[6] ?? 0, p[7] ?? 0); // ::a.b.c.d
  const range = v6.range();
  if (range === "rfc6052") return fromParts(p[6] ?? 0, p[7] ?? 0);
  if (range === "6to4") return fromParts(p[1] ?? 0, p[2] ?? 0);
  return v6;
}

/** How a private address is treated: never, only with the loopback switch, or when a rule names it. */
export type AddressClass = "public" | "never" | "loopback" | "private";

export function classifyAddress(ip: string): AddressClass {
  const addr = effectiveAddress(ip);
  if (neverAllowed.has(addr.toNormalizedString())) return "never";
  const range = addr.range();
  if (range === "linkLocal") return "never";
  // The unspecified address (`0.0.0.0/8`, `::`) reaches the local machine on Linux.
  if (range === "loopback" || range === "unspecified") return "loopback";
  return isPrivateIp(ip) ? "private" : "public";
}

const PORT = /^\d{1,5}$/;
const HOST_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
const ENTRY_CHARS = /^[\p{L}\p{N}._:*/[\]-]+$/u;

function parsePort(text: string): number | string {
  if (!PORT.test(text)) return `"${text}" is not a port`;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : `${port} is not a port (1-65535)`;
}

/** Splits `entry` into its address or name and an optional port; a bare IPv6 entry has no port (write `[addr]:port`). */
function splitPort(entry: string): { target: string; port?: string } | string {
  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    if (close < 0) return "missing ]";
    const rest = entry.slice(close + 1);
    if (rest !== "" && !rest.startsWith(":")) return `unexpected "${rest}" after ]`;
    return rest === "" ? { target: entry.slice(1, close) } : { target: entry.slice(1, close), port: rest.slice(1) };
  }
  const colons = entry.split(":").length - 1;
  if (colons === 1) {
    const at = entry.indexOf(":");
    return { target: entry.slice(0, at), port: entry.slice(at + 1) };
  }
  return { target: entry };
}

/** One entry to a rule, or why it cannot be one. */
export function parseAllowEntry(raw: string): PrivateNetworkRule | PrivateNetworkEntryError {
  const entry = raw.trim();
  const fail = (message: string, reason: EntryErrorReason = "syntax"): PrivateNetworkEntryError => ({ entry: raw, reason, message });
  if (entry === "") return fail("empty entry");
  if (entry.includes("://")) return fail("write a network or a host name, not a URL", "url");
  if (!ENTRY_CHARS.test(entry)) return fail("not a network, address or host name");
  const split = splitPort(entry);
  if (typeof split === "string") return fail(split);
  let port: number | undefined;
  if (split.port !== undefined) {
    const parsed = parsePort(split.port);
    if (typeof parsed === "string") return fail(parsed, "port");
    port = parsed;
  }
  const target = split.target.toLowerCase();
  const [base = "", bits, extra] = target.split("/");
  if (extra !== undefined) return fail("not a network, address or host name");
  const family = isIP(base);
  if (family !== 0) {
    const max = family === 4 ? 32 : 128;
    if (bits !== undefined && (!/^\d{1,3}$/.test(bits) || Number(bits) > max))
      return fail(`/${bits} is not a prefix length (0-${max})`, "prefix");
    const prefix = bits === undefined ? max : Number(bits);
    const cidr = `${base}/${prefix}`;
    const first = family === 4 ? ipaddr.IPv4.networkAddressFromCIDR(cidr) : ipaddr.IPv6.networkAddressFromCIDR(cidr);
    const last = family === 4 ? ipaddr.IPv4.broadcastAddressFromCIDR(cidr) : ipaddr.IPv6.broadcastAddressFromCIDR(cidr);
    // A network that lies wholly in what the list cannot open is a mistake worth saying; a wider one is fine (those
    // addresses inside it stay refused when checked).
    const firstClass = classifyAddress(first.toString());
    if (firstClass === classifyAddress(last.toString())) {
      if (firstClass === "never") return fail("link-local and cloud metadata addresses are never allowed", "never");
      if (firstClass === "loopback") return fail("loopback is opened by the switch for local services, not by the list", "loopback");
    }
    return { kind: "network", entry: raw, range: [first, prefix], port };
  }
  if (bits !== undefined) return fail("not a network, address or host name");
  // A name: `*.example` matches every name under it (not the name itself).
  const wildcard = target.startsWith("*.");
  const name = (wildcard ? target.slice(2) : target).replace(/\.$/, "");
  let ascii: string;
  try {
    ascii = new URL(`http://${name}/`).hostname;
  } catch {
    return fail("not a network, address or host name");
  }
  const labels = ascii.split(".");
  if (!labels.every((l) => HOST_LABEL.test(l)) || /^\d+$/.test(labels.at(-1) ?? "")) {
    return fail("not a network, address or host name");
  }
  if (ascii === "localhost" || ascii.endsWith(".localhost")) {
    return fail("loopback is opened by the switch for local services, not by the list", "loopback");
  }
  return { kind: "host", entry: raw, host: ascii, wildcard, port };
}

/** Parses an allowlist; entries that fail are reported and left out, the rest apply. */
export function parsePrivateNetworkAllowlist(list: PrivateNetworkAllowlist): ParsedAllowlist {
  const rules: PrivateNetworkRule[] = [];
  const errors: PrivateNetworkEntryError[] = [];
  for (const raw of list.allow) {
    const rule =
      typeof raw === "string" ? parseAllowEntry(raw) : { entry: String(raw), reason: "syntax" as const, message: "not a string" };
    if ("message" in rule) errors.push(rule);
    else rules.push(rule);
  }
  return { rules, loopback: list.loopback === true, errors };
}

function portOf(url: Pick<URL, "port" | "protocol">): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function nameMatches(rule: Extract<PrivateNetworkRule, { kind: "host" }>, host: string): boolean {
  return rule.wildcard ? host.endsWith(`.${rule.host}`) : host === rule.host;
}

/**
 * Whether `address`, one of the addresses `host` resolved to (or `host` itself for a literal), may be connected to for
 * `url` under `allowlist`. Public addresses always may; `never` ones never; loopback only with the switch; any other private
 * address when a network rule contains it or a host rule names `host`, on a matching port.
 */
export function allowlistAllows(allowlist: ParsedAllowlist, url: Pick<URL, "port" | "protocol">, host: string, address: string): boolean {
  const cls = classifyAddress(address);
  if (cls === "public") return true;
  if (cls === "never") return false;
  if (cls === "loopback") return allowlist.loopback;
  const port = portOf(url);
  const addr = effectiveAddress(address);
  return allowlist.rules.some((rule) => {
    if (rule.port !== undefined && rule.port !== port) return false;
    if (rule.kind === "host") return nameMatches(rule, host);
    return rule.range[0].kind() === addr.kind() && addr.match(rule.range);
  });
}
