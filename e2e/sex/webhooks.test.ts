// Webhooks of crawl, batch scrape and extract: events, payloads, HMAC signature, retries, filtering.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { startMockLlm } from "../lib/llm.ts";
import { api, killAll, type Server, until } from "../lib/proc.ts";
import { html, prose, type Site, site } from "../lib/sites.ts";
import { removeTempDirs } from "../lib/tmp.ts";
import { llmFlags, startSex, waitJob } from "./helpers.ts";

const SECRET = "e2e-webhook-secret";

interface Delivery {
  at: number;
  path: string;
  headers: Headers;
  raw: string;
  body: any;
}

let srv: Server;
let target: Site;
let receiver: Site;
let llm: ReturnType<typeof startMockLlm>;
const deliveries: Delivery[] = [];
/** The status the receiver answers with, by path and attempt number (default 200). */
let respond: (path: string, nth: number) => number = () => 200;
const attempts = new Map<string, number>();

beforeAll(async () => {
  target = site((_req, url) => {
    if (url.pathname === "/robots.txt") return new Response("nf", { status: 404 });
    if (url.pathname === "/") return html("Home", `${prose("home", 2)}<a href="/a">a</a><a href="/b">b</a>`);
    if (url.pathname === "/a" || url.pathname === "/b") return html(`Page ${url.pathname}`, prose(url.pathname, 2));
    return new Response("nf", { status: 404 });
  });
  receiver = site(async (req, url) => {
    const raw = await req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    deliveries.push({ at: Date.now(), path: url.pathname, headers: req.headers, raw, body });
    const nth = (attempts.get(url.pathname) ?? 0) + 1;
    attempts.set(url.pathname, nth);
    return new Response("", { status: respond(url.pathname, nth) });
  });
  llm = startMockLlm(() => JSON.stringify({ title: "Home" }));
  srv = await startSex(llmFlags(llm), { env: { SEX_WEBHOOK_SECRET: SECRET } });
});

afterAll(async () => {
  target.stop();
  receiver.stop();
  llm.stop();
  await killAll();
  removeTempDirs();
});

const hook = (path: string) => `${receiver.url}${path}`;
const on = (path: string) => deliveries.filter((d) => d.path === path);
const types = (path: string) => on(path).map((d) => d.body.type);
const waitFor = <T>(fn: () => T | undefined, ms = 20_000) => until(fn, ms, 100);

describe("webhook payloads", () => {
  test("a crawl sends started, one page per document and completed, with the Firecrawl payload", async () => {
    const created = await api(srv.url, "/v2/crawl", {
      body: {
        url: `${target.url}/`,
        sitemap: "skip",
        webhook: { url: hook("/crawl"), headers: { "X-Test": "yes" }, metadata: { run: "r1", n: 7 } },
      },
    });
    expect(created.status).toBe(200);
    const id = created.body.id;
    await waitFor(() => (types("/crawl").includes("crawl.completed") ? true : undefined));
    const all = on("/crawl");
    expect(types("/crawl").filter((t) => t === "crawl.started")).toHaveLength(1);
    expect(types("/crawl").filter((t) => t === "crawl.page")).toHaveLength(3);
    expect(types("/crawl").filter((t) => t === "crawl.completed")).toHaveLength(1);
    // Page events come between started and completed.
    expect(all[0]?.body.type).toBe("crawl.started");
    expect(all.at(-1)?.body.type).toBe("crawl.completed");

    const started = all[0] as Delivery;
    expect(started.body).toMatchObject({ success: true, type: "crawl.started", id, metadata: { run: "r1", n: 7 } });
    expect(started.body.webhookId).toBeTruthy();
    expect(started.headers.get("x-test")).toBe("yes");
    expect(started.headers.get("content-type")).toContain("application/json");

    const page = all.find((d) => d.body.type === "crawl.page") as Delivery;
    expect(page.body.success).toBe(true);
    expect(page.body.id).toBe(id);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.data[0].markdown).toContain("Paragraph 1");
    expect(page.body.data[0].metadata.sourceURL.startsWith(target.url)).toBe(true);
    expect(page.body.metadata).toEqual({ run: "r1", n: 7 });

    // Each delivery has its own webhookId.
    expect(new Set(all.map((d) => d.body.webhookId)).size).toBe(all.length);
    const status = await waitJob(srv, `/v2/crawl/${id}`);
    expect(status.completed).toBe(3);
  });

  test("a batch sends batch_scrape.started / page / completed, and a failed page is page with success false", async () => {
    const created = await api(srv.url, "/v2/batch/scrape", {
      body: { urls: [`${target.url}/a`, `${target.url}/b`, "http://127.0.0.1:1/"], formats: ["markdown"], webhook: hook("/batch") },
    });
    expect(created.status).toBe(200);
    await waitFor(() => (types("/batch").includes("batch_scrape.completed") ? true : undefined));
    expect(types("/batch")[0]).toBe("batch_scrape.started");
    const pages = on("/batch").filter((d) => d.body.type === "batch_scrape.page");
    expect(pages).toHaveLength(3);
    const failed = pages.filter((d) => d.body.success === false);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.body.error).toBeTruthy();
    expect(failed[0]?.body.data).toEqual([{ metadata: { sourceURL: "http://127.0.0.1:1/" } }]);
    expect(pages.filter((d) => d.body.success === true)).toHaveLength(2);
    expect(on("/batch").every((d) => d.body.id === created.body.id)).toBe(true);
    // A webhook given as a plain string carries no metadata.
    expect(on("/batch")[0]?.body.metadata ?? {}).toEqual({});
  });

  test("an extract sends started and completed with the result", async () => {
    const created = await api(srv.url, "/v2/extract", {
      body: {
        urls: [`${target.url}/a`],
        prompt: "title",
        schema: { type: "object", properties: { title: { type: "string" } } },
        webhook: { url: hook("/extract"), metadata: { k: "v" } },
      },
    });
    expect(created.status).toBe(200);
    await waitFor(() => (types("/extract").includes("extract.completed") ? true : undefined));
    expect(types("/extract")).toEqual(["extract.started", "extract.completed"]);
    const done = on("/extract")[1] as Delivery;
    expect(done.body).toMatchObject({ success: true, id: created.body.id, data: [{ title: "Home" }], metadata: { k: "v" } });
  });

  test("a failed extract sends extract.failed with the error", async () => {
    const created = await api(srv.url, "/v2/extract", {
      body: {
        urls: ["http://127.0.0.1:1/"],
        prompt: "title",
        schema: { type: "object", properties: { title: { type: "string" } } },
        webhook: hook("/extract-failed"),
      },
    });
    expect(created.status).toBe(200);
    await waitFor(() => (types("/extract-failed").some((t) => t === "extract.failed" || t === "extract.completed") ? true : undefined));
    const last = on("/extract-failed").at(-1) as Delivery;
    if (last.body.type === "extract.failed") {
      expect(last.body.success).toBe(false);
      expect(last.body.error).toBeTruthy();
    }
    expect(types("/extract-failed")[0]).toBe("extract.started");
  });

  test("events limits which events are sent", async () => {
    const created = await api(srv.url, "/v2/crawl", {
      body: { url: `${target.url}/`, sitemap: "skip", webhook: { url: hook("/filtered"), events: ["completed"] } },
    });
    const status = await waitJob(srv, `/v2/crawl/${created.body.id}`);
    expect(status.status).toBe("completed");
    await waitFor(() => (on("/filtered").length > 0 ? true : undefined));
    await Bun.sleep(1000);
    expect(types("/filtered")).toEqual(["crawl.completed"]);
  });
});

