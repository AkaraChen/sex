import http from "node:http";
import type net from "node:net";
import type { Socket } from "node:net";

// Requests made straight at an EgressProxy, the way a browser would make them (shared by the package's tests and the minified-bundle test in apps/sex).

export interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

/** Records every request; answers by path. */
export function startServer(host = "127.0.0.1") {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    const path = req.url ?? "";
    if (path.startsWith("/redirect")) return void res.writeHead(302, { location: `http://127.0.0.1:${hits.length}/elsewhere` }).end();
    if (path.startsWith("/cookies"))
      return void res.writeHead(200, { "set-cookie": ["a=1", "b=2"], "x-hop": "1", connection: "keep-alive, x-hop" }).end("ok");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => res.writeHead(200, { "content-type": "text/plain" }).end(`${req.method} ${path} ${body}`));
  });
  return new Promise<{ port: number; hits: Hit[]; close: () => void }>((resolve) =>
    server.listen(0, host, () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        hits,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      }),
    ),
  );
}

export const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

/** A plain-http request in absolute form, as a browser sends it to a proxy. */
export function viaProxy(
  proxyUrl: string,
  target: string,
  opts: { auth?: string; method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  const proxy = new URL(proxyUrl);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; rawSetCookie: string[]; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: proxy.hostname,
        port: proxy.port,
        method: opts.method ?? "GET",
        path: target,
        agent: false,
        headers: {
          host: target.startsWith("/") ? "origin-form" : new URL(target).host,
          ...(opts.auth ? { "proxy-authorization": opts.auth } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, rawSetCookie: res.headers["set-cookie"] ?? [], body }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** CONNECT to `authority`; resolves with the proxy's status and, on 200, the open tunnel. */
export function connectTo(proxyUrl: string, authority: string, auth?: string) {
  const proxy = new URL(proxyUrl);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; socket: Socket }>((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: authority,
      agent: false,
      headers: { host: authority, ...(auth ? { "proxy-authorization": auth } : {}) },
    });
    req.once("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, headers: res.headers, socket }));
    req.on("error", reject);
    req.end();
  });
}

/** Sends an HTTP/1.0 request through an open tunnel and reads the answer to the end. */
export function throughTunnel(socket: Socket, path: string, host: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    socket.on("data", (c) => (out += c));
    socket.on("close", () => resolve(out));
    socket.write(`GET ${path} HTTP/1.0\r\nhost: ${host}\r\n\r\n`);
  });
}
