/**
 * `EgressProxy`: a forward proxy on a random loopback port that a browser on this machine is pointed at, so that the
 * rules of `EgressPolicy` (core) hold for every request it makes: documents, redirects, subresources, service workers,
 * WebSockets, whatever the page does, and also in places CDP request interception never sees.
 *
 * - `CONNECT host:port` (https, wss): checked, then a tunnel to the address the check validated.
 * - absolute-form `GET http://host/path` (plain http): checked, then forwarded to the validated address with the original
 *   `Host`. Redirects are never followed; the browser gets them as they are and asks again, so each hop is checked.
 * - Ad and tracker domains (`blockAds`) are refused by host name, before any lookup.
 *
 * A scrape gets a lease: its own username and password (`Proxy-Authorization: Basic`), its own policy (ad list, upstream
 * proxy), and the lease's sockets are destroyed when it ends. Nothing on the machine without the password can use the proxy.
 *
 * With an upstream proxy (`SEX_PROXY_URL`) the request is chained to it. The upstream resolves the name, so the connection
 * cannot be pinned: the host is checked here once (and must resolve here), as `safeFetch` does behind a proxy; a DNS answer
 * that changes between that check and the upstream's own lookup is for the upstream to stop (README, "出站代理").
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http, { type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import { pipeline } from "node:stream";
import { type EgressPolicy, MAX_PINNED_ADDRESSES } from "@searxng-js/sex-egress";
import { AppError } from "@searxng-js/sex-errors";
import { log } from "@searxng-js/sex-server/log";
import { type AdBlockList, siteOf } from "./adblock.ts";

const CONNECT_TIMEOUT_MS = 10_000;
/** No byte in either direction for this long: the connection is dropped. */
const IDLE_TIMEOUT_MS = 60_000;
/** Marks a response the proxy made itself, and why (`refused`: not a public address, `dns`: no such host, `ad`, `upstream`). */
export const EGRESS_HEADER = "x-sex-egress";

export type EgressFailure = "refused" | "dns";

export interface EgressSessionOptions {
  /** Refuse the ad and tracker domains of this list. `pageUrl` is the page being scraped, whose own host is never refused. */
  adBlock?: { list: AdBlockList; pageUrl: string };
  /** Chain through this proxy (`http(s)://[user:pass@]host:port`) instead of connecting out directly. */
  upstream?: string;
}

/** What one scrape holds on the proxy. */
export interface EgressLease {
  /** `http://127.0.0.1:<port>` for `proxyServer`, without credentials. */
  readonly server: string;
  readonly credentials: { username: string; password: string };
  /** `server` with the credentials in the URL, for browsers that send them without being challenged (Lightpanda). */
  readonly url: string;
  /** Why the proxy turned a host away, if it did: a private address, or a name that does not resolve. */
  failureOf(host: string): EgressFailure | undefined;
  /** Requests refused as ads or trackers so far. */
  adsBlocked(): number;
  /** Ends the lease: its credentials stop working and its connections are closed. */
  close(): void;
}

interface Session {
  readonly digest: Buffer;
  readonly upstream?: URL;
  readonly adBlock?: { list: AdBlockList; pageHost: string; pageSite: string };
  readonly failures: Map<string, EgressFailure>;
  readonly live: Set<{ destroy(): unknown }>;
  ads: number;
  /** The lease ended. Work that was waiting on a lookup must not open a connection nobody will close. */
  closed: boolean;
}

type Admission =
  | { ok: true; addresses: readonly string[] }
  | { ok: false; status: number; kind: "refused" | "dns" | "ad"; message: string };

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const sha256 = (text: string) => createHash("sha256").update(text).digest();

/** Headers to send on, without the hop-by-hop ones, the ones `Connection` names, and `Proxy-*` (which are for this proxy alone). */
function forwardable(headers: OutgoingHttpHeaders | IncomingMessage["headers"]): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((t) => t.trim()),
  );
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name) || name.startsWith("proxy-")) continue;
    out[name] = value;
  }
  return out;
}