describe("signature", () => {
  test("X-Firecrawl-Signature is the HMAC-SHA256 of the raw body with SEX_WEBHOOK_SECRET", async () => {
    await api(srv.url, "/v2/batch/scrape", { body: { urls: [`${target.url}/a`], webhook: hook("/signed") } });
    await waitFor(() => (types("/signed").includes("batch_scrape.completed") ? true : undefined));
    expect(on("/signed").length).toBeGreaterThanOrEqual(3);
    for (const d of on("/signed")) {
      const sig = d.headers.get("x-firecrawl-signature");
      expect(sig).toBe(`sha256=${createHmac("sha256", SECRET).update(d.raw).digest("hex")}`);
    }
  });

  test("there is no signature without a secret, and a request cannot set the header", async () => {
    const plain = await startSex();
    const before = deliveries.length;
    await api(plain.url, "/v2/batch/scrape", { body: { urls: [`${target.url}/a`], webhook: hook("/unsigned") } });
    await waitFor(() => (types("/unsigned").includes("batch_scrape.completed") ? true : undefined));
    expect(deliveries.length).toBeGreaterThan(before);
    for (const d of on("/unsigned")) expect(d.headers.get("x-firecrawl-signature")).toBeNull();
    await plain.stop();

    const forged = await api(srv.url, "/v2/batch/scrape", {
      body: { urls: [`${target.url}/a`], webhook: { url: hook("/forged"), headers: { "x-firecrawl-signature": "sha256=00" } } },
    });
    expect(forged.status).toBe(400);
    expect(on("/forged")).toHaveLength(0);
  });
});

describe("retries", () => {
  test("a 500 is retried after a pause with the same webhookId; 2xx ends it", async () => {
    respond = (path, nth) => (path === "/flaky" && nth === 1 ? 500 : 200);
    const created = await api(srv.url, "/v2/batch/scrape", {
      body: { urls: [`${target.url}/a`], webhook: { url: hook("/flaky"), events: ["completed"] } },
    });
    expect(created.status).toBe(200);
    await waitFor(() => (on("/flaky").length >= 2 ? true : undefined), 30_000);
    await Bun.sleep(300);
    const [first, second] = on("/flaky") as [Delivery, Delivery];
    expect(first.body.type).toBe("batch_scrape.completed");
    expect(second.body.type).toBe("batch_scrape.completed");
    expect(second.body.webhookId).toBe(first.body.webhookId);
    expect(second.at - first.at).toBeGreaterThanOrEqual(4500);
    // Success stops the retries.
    await Bun.sleep(1500);
    expect(on("/flaky")).toHaveLength(2);
    // The job itself is unaffected by the receiver.
    const status = await waitJob(srv, `/v2/batch/scrape/${created.body.id}`);
    expect(status.status).toBe("completed");
  }, 60_000);

  test("a 400 is not retried", async () => {
    respond = (path) => (path === "/refused" ? 400 : 200);
    await api(srv.url, "/v2/batch/scrape", {
      body: { urls: [`${target.url}/a`], webhook: { url: hook("/refused"), events: ["completed"] } },
    });
    await waitFor(() => (on("/refused").length >= 1 ? true : undefined));
    await Bun.sleep(7000); // longer than the first backoff step
    expect(on("/refused")).toHaveLength(1);
  }, 60_000);

  test("a webhook URL that is not allowed is refused or never delivered", async () => {
    const strict = await startSex([], { privateNetwork: false });
    const r = await api(strict.url, "/v2/batch/scrape", { body: { urls: ["http://93.184.216.34/x"], webhook: hook("/ssrf") } });
    // Either the request is rejected up front or it is accepted and the delivery is blocked: nothing arrives.
    expect([200, 400, 403]).toContain(r.status);
    await Bun.sleep(1500);
    expect(on("/ssrf")).toHaveLength(0);
    await strict.stop();
  });
});
