import { createServer, type Server as NetServer, type Socket } from "node:net";
import { startCountingProxy } from "@searxng-js/sex-testing";
import { bin } from "../lib/bin.ts";
import { api, type Env, serve, until } from "../lib/proc.ts";
import { html, prose, type Site, site } from "../lib/sites.ts";
import { tempDir } from "../lib/tmp.ts";

/**
 * A public IP literal. The SSRF check lets it through without a DNS lookup; nothing listens there, so a request only
 * succeeds when something between sex and the internet (the proxy below) delivers it to a local fixture.
 */
export const PUBLIC_IP = "93.184.216.34";

/** What the fixture sites on the loopback listener must never see. */
export interface Listener {
  port: number;
  /** TCP connections accepted on 127.0.0.1 and (when the host has IPv6 loopback) [::1]: anything at all, not only requests. */
  connections: string[];
  stop(): void;
}

/** A tripwire: a raw TCP server that answers 200 to whatever connects and records that somebody did. */
export async function startListener(): Promise<Listener> {
  const connections: string[] = [];
  const onConnection = (family: string) => (socket: Socket) => {
    const entry = `${family} from ${socket.remoteAddress}`;
    connections.push(entry);
    socket.on("error", () => {});
    // What the connection asked for, appended to its entry (for the failure message), then the answer.
    socket.once("data", (d) => {
      connections[connections.indexOf(entry)] = `${entry}: ${d.toString("latin1").split("\r\n").slice(0, 2).join(" | ")}`;
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 6\r\ncontent-type: text/html\r\n\r\nsecret");
    });
    // A connection that never sends anything is still a connection.
    setTimeout(() => socket.destroy(), 2000).unref();
  };
  const v4 = createServer(onConnection("v4"));
  await new Promise<void>((resolve) => v4.listen(0, "127.0.0.1", () => resolve()));
  const port = (v4.address() as { port: number }).port;
  // The same port on ::1 so that [::1] and [::ffff:...] targets reach a tripwire too. No IPv6 loopback: v4 only.
  const servers: NetServer[] = [v4];
  const v6 = createServer(onConnection("v6"));
  v6.on("error", () => {});
  const v6Up = await new Promise<boolean>((resolve) => {
    v6.once("error", () => resolve(false));
    v6.listen(port, "::1", () => resolve(true));
  });
  if (v6Up) servers.push(v6);
  return {
    port,
    connections,
    stop: () => {
      for (const s of servers) s.close();
    },
  };
}

/** Every spelling of a private target the SSRF matrix covers. `port` is the tripwire's; the metadata and 10.x ones have none. */
export function privateTargets(port: number): Array<{ name: string; host: string }> {
  return [
    { name: "127.0.0.1", host: `127.0.0.1:${port}` },
    { name: "localhost", host: `localhost:${port}` },
    { name: "[::1]", host: `[::1]:${port}` },
    { name: "127.1", host: `127.1:${port}` },
    { name: "0x7f000001", host: `0x7f000001:${port}` },
    { name: "[::ffff:127.0.0.1]", host: `[::ffff:127.0.0.1]:${port}` },
    { name: "169.254.169.254", host: "169.254.169.254" },
    { name: "10.0.0.1", host: "10.0.0.1" },
    { name: "[fd00::1]", host: "[fd00::1]" },
    { name: "foo.localhost", host: `foo.localhost:${port}` },
  ];
}

export interface PublicSite {
  /** `http://93.184.216.34`: the only address anything may fetch; the proxy delivers it to `site`. */
  origin: string;
  /** Set this as `SEX_PROXY_URL`. */
  proxyUrl: string;
  /** Requests the proxy was asked for (absolute-form), in order. */
  proxied: string[];
  /** The same requests with the headers sex sent (the fixture behind the proxy does not get them). */
  proxiedRequests: Array<{ url: string; headers: Headers }>;
  /** CONNECT tunnels the proxy was asked for (always refused: the fixture is plain http). */
  connects: string[];
  site: Site;
  /** Forgets the requests so far. */
  clear(): void;
  stop(): void;
}