const basic = (url: URL) =>
  url.username
    ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`
    : undefined;

export class EgressProxy {
  private server?: Server;
  private starting?: Promise<number>;
  private readonly sessions = new Map<string, Session>();
  /** Pools for the origin side and the upstream side: reusing a connection saves the handshake of every subresource. */
  private readonly agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };

  constructor(
    private readonly policy: EgressPolicy,
    /** Tests shorten the idle timeout. */
    private readonly idleMs = IDLE_TIMEOUT_MS,
  ) {}

  /** Starts listening on first use. */
  private start(): Promise<number> {
    this.starting ??= new Promise<number>((resolve, reject) => {
      const server = http.createServer((req, res) => this.onRequest(req, res));
      server.on("connect", (req, socket, head) => this.onConnect(req, socket as Socket, head));
      server.on("clientError", (_err, socket) => socket.destroy());
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (err) => log.warn("egress proxy error", { error: err.message }));
        this.server = server;
        const addr = server.address();
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("egress proxy has no port"));
      });
    }).catch((err) => {
      this.starting = undefined;
      throw new AppError("BROWSER_UNAVAILABLE", `The egress proxy did not start: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.starting;
  }

  async open(options: EgressSessionOptions = {}): Promise<EgressLease> {
    const port = await this.start();
    const username = randomBytes(9).toString("base64url");
    const password = randomBytes(24).toString("base64url");
    const pageHost = options.adBlock ? new URL(options.adBlock.pageUrl).hostname : undefined;
    const session: Session = {
      digest: sha256(password),
      ...(options.upstream ? { upstream: new URL(options.upstream) } : {}),
      ...(options.adBlock && pageHost ? { adBlock: { list: options.adBlock.list, pageHost, pageSite: siteOf(pageHost) } } : {}),
      failures: new Map(),
      live: new Set(),
      ads: 0,
      closed: false,
    };
    this.sessions.set(username, session);
    const server = `http://127.0.0.1:${port}`;
    return {
      server,
      credentials: { username, password },
      url: `http://${username}:${password}@127.0.0.1:${port}`,
      failureOf: (host) => session.failures.get(host.toLowerCase()),
      adsBlocked: () => session.ads,
      close: () => {
        session.closed = true;
        this.sessions.delete(username);
        for (const item of session.live) item.destroy();
        session.live.clear();
      },
    };
  }

  async close(): Promise<void> {
    this.sessions.clear();
    this.agents.http.destroy();
    this.agents.https.destroy();
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // --- admission -------------------------------------------------------------------------------------------------------

  /** The session behind a `Proxy-Authorization: Basic` header, compared in constant time. */
  private authenticate(header: string | undefined): Session | undefined {
    const match = /^Basic\s+(\S+)$/i.exec(header ?? "");
    if (!match) return undefined;
    const decoded = Buffer.from(match[1] as string, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return undefined;
    const session = this.sessions.get(decoded.slice(0, colon));
    const given = sha256(decoded.slice(colon + 1));
    // A compare for an unknown user too, so the answer takes as long either way.
    const known = session?.digest ?? given;
    return timingSafeEqual(given, known) && session ? session : undefined;
  }

  /** Whether the session may reach `url`, and which addresses to connect to if so. */
  private async admit(session: Session, url: URL): Promise<Admission> {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (session.adBlock && host !== session.adBlock.pageHost && session.adBlock.list.blocks(host, session.adBlock.pageSite)) {
      session.ads++;
      return { ok: false, status: 403, kind: "ad", message: "blocked: ad or tracker" };
    }
    try {
      return { ok: true, addresses: await this.policy.resolve(url, !!session.upstream) };
    } catch (err) {
      if (!AppError.isInstance(err)) throw err;
      const kind = err.code === "PRIVATE_NETWORK_BLOCKED" ? "refused" : "dns";
      session.failures.set(host.toLowerCase(), kind);
      log.debug("egress proxy refused", { host, kind });
      return { ok: false, status: kind === "refused" ? 403 : 502, kind, message: err.message };
    }
  }

  // --- plain http ------------------------------------------------------------------------------------------------------

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const session = this.authenticate(req.headers["proxy-authorization"]);
      if (!session) return reject(res, 407, "auth", "Proxy authentication required", { "proxy-authenticate": 'Basic realm="sex-egress"' });
      let url: URL;
      try {
        url = new URL(req.url ?? "");
      } catch {
        return reject(res, 400, "bad-request", "This is a forward proxy: send an absolute URL");
      }
      if (url.protocol !== "http:") return reject(res, 400, "bad-request", "Only http:// is forwarded; use CONNECT for https");
      const admission = await this.admit(session, url);
      if (!admission.ok) return reject(res, admission.status, admission.kind, admission.message);
      if (session.closed) return void res.destroy();
      this.forward(session, req, res, url, admission.addresses);
    } catch (err) {
      if (!res.headersSent) reject(res, 502, "upstream", err instanceof Error ? err.message : String(err));
      else res.destroy();
    }
  }

  private forward(session: Session, req: IncomingMessage, res: ServerResponse, url: URL, addresses: readonly string[]): void {
    const headers = { ...forwardable(req.headers), host: url.host };
    const upstream = session.upstream;
    // Without body the request can be sent again to the next address when a connection fails.
    const bodyless = req.headers["content-length"] === undefined && req.headers["transfer-encoding"] === undefined;
    // To the upstream the request keeps its absolute form; directly it goes to a validated address (or the literal) as origin-form.
    const targets: Array<http.RequestOptions & { https?: boolean }> = upstream
      ? [
          {
            host: upstream.hostname,
            port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
            path: url.href,
            https: upstream.protocol === "https:",
            headers: { ...headers, ...(basic(upstream) ? { "proxy-authorization": basic(upstream) } : {}) },
          },
        ]
      : (addresses.length ? addresses.slice(0, MAX_PINNED_ADDRESSES) : [url.hostname.replace(/^\[|\]$/g, "")]).map((host) => ({
          host,
          port: url.port || 80,
          path: url.pathname + url.search,
          headers,
        }));

    let attempt = 0;
    let current: ClientRequest | undefined;
    const send = (): void => {
      const target = targets[attempt] as (typeof targets)[number];
      const agent = target.https ? this.agents.https : this.agents.http;
      const out: ClientRequest = (target.https ? https : http).request({
        ...target,
        method: req.method,
        agent,
        setHost: false,
        timeout: CONNECT_TIMEOUT_MS,
      });
      current = out;
      session.live.add(out);
      out.once("close", () => session.live.delete(out));
      out.once("socket", (socket) => socket.setTimeout(this.idleMs));
      out.on("timeout", () => out.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
      out.once("response", (upRes) => {
        const responseHeaders = forwardable(upRes.headers);
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, responseHeaders);
        session.live.add(upRes);
        pipeline(upRes, res, () => session.live.delete(upRes));
      });
      out.once("error", (err: NodeJS.ErrnoException) => {
        if (res.headersSent || res.destroyed) return res.destroy();
        if (
          bodyless &&
          attempt + 1 < targets.length &&
          /^(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL)$/.test(err.code ?? "")
        ) {
          attempt++;
          return send();
        }
        const failed = unreachable(session, url, err);
        reject(res, failed.status, failed.kind, failed.message);
      });
      if (bodyless) {
        req.resume();
        out.end();
      } else if (attempt === 0) {
        pipeline(req, out, () => {});
      }
    };
    // The browser gave up on the request (or the lease ended): so does the one to the origin.
    res.once("close", () => {
      if (!res.writableFinished) current?.destroy();
    });
    send();
  }

  // --- CONNECT ---------------------------------------------------------------------------------------------------------

  private async onConnect(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    client.on("error", () => client.destroy());
    let session: Session | undefined;
    let url: URL | undefined;
    try {
      const authed = this.authenticate(req.headers["proxy-authorization"]);
      session = authed;
      if (!authed)
        return refuseSocket(client, 407, "auth", "Proxy authentication required", { "proxy-authenticate": 'Basic realm="sex-egress"' });
      const authority = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(req.url ?? "");
      const port = Number(authority?.[2]);
      try {
        if (authority && port > 0 && port < 65536) url = new URL(`http://${authority[1]}`);
      } catch {
        // falls through to the 400
      }
      if (!url) return refuseSocket(client, 400, "bad-request", "CONNECT needs host:port");
      const admission = await this.admit(authed, url);
      if (!admission.ok) return refuseSocket(client, admission.status, admission.kind, admission.message);
      if (client.destroyed || authed.closed) return void client.destroy();

      authed.live.add(client);
      client.once("close", () => authed.live.delete(client));
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const upstreamSocket = authed.upstream
        ? await tunnelThrough(authed.upstream, `${url.hostname}:${port}`)
        : await connectAny(admission.addresses.length ? admission.addresses.slice(0, MAX_PINNED_ADDRESSES) : [host], port);
      if (client.destroyed || authed.closed) {
        upstreamSocket.destroy();
        return void client.destroy();
      }
      authed.live.add(upstreamSocket);
      upstreamSocket.once("close", () => authed.live.delete(upstreamSocket));

      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstreamSocket.write(head);
      client.setTimeout(this.idleMs, () => client.destroy());
      upstreamSocket.setTimeout(this.idleMs, () => upstreamSocket.destroy());
      // Either side ending or failing takes the other down with it.
      pipeline(client, upstreamSocket, () => client.destroy());
      pipeline(upstreamSocket, client, () => upstreamSocket.destroy());
    } catch (err) {
      if (client.destroyed) return;
      const failed = unreachable(session, url, err);
      refuseSocket(client, failed.status, failed.kind, failed.message);
    }
  }
}

