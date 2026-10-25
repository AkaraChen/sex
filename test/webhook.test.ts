import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { resolveConfig } from "../src/config.ts";
import { type JobRecord, sendWebhook } from "../src/core/jobs/index.ts";
import { safeFetch } from "../src/core/net.ts";
import { waitFor } from "./helpers.ts";

interface Hit {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** Local fixture server that records every request it receives. */
function serve(route: (req: Request) => Response) {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      hits.push({
        method: req.method,
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
      });
      return route(req);
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

let target: ReturnType<typeof serve>;
let front: ReturnType<typeof serve>;

beforeAll(() => {
  target = serve(() => new Response("ok"));
  front = serve((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/cross") return Response.redirect(`${target.origin}/landing`, 307);
    if (path === "/same") return Response.redirect(`${front.origin}/landing`, 302);
    if (path === "/post-303") return Response.redirect(`${target.origin}/landing`, 303);
    if (path === "/post-307") return Response.redirect(`${target.origin}/landing`, 307);
    return new Response("ok");
  });
});

afterAll(() => {
  target.stop();
  front.stop();
});

beforeEach(() => {
  target.hits.length = 0;
  front.hits.length = 0;
});

const config = (allowPrivateNetwork: boolean) => resolveConfig({ allowPrivateNetwork }, { allowPrivateNetwork }, {});

const job = (webhook: unknown): JobRecord => ({
  id: "job-1",
  kind: "crawl",
  status: "completed",
  options: { webhook },
  createdAt: 0,
  expiresAt: 0,
  total: 0,
  completed: 0,
  pending: 0,
  scheduled: 0,
  slots: 0,
});

describe("safeFetch redirect handling", () => {
  const credentials = { authorization: "Bearer x", cookie: "c=1", "x-keep": "1" };

  test("cross-origin redirect drops authorization, cookie and proxy-authorization but keeps other headers", async () => {
    await safeFetch(`${front.origin}/cross`, {
      allowPrivateNetwork: true,
      timeout: 5_000,
      userAgent: "test",
      headers: { ...credentials, "proxy-authorization": "p" },
    });
    expect(front.hits[0]?.headers.authorization).toBe("Bearer x");
    const landed = target.hits.at(-1);
    expect(landed?.path).toBe("/landing");
    expect(landed?.headers.authorization).toBeUndefined();
    expect(landed?.headers.cookie).toBeUndefined();
    expect(landed?.headers["proxy-authorization"]).toBeUndefined();
    expect(landed?.headers["x-keep"]).toBe("1");
  });

  test("same-origin redirect keeps authorization and cookie", async () => {
    await safeFetch(`${front.origin}/same`, {
      allowPrivateNetwork: true,
      timeout: 5_000,
      userAgent: "test",
      headers: credentials,
    });
    const landed = front.hits.at(-1);
    expect(landed?.path).toBe("/landing");
    expect(landed?.headers.authorization).toBe("Bearer x");
    expect(landed?.headers.cookie).toBe("c=1");
  });

  test("303 turns a POST into a bodiless GET on the next hop", async () => {
    await safeFetch(`${front.origin}/post-303`, {
      allowPrivateNetwork: true,
      timeout: 5_000,
      userAgent: "test",
      method: "POST",
      body: "payload",
    });
    const landed = target.hits.at(-1);
    expect(landed?.method).toBe("GET");
    expect(landed?.body).toBe("");
  });

  test("307 keeps the POST method and body on the next hop", async () => {
    await safeFetch(`${front.origin}/post-307`, {
      allowPrivateNetwork: true,
      timeout: 5_000,
      userAgent: "test",
      method: "POST",
      body: "payload",
    });
    const landed = target.hits.at(-1);
    expect(landed?.method).toBe("POST");
    expect(landed?.body).toBe("payload");
  });
});

describe("webhook delivery", () => {
  test("a redirect into a private address is refused on the second hop", async () => {
    const redirect = Object.assign(
      async () => new Response(null, { status: 307, headers: { location: "http://169.254.169.254/latest" } }),
      { preconnect: () => {} },
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(redirect);
    try {
      sendWebhook(config(false), job("http://93.184.216.34/hook"), "completed");
      await Bun.sleep(50);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("payload for a plain string webhook URL is unchanged", async () => {
    sendWebhook(config(true), job(`${target.origin}/hook`), "completed");
    const hit = await waitFor(() => target.hits[0]);
    expect(hit.method).toBe("POST");
    expect(hit.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(hit.body)).toEqual({ success: true, type: "crawl.completed", id: "job-1", data: [], metadata: {} });
  });
});