/**
 * A site that sex may fetch with private networks refused, offline and deterministically: `SEX_PROXY_URL` is a forward
 * proxy that maps every `http://93.184.216.34/<path>` onto a local fixture. sex checks the target (a public literal: fine),
 * hands the request to the proxy, and the proxy answers from the fixture. A private target never gets as far as the proxy
 * (sex refuses it first), so `proxied` is also the proof that nothing private was forwarded. `auth` makes the proxy require
 * Basic credentials (then `proxyUrl` carries them).
 */
export async function startPublicSite(
  handler: (req: Request, url: URL) => Response | Promise<Response>,
  opts: { auth?: string } = {},
): Promise<PublicSite> {
  const s = site(handler);
  const proxy = await startCountingProxy((u) => new URL(`${s.url}${u.pathname}${u.search}`), opts);
  const proxyUrl = opts.auth ? proxy.url.replace("://", `://${opts.auth}@`) : proxy.url;
  return {
    origin: `http://${PUBLIC_IP}`,
    proxyUrl,
    get proxied() {
      return proxy.requests.map((r) => r.url);
    },
    get proxiedRequests() {
      return proxy.requests;
    },
    get connects() {
      return proxy.connects;
    },
    site: s,
    clear() {
      proxy.requests.length = 0;
      proxy.connects.length = 0;
      s.hits.length = 0;
    },
    stop() {
      proxy.close();
      s.stop();
    },
  } as PublicSite;
}

/** A page with enough words for the extractor. */
export const article = (title: string, body = "") => html(title, `<main><article><h1>${title}</h1>${prose(title)}${body}</article></main>`);

export interface JobSnapshot {
  status: string;
  total: number;
  completed: number;
  data: Array<{ markdown?: string; metadata: { sourceURL: string; url?: string; title?: string } }>;
}

/** A crawl / batch status with every page of `data`, following `next`. */
export async function readJob(base: string, kind: "crawl" | "batch/scrape", id: string): Promise<JobSnapshot> {
  let res = await api(base, `/v2/${kind}/${id}`);
  if (res.status !== 200) throw new Error(`GET ${kind}/${id}: ${res.status} ${JSON.stringify(res.body)}`);
  const first = res.body as JobSnapshot & { next?: string | null };
  const data = [...first.data];
  let next = first.next;
  while (next) {
    res = await api(base, new URL(next).pathname + new URL(next).search);
    data.push(...res.body.data);
    next = res.body.next;
  }
  return { status: first.status, total: first.total, completed: first.completed, data };
}

/** Polls until the job is no longer `scraping`. */
export async function jobDone(base: string, kind: "crawl" | "batch/scrape", id: string, timeoutMs = 120_000): Promise<JobSnapshot> {
  return until(async () => {
    const s = await readJob(base, kind, id);
    return s.status === "scraping" ? undefined : s;
  }, timeoutMs);
}

/** Ids of processes whose parent is `pid` (direct children), from /proc. Linux only. */
export async function childrenOf(pid: number): Promise<number[]> {
  const out = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString();
  return out.split("\n").filter(Boolean).map(Number);
}

/** Whether a process exists (a zombie counts as gone). */
export function alive(pid: number): boolean {
  try {
    const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    return stat !== "" && !stat.startsWith("Z");
  } catch {
    return false;
  }
}

/** pids whose command line contains `needle` (pgrep -f), excluding this process. */
export function pidsMatching(needle: string): number[] {
  return Bun.spawnSync(["pgrep", "-f", needle])
    .stdout.toString()
    .split("\n")
    .filter(Boolean)
    .map(Number)
    .filter((p) => p !== process.pid);
}

/** `sex serve` with a data dir of its own (never the developer's `~/.local/share/sex`) and logs at info. */
export const startSex = (args: string[] = [], env: Env = {}) =>
  serve(bin("sex"), ["--data-dir", tempDir("sex-e2e-data-"), "--log-level", "info", ...args], { env });

/** Asserts a scrape was refused as a private-network target. */
export function expectBlocked(res: { status: number; body: { code?: string; success?: boolean } }, label = "") {
  if (res.status !== 403 || res.body.code !== "PRIVATE_NETWORK_BLOCKED") {
    throw new Error(`${label} expected 403 PRIVATE_NETWORK_BLOCKED, got ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  }
}