/** The answer for a connection that could not be made: a name that does not exist (remembered on the lease), or an address that did not answer. */
function unreachable(
  session: Session | undefined,
  url: URL | undefined,
  err: unknown,
): { status: number; kind: "dns" | "upstream"; message: string } {
  const code = (err as NodeJS.ErrnoException).code ?? "";
  const message = err instanceof Error ? err.message : String(err);
  if (/^(ENOTFOUND|EAI_\w+)$/.test(code) && url) {
    session?.failures.set(url.hostname.replace(/^\[|\]$/g, "").toLowerCase(), "dns");
    return { status: 502, kind: "dns", message: `Could not resolve ${url.hostname}` };
  }
  return {
    status: code === "ETIMEDOUT" ? 504 : 502,
    kind: "upstream",
    message: url ? `Could not reach ${url.host}: ${code || message}` : message,
  };
}

// --- helpers -------------------------------------------------------------------------------------------------------------

function reject(res: ServerResponse, status: number, kind: string, message: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message),
    connection: "close",
    [EGRESS_HEADER]: kind,
    ...extra,
  });
  res.end(message);
}

function refuseSocket(socket: Socket, status: number, kind: string, message: string, extra: Record<string, string> = {}): void {
  const head = Object.entries({
    "content-length": String(Buffer.byteLength(message)),
    connection: "close",
    [EGRESS_HEADER]: kind,
    ...extra,
  })
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\n${head}\r\n${message}`);
}

/** The first of the addresses that accepts a connection. */
async function connectAny(addresses: readonly string[], port: number): Promise<Socket> {
  let last: unknown;
  for (const host of addresses) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = net.connect({ host, port, timeout: CONNECT_TIMEOUT_MS });
        socket.once("connect", () => {
          socket.setTimeout(0);
          socket.off("error", reject);
          socket.on("error", () => socket.destroy());
          resolve(socket);
        });
        socket.once("timeout", () => socket.destroy(Object.assign(new Error(`connecting to ${host} timed out`), { code: "ETIMEDOUT" })));
        socket.once("error", reject);
      });
    } catch (err) {
      last = err;
    }
  }
  throw last ?? new Error("no address to connect to");
}

/** A tunnel to `authority` that the upstream proxy opened with CONNECT. */
function tunnelThrough(upstream: URL, authority: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const secure = upstream.protocol === "https:";
    const auth = basic(upstream);
    const req = (secure ? https : http).request({
      host: upstream.hostname,
      port: upstream.port || (secure ? 443 : 80),
      method: "CONNECT",
      path: authority,
      headers: { host: authority, ...(auth ? { "proxy-authorization": auth } : {}) },
      agent: false,
      timeout: CONNECT_TIMEOUT_MS,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode === 200) {
        socket.setTimeout(0);
        socket.on("error", () => socket.destroy());
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`the upstream proxy answered ${res.statusCode} to CONNECT ${authority}`));
      }
    });
    req.once("timeout", () => req.destroy(Object.assign(new Error("the upstream proxy timed out"), { code: "ETIMEDOUT" })));
    req.once("error", reject);
    req.end();
  });
}
